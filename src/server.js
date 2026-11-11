import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { loadUser } from './middleware/auth.js';
import { prisma } from './lib/prisma.js';
import authRoutes from './routes/auth.js';
import menuRoutes from './routes/menu.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1); // Render fica atrás de proxy
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline' existe por causa do script e estilos embutidos da página atual.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use(loadUser);

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/restaurant', async (req, res) => {
  const s = await prisma.restaurantSettings.findUnique({ where: { id: 'default' } });
  res.json({
    name: s?.name ?? 'Coyote Culinária TexMex',
    phone: s?.phone ?? null,
    whatsapp: s?.whatsapp ?? null,
    address: s?.address ?? null,
    hours: s?.hours ?? null,
    acceptingOrders: !!s?.acceptingOrders,
    minOrderCents: s?.minOrderCents ?? 0,
    deliveryFeeCents: s?.deliveryFeeCents ?? 0,
  });
});

app.use(express.static(path.join(here, '..', 'public'), { maxAge: '1h', index: 'index.html' }));

app.get('/sitemap.xml', (req, res) => {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url><url><loc>${base}/privacidade.html</loc></url><url><loc>${base}/termos.html</loc></url><url><loc>${base}/alergenicos.html</loc></url></urlset>`,
  );
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}/sitemap.xml\n`);
});

app.get('/admin', (req, res) => res.sendFile(path.join(here, '..', 'public', 'admin.html')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Erro interno' });
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => console.log(`Coyote rodando na porta ${port}`));

const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
