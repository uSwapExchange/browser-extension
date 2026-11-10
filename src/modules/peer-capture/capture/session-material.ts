import type { CaptureSession } from './session.js';

/** Only the encrypted envelope receives these provider credentials. */
export function buyerSessionMaterial(session: Pick<CaptureSession, 'captured' | 'platform' | 'actionType'>): Record<string, unknown> {
  const captured = session.captured;
  if (!captured) throw new Error('Account capture is missing');
  if (session.actionType === 'register_cashapp') {
    const cookie = Object.entries(captured.headers).find(([key]) => key.toLowerCase() === 'cookie')?.[1];
    if (!cookie || !captured.body) throw new Error('Cash App session or activity request is missing');
    return { sessionCookie: cookie, requestPayload: captured.body, requestHeaders: { ...captured.headers } };
  }
  const material: Record<string, unknown> = { ...captured.headers };
  if (captured.body) material.body = captured.body;
  if (session.platform === 'xmoney') material.url = captured.url;
  return material;
}
