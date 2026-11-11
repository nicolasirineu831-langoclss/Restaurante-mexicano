import { prisma } from '../lib/prisma.js';
import { sha256 } from '../lib/security.js';

export const SESSION_COOKIE = 'sid';
const LEVEL = { CUSTOMER: 0, STAFF: 1, MANAGER: 2, OWNER: 3 };

// Carrega o usuário a partir do cookie de sessão. O papel é lido do banco a cada requisição,
// então uma mudança de permissão vale imediatamente. O cliente nunca envia o papel.
export async function loadUser(req, res, next) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return next();
  try {
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(raw) },
      include: { user: true },
    });
    if (session && session.expiresAt > new Date() && session.user.active) {
      req.user = { id: session.user.id, role: session.user.role, name: session.user.name, email: session.user.email };
    } else if (session) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
  next();
}

export function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
    if ((LEVEL[req.user.role] ?? -1) < LEVEL[minRole]) return res.status(403).json({ error: 'Sem permissão' });
    next();
  };
}
