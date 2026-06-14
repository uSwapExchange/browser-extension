import { allCapturePatterns } from '../templates/platforms.js';
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

function matchesTemplate(session: CaptureSession, url: string, method: string): boolean {
  const meta = session.template.metadata;
  const methodOk = !meta.method || meta.method.toUpperCase() === method.toUpperCase();
  if (methodOk && new RegExp(meta.urlRegex).test(url)) return true;
  if (meta.fallbackUrlRegex && new RegExp(meta.fallbackUrlRegex).test(url)) return true;
  if (meta.metadataUrl && url.startsWith(meta.metadataUrl)) return true;
  return false;
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
    if (!session || !matchesTemplate(session, details.url, details.method)) return;
    const existing = inflight.get(details.requestId) ?? {
      authTabId: details.tabId,
      sessionRequestId: session.requestId,
      url: details.url,
      method: details.method,
    };
    existing.body = decodeBody(details.requestBody);
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
    if (!session || !matchesTemplate(session, details.url, details.method)) return;
    const headers: Record<string, string> = {};
    for (const header of details.requestHeaders ?? []) {
      if (header.name && header.value != null) headers[header.name] = header.value;
    }
    const existing = inflight.get(details.requestId) ?? {
      authTabId: details.tabId,
      sessionRequestId: session.requestId,
      url: details.url,
      method: details.method,
    };
    existing.headers = headers;
    inflight.set(details.requestId, existing);
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
  chrome.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeadersListener, filter, ['requestHeaders', 'extraHeaders']);
}
