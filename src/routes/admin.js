import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { publish, openStream } from '../lib/events.js';
import { requireRole } from '../middleware/auth.js';
import { serialize } from './orders.js';

const router = Router();
const STATUSES = ['RECEIVED', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'];
const ACTIVE = ['RECEIVED', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'];

const TRANSITIONS = {
  RECEIVED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  PICKED_UP: [],
  CANCELLED: [],
};

// Regras de fluxo: impede pular etapas ou usar um status que não existe no tipo de pedido.
function canTransition(order, to) {
  if (!TRANSITIONS[order.status]?.includes(to)) return false;
  if (order.type === 'PICKUP' && (to === 'OUT_FOR_DELIVERY' || to === 'DELIVERED')) return false;
  if (order.type === 'DELIVERY' && (to === 'PICKED_UP' || (to === 'DELIVERED' && order.status === 'READY'))) return false;
  return true;
}

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const sum = (arr) => arr.reduce((s, n) => s + n, 0);

// Painel: pedidos (com busca e filtros). Equipe (STAFF) e acima.
router.get('/orders', requireRole('STAFF'), async (req, res) => {
  const { status, q, from, to } = req.query;
  const where = {};
  if (typeof status === 'string' && STATUSES.includes(status)) where.status = status;
  if (typeof q === 'string' && q.trim()) {
    const term = q.trim().slice(0, 80);
    where.OR = [
      { number: { contains: term, mode: 'insensitive' } },
      { customerName: { contains: term, mode: 'insensitive' } },
      { customerPhone: { contains: term } },
    ];
  }
  const range = {};
  if (typeof from === 'string' && !isNaN(Date.parse(from))) range.gte = new Date(from);
  if (typeof to === 'string' && !isNaN(Date.parse(to))) range.lte = new Date(to);
  if (Object.keys(range).length) where.createdAt = range;

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { ...ORDER_INCLUDE_ADMIN },
  });
  res.json({
    orders: orders.map((o) => ({
      ...serialize(o),
      customer: { name: o.customerName, phone: o.customerPhone },
      paymentStatus: o.payments?.[0]?.status ?? null,
      cancelReason: o.cancelReason,
    })),
  });
});
const ORDER_INCLUDE_ADMIN = {
  items: { include: { addons: true } },
  statusEvents: { orderBy: { createdAt: 'asc' } },
  payments: true,
};

const statusSchema = z.object({
  status: z.enum(STATUSES),
  reason: z.string().trim().min(3).max(300).optional(),
});

// Atualiza o status. Usa updateMany com o status atual para evitar conflito entre dois atendentes.
router.patch('/orders/:number/status', requireRole('STAFF'), async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Status inválido' });
  const { status, reason } = parsed.data;
  if (status === 'CANCELLED' && !reason) return res.status(400).json({ error: 'Informe a justificativa do cancelamento' });

  const order = await prisma.order.findUnique({ where: { number: req.params.number } });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (!canTransition(order, status)) {
    return res.status(409).json({ error: `Não é possível mudar de ${order.status} para ${status} neste tipo de pedido` });
  }

  await prisma.$transaction(async (tx) => {
    const r = await tx.order.updateMany({
      where: { id: order.id, status: order.status },
      data: { status, ...(status === 'CANCELLED' ? { cancelReason: reason } : {}) },
    });
    if (r.count !== 1) {
      const err = new Error('Este pedido foi alterado por outra pessoa. Atualize a tela.');
      err.status = 409;
      throw err;
    }
    await tx.statusEvent.create({ data: { orderId: order.id, status, actorId: req.user.id } });
    await tx.activityLog.create({
      data: {
        userId: req.user.id,
        action: 'order.status',
        entity: 'order',
        entityId: order.id,
        meta: { from: order.status, to: status, reason: reason ?? null },
      },
    });
  });

  publish(`order:${order.number}`, 'status', { status, at: new Date() });
  publish('admin', 'order', { number: order.number, status });
  res.json({ ok: true, number: order.number, status });
});

