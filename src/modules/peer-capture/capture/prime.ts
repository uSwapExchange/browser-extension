import type { ProviderTemplate } from '../templates/types.js';
import { canPrimeMetadataRequest } from './provider-request.js';
import {
  replayRequest,
  resolveReplayRequest,
  type ReplayResult,
} from './replay.js';
import type { CapturedRequest, CaptureSession } from './session.js';

const attemptedContexts = new Map<string, Set<string>>();

function contextFingerprint(context: CapturedRequest): string {
  const headers = Object.entries(context.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  // Kept only in extension session memory and never logged or delivered.
  // Including values allows a post-login request with refreshed credentials to
  // retry a metadata prime that previously returned 401.
  return `${context.url}\n${JSON.stringify(headers)}`;
}

function emptyContext(template: ProviderTemplate): CapturedRequest {
  return {
    url: template.authLink,
    method: 'GET',
    headers: {},
    body: '',
  };
}

/**
 * Issue the hosted template's exact metadata request inside the authenticated
 * provider tab. The interceptor observes this request and handles it through
 * the normal primary/fallback lifecycle. A successful unrelated provider API
 * request can lend its non-forbidden auth headers when a cookie-only probe is
 * insufficient.
 */
export async function primeMetadataRequest(
  session: CaptureSession,
  context: CapturedRequest = emptyContext(session.template),
  replay: (
    request: CapturedRequest,
    options: { inPage?: boolean; tabId?: number | null },
  ) => Promise<ReplayResult> = replayRequest,
): Promise<void> {
  if (
    session.authTabId == null
    || !canPrimeMetadataRequest(session.template)
  ) return;

  let attempts = attemptedContexts.get(session.requestId);
  if (!attempts) {
    attempts = new Set();
    attemptedContexts.set(session.requestId, attempts);
  }
  const fingerprint = contextFingerprint(context);
  if (attempts.has(fingerprint)) return;
  attempts.add(fingerprint);

  let response: ReplayResult;
  try {
    const request = resolveReplayRequest(context, session.template);
    response = await replay(request, {
      inPage: true,
      tabId: session.authTabId,
    });
  } catch (error) {
    attempts.delete(fingerprint);
    throw error;
  }
  if (response.status >= 200 && response.status < 300) return;
  console.warn('[peer-capture] template metadata prime was not successful', {
    platform: session.platform,
    statusCode: response.status,
  });
}

export function clearMetadataPrimeState(sessionRequestId: string): void {
  attemptedContexts.delete(sessionRequestId);
}
