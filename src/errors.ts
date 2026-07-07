// Turn any thrown value into a non-empty message + a coarse kind, so the UI
// never shows a blank error and can flag connectivity problems distinctly.
export type ErrorKind = 'connection' | 'query';

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  '57P01', // admin_shutdown
  '08006', // connection_failure
  '08003', // connection_does_not_exist
  '08001', // sqlclient_unable_to_establish_sqlconnection
]);

const CONNECTION_RE = /timeout|terminat|connection|connect\b|ECONN|socket|refused|reset by peer|server closed|not connected/i;

export function describeError(err: unknown): { message: string; kind: ErrorKind } {
  const e = err as { message?: unknown; code?: unknown; detail?: unknown } | undefined;
  const code = e?.code != null ? String(e.code) : '';
  const rawMessage = typeof e?.message === 'string' ? e.message.trim() : '';
  const detail = typeof e?.detail === 'string' ? e.detail.trim() : '';

  const message = rawMessage || detail || (code ? `Error ${code}` : '') || String(err ?? 'Unknown error');

  const kind: ErrorKind =
    CONNECTION_CODES.has(code) || CONNECTION_RE.test(message) ? 'connection' : 'query';

  return { message, kind };
}