// Tempo real para o painel.
router.get('/stream', requireRole('STAFF'), (req, res) => openStream(req, res, 'admin'));

// Dashboard: números reais do banco, sem valores fixos. Gerente ou acima.
router.get('/dashboard', requireRole('MANAGER'), async (req, res) => {
  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * 864e5);
  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: since30 } },
    select: { createdAt: true, status: true, totalCents: true, items: { select: { productName: true, quantity: true, unitPriceCents: true } } },
  });
  const valid = orders.filter((o) => o.status !== 'CANCELLED');
  const period = (from) => {
    const list = valid.filter((o) => o.createdAt >= from);
    const revenue = sum(list.map((o) => o.totalCents));
    return { revenueCents: revenue, orders: list.length, avgTicketCents: list.length ? Math.round(revenue / list.length) : 0 };
  };

  const tz = process.env.TZ || 'America/Sao_Paulo';
  const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: tz });
  const daily = {};
  for (let i = 13; i >= 0; i--) daily[dayKey(new Date(now.getTime() - i * 864e5))] = 0;
  for (const o of valid) {
    const k = dayKey(o.createdAt);
    if (k in daily) daily[k] += o.totalCents;
  }

  const products = new Map();
  for (const o of valid) {
    for (const i of o.items) {
      const p = products.get(i.productName) ?? { name: i.productName, quantity: 0, revenueCents: 0 };
      p.quantity += i.quantity;
      p.revenueCents += i.unitPriceCents * i.quantity;
      products.set(i.productName, p);
    }
  }
  const list = [...products.values()];

  const [activeOrders, completedToday] = await Promise.all([
    prisma.order.count({ where: { status: { in: ACTIVE } } }),
    prisma.order.count({ where: { status: { in: ['DELIVERED', 'PICKED_UP'] }, updatedAt: { gte: startOfDay(now) } } }),
  ]);

  res.json({
    today: period(startOfDay(now)),
    week: period(new Date(now.getTime() - 7 * 864e5)),
    month: period(since30),
    activeOrders,
    completedToday,
    daily: Object.entries(daily).map(([day, revenueCents]) => ({ day, revenueCents })),
    topByQuantity: [...list].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
    topByRevenue: [...list].sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 10),
  });
});

// Clientes: sem senha e sem dados de outros tipos de conta. Gerente ou acima.
router.get('/customers', requireRole('MANAGER'), async (req, res) => {
  const users = await prisma.user.findMany({
    where: { role: 'CUSTOMER' },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, name: true, email: true, phone: true, createdAt: true, orders: { select: { totalCents: true, status: true } } },
  });
  res.json({
    customers: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      createdAt: u.createdAt,
      ordersCount: u.orders.length,
      totalSpentCents: sum(u.orders.filter((o) => o.status !== 'CANCELLED').map((o) => o.totalCents)),
    })),
  });
});

const productSchema = z.object({
  available: z.boolean().optional(),
  featured: z.boolean().optional(),
  priceCents: z.number().int().min(0).max(10000000).optional(),
  costCents: z.number().int().min(0).max(10000000).optional(),
});

router.patch('/products/:id', requireRole('MANAGER'), async (req, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success || !Object.keys(parsed.data).length) return res.status(400).json({ error: 'Dados inválidos' });
  const r = await prisma.product.updateMany({ where: { id: req.params.id }, data: parsed.data });
  if (!r.count) return res.status(404).json({ error: 'Produto não encontrado' });
  await prisma.activityLog.create({
    data: { userId: req.user.id, action: 'product.update', entity: 'product', entityId: req.params.id, meta: parsed.data },
  });
  res.json({ ok: true });
});

const settingsSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  whatsapp: z.string().trim().max(30).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  hours: z.string().trim().max(300).nullable().optional(),
  deliveryFeeCents: z.number().int().min(0).max(100000).optional(),
  minOrderCents: z.number().int().min(0).max(1000000).optional(),
  acceptingOrders: z.boolean().optional(),
});

