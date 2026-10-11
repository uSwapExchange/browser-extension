import type { CapturedRequest } from './session.js';

/** Browser/SDK exceptions can contain rejected header values. Never relay them. */
export function captureErrorMessage(error: unknown, captured: CapturedRequest | null): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(captured?.headers ?? {})) {
    secrets.add(value);
    if (/cookie/i.test(name)) {
      for (const part of value.split(';')) secrets.add(part.slice(part.indexOf('=') + 1).trim());
    }
    if (/authorization/i.test(name)) secrets.add(value.replace(/^Bearer\s+/i, ''));
  }
  if (captured?.body) secrets.add(captured.body);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) message = message.replaceAll(secret, '[private]');
  }
  return message;
}
