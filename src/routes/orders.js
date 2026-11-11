import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { newToken, newOrderNumber, sha256, safeEqual } from '../lib/security.js';
import { publish, openStream } from '../lib/events.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const ORDER_INCLUDE = {
  items: { include: { addons: true } },
  statusEvents: { orderBy: { createdAt: 'asc' } },
};

const itemSchema = z.object({
  productId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(20),
  addonIds: z.array(z.string().min(1).max(64)).max(20).default([]),
  notes: z.string().trim().max(200).optional(),
});

const createSchema = z
  .object({
    customer: z.object({
      name: z.string().trim().min(2).max(120),
      phone: z.string().trim().min(10).max(30),
    }),
    type: z.enum(['DELIVERY', 'PICKUP']),
    address: z
      .object({
        zip: z.string().trim().max(9),
        street: z.string().trim().max(160),
        number: z.string().trim().max(20),
        neighborhood: z.string().trim().max(100),
        city: z.string().trim().max(100),
        complement: z.string().trim().max(100).optional(),
        reference: z.string().trim().max(160).optional(),
      })
      .optional(),
    payment: z.enum(['PIX', 'CREDIT_CARD', 'DEBIT_CARD', 'CASH']),
    changeForCents: z.number().int().positive().optional(),
    couponCode: z.string().trim().max(40).optional(),
    notes: z.string().trim().max(300).optional(),
    items: z.array(itemSchema).min(1).max(50),
  })
  .superRefine((d, ctx) => {
    if (d.type === 'DELIVERY' && !d.address) {
      ctx.addIssue({ code: 'custom', path: ['address'], message: 'Endereço obrigatório para delivery' });
    }
  });

// Formato público do pedido: nunca inclui token, e-mail ou dados internos.
function serialize(o) {
  return {
    number: o.number,
    status: o.status,
    type: o.type,
    paymentMethod: o.paymentMethod,
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    deliveryFeeCents: o.deliveryFeeCents,
    totalCents: o.totalCents,
    createdAt: o.createdAt,
    address:
      o.type === 'DELIVERY'
        ? { zip: o.addressZip, street: o.addressStreet, number: o.addressNumber, neighborhood: o.addressNeighborhood, city: o.addressCity }
        : null,
    items: o.items.map((i) => ({
      name: i.productName,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      notes: i.notes,
      addons: i.addons.map((a) => a.name),
    })),
    timeline: o.statusEvents.map((e) => ({ status: e.status, at: e.createdAt })),
  };
}

