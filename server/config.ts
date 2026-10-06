export function apiPort(): number {
  const raw = process.env.SELFTRAIN_PORT
    ?? (process.env.NODE_ENV === 'production' ? process.env.PORT : undefined)
    ?? '8787';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('服务端口必须是 1–65535 之间的整数。');
  }
  return port;
}
