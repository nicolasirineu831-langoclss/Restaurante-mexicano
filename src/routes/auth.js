import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { sendMail } from '../lib/mailer.js';
import { newToken, sha256 } from '../lib/security.js';
import { SESSION_COOKIE, requireAuth } from '../middleware/auth.js';

const router = Router();
const SESSION_DAYS = 14;
const DUMMY_HASH = bcrypt.hashSync('senha-inexistente-para-tempo-constante', 12);

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  path: '/',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
  phone: z.string().trim().max(30).optional(),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

async function createSession(res, userId) {
  const token = newToken();
  await prisma.session.create({
    data: { tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5) },
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

router.post('/register', authLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.flatten().fieldErrors });
  const { name, email, password, phone } = parsed.data;
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: 'Não foi possível concluir o cadastro com este e-mail' });
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, phone: phone || null, role: 'CUSTOMER' },
  });
  await createSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  const valid = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.active || !valid) return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  await createSession(res, user.id);
  await prisma.activityLog.create({ data: { userId: user.id, action: 'auth.login', entity: 'user', entityId: user.id } });
  res.json({ user: publicUser(user) });
});

router.post('/logout', async (req, res) => {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (raw) await prisma.session.deleteMany({ where: { tokenHash: sha256(raw) } });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const resetSchema = z.object({ token: z.string().min(20).max(200), password: z.string().min(8).max(128) });

// Sempre responde da mesma forma, para não revelar se o e-mail está cadastrado.
router.post('/forgot', authLimiter, async (req, res) => {
  const generic = { ok: true, message: 'Se o e-mail estiver cadastrado, você receberá as instruções em instantes.' };
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) return res.json(generic);
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (user && user.active) {
    const token = newToken();
    await prisma.passwordReset.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
    });
    const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
    sendMail({
        to: user.email,
        subject: 'Redefinir sua senha · Coyote Culinária TexMex',
        text: `Use o link abaixo para criar uma nova senha. Ele vale por 30 minutos.\n\n${base}/?reset=${token}\n\nSe você não pediu a troca, ignore este e-mail.`,
      }).catch((err) => console.error('Falha ao enviar e-mail de recuperação:', err.message));
  }
  res.json(generic);
});

router.post('/reset', authLimiter, async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres' });
  const record = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(parsed.data.token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Link inválido ou expirado. Solicite um novo.' });
  }
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.session.deleteMany({ where: { userId: record.userId } }),
  ]);
  res.json({ ok: true });
});

export default router;
