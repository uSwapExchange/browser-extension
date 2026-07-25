import { allCapturePatterns } from '../templates/platforms.js';
import { IS_FIREFOX } from '../../../core/target.js';
import {
  findSessionByAuthTab,
  getSession,
  putSession,
  type CapturedRequest,
  type CaptureSession,
} from './session.js';

/**
 * webRequest interception. Listeners are registered synchronously at SW
 * startup (MV3 wakeup rule) but only act when an active capture session
 * matches the request's tab + the template's urlRegex.
 *
 * Bodies arrive in onBeforeRequest; headers (incl. Cookie/Authorization, via
 * extraHeaders) in onBeforeSendHeaders. They're joined on the chrome
 * requestId. Response bodies are NOT readable here — see replay.ts.
 */

interface PartialCapture {
  authTabId: number;
  sessionRequestId: string;
  url: string;
  method: string;
  /** True when this is an auth-bearing Revolut context request, not the template endpoint itself. */
  revolutContextOnly?: boolean;
  body?: string;
  headers?: Record<string, string>;
}

// chrome requestId -> partial capture (in-memory; a lost SW restart just drops
// an in-flight capture and the user retries).
const inflight = new Map<string, PartialCapture>();

let onCaptureComplete: ((session: CaptureSession) => void) | null = null;
export function setCaptureCompleteHandler(handler: (session: CaptureSession) => void): void {
  onCaptureComplete = handler;
}

type RequestBody = chrome.webRequest.OnBeforeRequestDetails['requestBody'];

function decodeBody(requestBody: RequestBody): string {
  if (!requestBody) return '';
  if (requestBody.raw?.length) {
    try {
      const decoder = new TextDecoder();
      return requestBody.raw
        .map((part: { bytes?: ArrayBuffer }) => (part.bytes ? decoder.decode(part.bytes) : ''))
        .join('');
    } catch {
      return '';
    }
  }
  if (requestBody.formData) {
    return JSON.stringify(requestBody.formData);
  }
  return '';
}

function matchesCriteria(
  url: string,
  method: string,
  body: string | undefined,
  expectedMethod: string | undefined,
  urlRegex: string | undefined,
  bodyRegex: string | undefined,
  allowUnknownBody: boolean,
): boolean {
  if (!urlRegex) return false;
  if (expectedMethod && expectedMethod.toUpperCase() !== method.toUpperCase()) return false;
  if (!new RegExp(urlRegex).test(url)) return false;
  if (!bodyRegex) return true;
  if (body === undefined) return allowUnknownBody;
  return new RegExp(bodyRegex).test(body);
}

export function matchesTemplate(
  session: CaptureSession,
  url: string,
  method: string,
  body?: string,
  allowUnknownBody = false,
): boolean {
  const meta = session.template.metadata;
  return (
    matchesCriteria(url, method, body, meta.method, meta.urlRegex, meta.bodyRegex, allowUnknownBody)
    || matchesCriteria(
      url,
      method,
      body,
      meta.fallbackMethod,
      meta.fallbackUrlRegex,
      meta.fallbackBodyRegex,
      allowUnknownBody,
    )
    || matchesCriteria(
      url,
      method,
      body,
      meta.metadataUrlMethod,
      meta.metadataUrl ? `^${escapeRegex(meta.metadataUrl)}` : undefined,
      meta.metadataUrlBody ? `^${escapeRegex(meta.metadataUrlBody)}$` : undefined,
      allowUnknownBody,
    )
  );
}

/**
 * Revolut's current web UI no longer consistently calls the legacy
 * transactions endpoint in Peer's template. Any genuine current-user retail
 * request can still provide the SPA-attached authentication context needed to
 * replay that configured endpoint.
 */
export function matchesRevolutContextRequest(
  session: CaptureSession,
  rawUrl: string,
  method: string,
): boolean {
  if (session.platform !== 'revolut' || method.toUpperCase() !== 'GET') return false;
  try {
    const url = new URL(rawUrl);
    const auth = new URL(session.template.authLink);
    return (
      url.protocol === 'https:'
      && url.host === auth.host
      && url.pathname.startsWith('/api/retail/')
    );
  } catch {
    return false;
  }
}

