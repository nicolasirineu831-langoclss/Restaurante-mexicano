import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const newOrderNumber = () =>
  'CYX-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

export function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