// Cria o pedido. Preços e disponibilidade são sempre calculados no servidor a partir do banco.
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.flatten() });
  const d = parsed.data;

  const settings = await prisma.restaurantSettings.findUnique({ where: { id: 'default' } });
  if (!settings || !settings.acceptingOrders) {
    return res.status(503).json({ error: 'Pedidos online temporariamente indisponíveis' });
  }

  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(d.items.map((i) => i.productId))] } },
    include: { addons: { where: { active: true } } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  let subtotal = 0;
  const lines = [];
  for (const it of d.items) {
    const p = byId.get(it.productId);
    if (!p) return res.status(400).json({ error: 'Produto não encontrado' });
    if (!p.available) return res.status(409).json({ error: `${p.name} está indisponível no momento` });
    const addons = [];
    for (const aid of new Set(it.addonIds)) {
      const a = p.addons.find((x) => x.id === aid);
      if (!a) return res.status(400).json({ error: `Adicional inválido para ${p.name}` });
      addons.push(a);
    }
    const unit = p.priceCents + addons.reduce((s, a) => s + a.priceCents, 0);
    subtotal += unit * it.quantity;
    lines.push({
      productId: p.id,
      unitCostCents: p.costCents,
      productName: p.name,
      unitPriceCents: unit,
      quantity: it.quantity,
      notes: it.notes || null,
      addons: addons.map((a) => ({ name: a.name, priceCents: a.priceCents })),
    });
  }

  if (subtotal < settings.minOrderCents) {
    return res.status(400).json({ error: 'Pedido abaixo do valor mínimo' });
  }

  let discountCents = 0;
  let couponCode = null;
  if (d.couponCode) {
    const c = await prisma.coupon.findUnique({ where: { code: d.couponCode.toUpperCase() } });
    const valid =
      c &&
      c.active &&
      (!c.expiresAt || c.expiresAt > new Date()) &&
      (c.maxUses === null || c.usedCount < c.maxUses) &&
      subtotal >= c.minSubtotalCents;
    if (!valid) return res.status(400).json({ error: 'Cupom inválido ou não aplicável' });
    discountCents = c.percentOff ? Math.round((subtotal * c.percentOff) / 100) : Math.min(c.amountOffCents || 0, subtotal);
    couponCode = c.code;
  }

  const deliveryFeeCents = d.type === 'DELIVERY' ? settings.deliveryFeeCents : 0;
  const totalCents = subtotal - discountCents + deliveryFeeCents;

  if (d.payment === 'CASH' && d.changeForCents !== undefined && d.changeForCents < totalCents) {
    return res.status(400).json({ error: 'O valor para troco precisa ser maior que o total' });
  }

  const number = newOrderNumber();
  const trackToken = newToken();
  const a = d.address ?? {};
  const isDelivery = d.type === 'DELIVERY';

  const order = await prisma.$transaction(async (tx) => {
    if (couponCode) await tx.coupon.update({ where: { code: couponCode }, data: { usedCount: { increment: 1 } } });
    return tx.order.create({
      data: {
        number,
        trackTokenHash: sha256(trackToken),
        userId: req.user?.id ?? null,
        customerName: d.customer.name,
        customerPhone: d.customer.phone,
        type: d.type,
        addressZip: isDelivery ? a.zip : null,
        addressStreet: isDelivery ? a.street : null,
        addressNumber: isDelivery ? a.number : null,
        addressNeighborhood: isDelivery ? a.neighborhood : null,
        addressCity: isDelivery ? a.city : null,
        addressComplement: isDelivery ? a.complement ?? null : null,
        addressReference: isDelivery ? a.reference ?? null : null,
        paymentMethod: d.payment,
        changeForCents: d.payment === 'CASH' ? d.changeForCents ?? null : null,
        subtotalCents: subtotal,
        discountCents,
        deliveryFeeCents,
        totalCents,
        couponCode,
        notes: d.notes || null,
        status: 'RECEIVED',
        items: {
          create: lines.map((l) => ({
            productId: l.productId,
            productName: l.productName,
            unitPriceCents: l.unitPriceCents,
            unitCostCents: l.unitCostCents,
            quantity: l.quantity,
            notes: l.notes,
            addons: { create: l.addons },
          })),
        },
        statusEvents: { create: { status: 'RECEIVED' } },
        // Pagamento ainda sem gateway: fica PENDING e nenhuma cobrança é feita.
        payments: { create: { provider: 'DEMO', status: 'PENDING', amountCents: totalCents } },
      },
    });
  });

  publish('admin', 'order', { number, status: 'RECEIVED', totalCents, type: d.type });
  res.status(201).json({ order: { number, status: order.status, totalCents, trackToken } });
});

// Pedidos do cliente logado (somente os próprios).
router.get('/mine', requireAuth, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: ORDER_INCLUDE,
  });
  res.json({ orders: orders.map(serialize) });
});

async function findTracked(number, token) {
  if (typeof token !== 'string' || !token || token.length > 100) return null;
  const order = await prisma.order.findUnique({ where: { number }, include: ORDER_INCLUDE });
  if (!order || !safeEqual(order.trackTokenHash, sha256(token))) return null;
  return order;
}

// Acompanhamento: exige o token entregue na criação do pedido.
router.get('/:number/track', async (req, res) => {
  const order = await findTracked(req.params.number, req.header('x-track-token'));
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  res.json({ order: serialize(order) });
});

// Tempo real: SSE com o mesmo token (EventSource não envia cabeçalhos, por isso query string).
router.get('/:number/stream', async (req, res) => {
  const order = await findTracked(req.params.number, req.query.token);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  openStream(req, res, `order:${order.number}`, { status: order.status });
});

export { serialize };
export default router;