// Configurações: somente o proprietário altera.
router.get('/settings', requireRole('MANAGER'), async (req, res) => {
  res.json({ settings: await prisma.restaurantSettings.findUnique({ where: { id: 'default' } }) });
});

router.patch('/settings', requireRole('OWNER'), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.flatten().fieldErrors });
  const settings = await prisma.restaurantSettings.upsert({
    where: { id: 'default' },
    update: parsed.data,
    create: { id: 'default', ...parsed.data },
  });
  await prisma.activityLog.create({ data: { userId: req.user.id, action: 'settings.update', entity: 'settings', meta: parsed.data } });
  res.json({ settings });
});

// Exportação de vendas em CSV (Excel em português: ponto e vírgula e vírgula decimal).
router.get('/reports/sales.csv', requireRole('MANAGER'), async (req, res) => {
  const from = Date.parse(req.query.from);
  const to = Date.parse(req.query.to);
  const where = { status: { not: 'CANCELLED' } };
  if (!isNaN(from) || !isNaN(to)) {
    where.createdAt = {};
    if (!isNaN(from)) where.createdAt.gte = new Date(from);
    if (!isNaN(to)) where.createdAt.lte = new Date(to);
  }
  const orders = await prisma.order.findMany({ where, orderBy: { createdAt: 'asc' }, take: 5000, include: { items: true } });
  const money = (c) => (c / 100).toFixed(2).replace('.', ',');
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Pedido', 'Data', 'Tipo', 'Pagamento', 'Subtotal', 'Desconto', 'Taxa de entrega', 'Total', 'Itens']];
  for (const o of orders) {
    rows.push([
      o.number,
      o.createdAt.toLocaleString('pt-BR', { timeZone: process.env.TZ || 'America/Sao_Paulo' }),
      o.type,
      o.paymentMethod,
      money(o.subtotalCents),
      money(o.discountCents),
      money(o.deliveryFeeCents),
      money(o.totalCents),
      o.items.map((i) => `${i.quantity}x ${i.productName}`).join('; '),
    ]);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="vendas.csv"');
  res.send('\uFEFF' + rows.map((r) => r.map(cell).join(';')).join('\r\n'));
});

// Cupons (gerente ou acima). Cupons não são apagados, apenas desativados, para manter o histórico.
const couponSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,30}$/, 'Use de 3 a 30 letras e números no código'),
    percentOff: z.number().int().min(1).max(100).nullable().optional(),
    amountOffCents: z.number().int().min(1).max(1000000).nullable().optional(),
    minSubtotalCents: z.number().int().min(0).max(10000000).default(0),
    maxUses: z.number().int().min(1).nullable().optional(),
    expiresAt: z.string().refine((v) => !isNaN(Date.parse(v)), 'Data de validade inválida').nullable().optional(),
    active: z.boolean().default(true),
  })
  .refine((d) => Boolean(d.percentOff) !== Boolean(d.amountOffCents), {
    message: 'Informe porcentagem OU valor fixo, não os dois',
  });

router.get('/coupons', requireRole('MANAGER'), async (req, res) => {
  res.json({ coupons: await prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } }) });
});

router.post('/coupons', requireRole('MANAGER'), async (req, res) => {
  const p = couponSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0].message });
  const d = p.data;
  try {
    const coupon = await prisma.coupon.create({
      data: {
        code: d.code,
        percentOff: d.percentOff ?? null,
        amountOffCents: d.amountOffCents ?? null,
        minSubtotalCents: d.minSubtotalCents,
        maxUses: d.maxUses ?? null,
        expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
        active: d.active,
      },
    });
    await prisma.activityLog.create({ data: { userId: req.user.id, action: 'coupon.create', entity: 'coupon', entityId: coupon.id, meta: { code: d.code } } });
    res.status(201).json({ coupon });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Já existe um cupom com este código' });
    throw err;
  }
});

const couponUpdateSchema = z.object({
  active: z.boolean().optional(),
  maxUses: z.number().int().min(1).nullable().optional(),
  expiresAt: z.string().refine((v) => !isNaN(Date.parse(v)), 'Data inválida').nullable().optional(),
});

