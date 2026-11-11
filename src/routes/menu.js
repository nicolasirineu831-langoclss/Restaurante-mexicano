import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

const router = Router();

// Cardápio público: somente campos seguros, sem dados internos.
router.get('/', async (req, res) => {
  const categories = await prisma.category.findMany({
    orderBy: { sortOrder: 'asc' },
    include: {
      products: {
        orderBy: { popularity: 'desc' },
        select: {
          id: true, name: true, description: true, ingredients: true,
          priceCents: true, prepMinutes: true, available: true, featured: true,
          addons: { where: { active: true }, select: { id: true, name: true, priceCents: true }, orderBy: { priceCents: 'asc' } },
        },
      },
    },
  });
  res.json({ categories });
});

// Promoções ativas e dentro do período (públicas).
router.get('/promotions', async (req, res) => {
  const now = new Date();
  const promotions = await prisma.promotion.findMany({
    where: {
      active: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true, kind: true, title: true, description: true, priceCents: true,
      product: { select: { id: true, name: true, priceCents: true, available: true } },
    },
  });
  res.json({ promotions });
});

export default router;