/** Reject public/Cloudflare-only requests before they can consume the session. */
export function hasLikelyRevolutAuth(headers: Record<string, string>): boolean {
  for (const name of Object.keys(headers)) {
    if (/(^|[-_])(authorization|auth|token|session|device)([-_]|$)/i.test(name)) {
      return true;
    }
  }
  const cookieEntry = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'cookie');
  if (!cookieEntry) return false;
  return cookieEntry[1]
    .split(';')
    .map((part) => part.trim().split('=', 1)[0] ?? '')
    .some((name) => name !== '' && !/^(__cf|cf_)/i.test(name));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function maybeComplete(requestId: string): Promise<void> {
  const partial = inflight.get(requestId);
  if (!partial || partial.body === undefined || partial.headers === undefined) return;
  inflight.delete(requestId);

  const session = await getSession(partial.sessionRequestId);
  if (!session || session.status !== 'awaiting_request') return;

  const captured: CapturedRequest = {
    url: partial.url,
    method: partial.method,
    headers: partial.headers,
    body: partial.body,
  };
  const updated: CaptureSession = { ...session, captured, status: 'captured' };
  await putSession(updated);
  onCaptureComplete?.(updated);
}

// Stable listener references so the registration is idempotent and removable.
const onBeforeRequestListener = (
  details: chrome.webRequest.OnBeforeRequestDetails,
): chrome.webRequest.BlockingResponse | undefined => {
  if (details.tabId < 0) return undefined;
  void (async () => {
    const session = await findSessionByAuthTab(details.tabId);
    if (!session) return;
    const body = decodeBody(details.requestBody);
    const templateMatch = matchesTemplate(session, details.url, details.method, body);
    const revolutContextMatch = matchesRevolutContextRequest(
      session,
      details.url,
      details.method,
    );
    if (!templateMatch && !revolutContextMatch) {
      inflight.delete(details.requestId);
      return;
    }
    const existing = inflight.get(details.requestId) ?? {
      authTabId: details.tabId,
      sessionRequestId: session.requestId,
      url: details.url,
      method: details.method,
    };
    existing.revolutContextOnly = revolutContextMatch && !templateMatch;
    existing.body = body;
    inflight.set(details.requestId, existing);
    await maybeComplete(details.requestId);
  })();
  return undefined;
};

const onBeforeSendHeadersListener = (
  details: chrome.webRequest.OnBeforeSendHeadersDetails,
): chrome.webRequest.BlockingResponse | undefined => {
  if (details.tabId < 0) return undefined;
  void (async () => {
    const session = await findSessionByAuthTab(details.tabId);
    if (!session) return;
    const existing = inflight.get(details.requestId);
    const revolutContextMatch = matchesRevolutContextRequest(
      session,
      details.url,
      details.method,
    );
    // onBeforeRequest runs before onBeforeSendHeaders. If it matched a
    // body-filtered template, trust that decision; otherwise only accept
    // criteria that do not require a body.
    if (
      !existing
      && !matchesTemplate(session, details.url, details.method, undefined, true)
      && !revolutContextMatch
    ) return;
    const headers: Record<string, string> = {};
    for (const header of details.requestHeaders ?? []) {
      if (header.name && header.value != null) headers[header.name] = header.value;
    }
    const contextOnly = existing?.revolutContextOnly ?? revolutContextMatch;
    if (contextOnly && !hasLikelyRevolutAuth(headers)) {
      inflight.delete(details.requestId);
      return;
    }
    const partial = existing ?? {
      authTabId: details.tabId,
      sessionRequestId: session.requestId,
      url: details.url,
      method: details.method,
      revolutContextOnly: contextOnly,
    };
    partial.headers = headers;
    inflight.set(details.requestId, partial);
    await maybeComplete(details.requestId);
  })();
  return undefined;
};

/**
 * Register the capture webRequest listeners. IDEMPOTENT and safe to re-call.
 *
 * Re-registration is load-bearing: payment-platform hosts (cash.app, venmo, …)
 * are `optional_host_permissions`, granted on demand. A webRequest listener
 * registered BEFORE a host permission is granted does NOT observe that host —
 * Chrome only applies the new permission once the listener is re-added. So we
 * re-call this on `chrome.permissions.onAdded` (see peer-capture/index.ts).
 * Without that, capture on a freshly-granted platform silently never fires.
 */
export function registerInterceptor(): void {
  // Remove any prior registration first so re-calls don't double-fire.
  try { chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequestListener); } catch { /* not registered */ }
  try { chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeadersListener); } catch { /* not registered */ }

  const filter: chrome.webRequest.RequestFilter = { urls: allCapturePatterns() };
  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequestListener, filter, ['requestBody']);
  // Firefox exposes the sensitive headers without `extraHeaders` and rejects
  // that Chrome-only option, which otherwise aborts background initialization.
  const headerSpec = (IS_FIREFOX
    ? ['requestHeaders']
    : ['requestHeaders', 'extraHeaders']) as chrome.webRequest.OnBeforeSendHeadersOptions[];
  chrome.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeadersListener, filter, headerSpec);
}