router.patch('/coupons/:id', requireRole('MANAGER'), async (req, res) => {
  const p = couponUpdateSchema.safeParse(req.body);
  if (!p.success || !Object.keys(p.data).length) return res.status(400).json({ error: 'Dados inválidos' });
  const data = { ...p.data };
  if ('expiresAt' in data) data.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  const r = await prisma.coupon.updateMany({ where: { id: req.params.id }, data });
  if (!r.count) return res.status(404).json({ error: 'Cupom não encontrado' });
  await prisma.activityLog.create({ data: { userId: req.user.id, action: 'coupon.update', entity: 'coupon', entityId: req.params.id, meta: p.data } });
  res.json({ ok: true });
});

router.delete('/coupons/:id', requireRole('MANAGER'), async (req, res) => {
  const r = await prisma.coupon.deleteMany({ where: { id: req.params.id } });
  if (!r.count) return res.status(404).json({ error: 'Cupom não encontrado' });
  await prisma.activityLog.create({ data: { userId: req.user.id, action: 'coupon.delete', entity: 'coupon', entityId: req.params.id } });
  res.json({ ok: true });
});

// Produtos com custo (gerente ou acima).
router.get('/products', requireRole('MANAGER'), async (req, res) => {
  const products = await prisma.product.findMany({
    orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
    include: { category: { select: { name: true } } },
  });
  res.json({
    products: products.map((p) => ({
      id: p.id, name: p.name, category: p.category.name,
      priceCents: p.priceCents, costCents: p.costCents, available: p.available,
    })),
  });
});

// Promoções: ofertas do dia, combos e destaques.
const PROMO_FIELDS = z.object({
  kind: z.enum(['DAILY_OFFER', 'COMBO', 'HIGHLIGHT']),
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  priceCents: z.number().int().min(0).max(10000000).nullable().optional(),
  productId: z.string().min(1).max(64).nullable().optional(),
  active: z.boolean().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});
const toDate = (v) => (v ? new Date(v) : null);

async function checkProduct(productId) {
  if (!productId) return true;
  return !!(await prisma.product.findUnique({ where: { id: productId }, select: { id: true } }));
}

router.get('/promotions', requireRole('MANAGER'), async (req, res) => {
  const promotions = await prisma.promotion.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    include: { product: { select: { name: true } } },
  });
  res.json({ promotions });
});

router.post('/promotions', requireRole('MANAGER'), async (req, res) => {
  const p = PROMO_FIELDS.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0].message });
  const d = p.data;
  if (!(await checkProduct(d.productId))) return res.status(400).json({ error: 'Produto relacionado não encontrado' });
  const promo = await prisma.promotion.create({
    data: {
      kind: d.kind, title: d.title, description: d.description ?? null, priceCents: d.priceCents ?? null,
      productId: d.productId ?? null, active: d.active ?? true, startsAt: toDate(d.startsAt), endsAt: toDate(d.endsAt),
      sortOrder: d.sortOrder ?? 0,
    },
  });
  await prisma.activityLog.create({ data: { userId: req.user.id, action: 'promotion.create', entity: 'promotion', entityId: promo.id, meta: { title: d.title } } });
  res.status(201).json({ promotion: promo });
});

router.patch('/promotions/:id', requireRole('MANAGER'), async (req, res) => {
  const p = PROMO_FIELDS.partial().safeParse(req.body);
  if (!p.success || !Object.keys(p.data).length) return res.status(400).json({ error: 'Dados inválidos' });
  const d = { ...p.data };
  if (!(await checkProduct(d.productId))) return res.status(400).json({ error: 'Produto relacionado não encontrado' });
  if ('startsAt' in d) d.startsAt = toDate(d.startsAt);
  if ('endsAt' in d) d.endsAt = toDate(d.endsAt);
  const r = await prisma.promotion.updateMany({ where: { id: req.params.id }, data: d });
  if (!r.count) return res.status(404).json({ error: 'Promoção não encontrada' });
  res.json({ ok: true });
});

