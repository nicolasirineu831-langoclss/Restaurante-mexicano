// Envio de e-mail via Resend (HTTP, sem dependências extras).
// Sem RESEND_API_KEY/MAIL_FROM: em desenvolvimento o conteúdo vai para o console; em produção gera erro.
export async function sendMail({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('E-mail não configurado (defina RESEND_API_KEY e MAIL_FROM)');
    }
    console.log(`[e-mail de desenvolvimento] Para: ${to}\nAssunto: ${subject}\n${text}\n`);
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!r.ok) throw new Error(`Provedor de e-mail respondeu ${r.status}`);
}
