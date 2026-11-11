// Tempo real via Server-Sent Events (sem dependências extras, funciona no Render).
const channels = new Map();

function subscribe(channel, res) {
  if (!channels.has(channel)) channels.set(channel, new Set());
  channels.get(channel).add(res);
  res.on('close', () => {
    const set = channels.get(channel);
    if (!set) return;
    set.delete(res);
    if (!set.size) channels.delete(channel);
  });
}

export function publish(channel, event, data) {
  const set = channels.get(channel);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}

export function openStream(req, res, channel, initial) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (initial) res.write(`event: status\ndata: ${JSON.stringify(initial)}\n\n`);
  subscribe(channel, res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => clearInterval(hb));
}