router.delete('/promotions/:id', requireRole('MANAGER'), async (req, res) => {
  const r = await prisma.promotion.deleteMany({ where: { id: req.params.id } });
  if (!r.count) return res.status(404).json({ error: 'Promoção não encontrada' });
  res.json({ ok: true });
});

// Despesas operacionais (usadas no cálculo de lucro estimado).
const expenseSchema = z.object({
  description: z.string().trim().min(2).max(160),
  category: z.string().trim().min(2).max(60),
  amountCents: z.number().int().min(1).max(100000000),
  occurredAt: z.string().datetime(),
});

router.get('/expenses', requireRole('MANAGER'), async (req, res) => {
  res.json({ expenses: await prisma.expense.findMany({ orderBy: { occurredAt: 'desc' }, take: 300 }) });
});

router.post('/expenses', requireRole('MANAGER'), async (req, res) => {
  const p = expenseSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0].message });
  const expense = await prisma.expense.create({ data: { ...p.data, occurredAt: new Date(p.data.occurredAt) } });
  await prisma.activityLog.create({ data: { userId: req.user.id, action: 'expense.create', entity: 'expense', entityId: expense.id, meta: { amountCents: expense.amountCents } } });
  res.status(201).json({ expense });
});

router.delete('/expenses/:id', requireRole('MANAGER'), async (req, res) => {
  const r = await prisma.expense.deleteMany({ where: { id: req.params.id } });
  if (!r.count) return res.status(404).json({ error: 'Despesa não encontrada' });
  await prisma.activityLog.create({ data: { userId: req.user.id, action: 'expense.delete', entity: 'expense', entityId: req.params.id } });
  res.json({ ok: true });
});

// Lucro estimado: faturamento - custo dos produtos vendidos - despesas do período.
const dateRange = (q) => {
  const r = {};
  const f = Date.parse(q.from), t = Date.parse(q.to);
  if (!isNaN(f)) r.gte = new Date(f);
  if (!isNaN(t)) r.lte = new Date(t);
  return Object.keys(r).length ? r : undefined;
};

router.get('/reports/profit', requireRole('MANAGER'), async (req, res) => {
  const range = dateRange(req.query);
  const orders = await prisma.order.findMany({
    where: range ? { createdAt: range } : {},
    select: {
      status: true, totalCents: true, subtotalCents: true, discountCents: true, deliveryFeeCents: true,
      items: { select: { quantity: true, unitCostCents: true } },
    },
    take: 20000,
  });
  const active = orders.filter((o) => o.status !== 'CANCELLED');
  const cancelled = orders.filter((o) => o.status === 'CANCELLED');
  const sum = (a) => a.reduce((s, n) => s + n, 0);
  const revenueCents = sum(active.map((o) => o.totalCents));
  const productSalesCents = sum(active.map((o) => o.subtotalCents - o.discountCents));
  const deliveryFeesCents = sum(active.map((o) => o.deliveryFeeCents));
  const discountsCents = sum(active.map((o) => o.discountCents));
  const cogsCents = sum(active.flatMap((o) => o.items.map((i) => i.unitCostCents * i.quantity)));
  const expenses = await prisma.expense.findMany({ where: range ? { occurredAt: range } : {}, select: { amountCents: true } });
  const expensesCents = sum(expenses.map((e) => e.amountCents));
  const estimatedProfitCents = revenueCents - cogsCents - expensesCents;
  res.json({
    orders: active.length,
    cancelledOrders: cancelled.length,
    cancelledCents: sum(cancelled.map((o) => o.totalCents)),
    revenueCents, productSalesCents, deliveryFeesCents, discountsCents, cogsCents, expensesCents,
    estimatedProfitCents,
    marginPct: revenueCents ? Math.round((estimatedProfitCents / revenueCents) * 1000) / 10 : 0,
    note: 'Estimativa: usa o custo cadastrado em cada produto no momento da venda. Pedidos antigos sem custo cadastrado entram com custo zero, e custos de adicionais, embalagens e entregadores não estão incluídos.',
  });
});

export default router;
