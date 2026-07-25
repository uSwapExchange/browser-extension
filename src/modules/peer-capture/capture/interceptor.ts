import { IS_FIREFOX } from '../../../core/target.js';
import { allCapturePatterns } from '../templates/platforms.js';
import {
  findSessionByAuthTab,
  getSession,
  putSession,
  type CapturedRequest,
  type CaptureSession,
} from './session.js';
import {
  isRelevantProviderRequest,
  matchesConfiguredRequest,
  matchesRequestCriteria,
  ProviderRequestCache,
  selectCompletedProviderContext,
  sessionRequestBody,
  type ProviderRequestRecord,
} from './provider-request.js';

/**
 * Peer's reference capture lifecycle:
 *
 * - join body + sent headers + response headers by browser requestId;
 * - accept only configured requests from the active provider tab;
 * - wait for a successful 2xx onResponseStarted event;
 * - select primary context before fallback context;
 * - only then hand the context to the metadata/replay flow.
 *
 * Response bodies remain unreadable to MV3 webRequest. The buyer/seller flows
 * replay the selected request after this successful-response gate.
 */

const requestCache = new ProviderRequestCache();

let onCaptureComplete: ((session: CaptureSession) => void) | null = null;
export function setCaptureCompleteHandler(handler: (session: CaptureSession) => void): void {
  onCaptureComplete = handler;
}

export function clearCaptureRequestCache(sessionRequestId: string): void {
  requestCache.clear(sessionRequestId);
}

/** Compatibility export used by focused contract tests. */
export function matchesTemplate(
  session: CaptureSession,
  url: string,
  method: string,
  body = '',
): boolean {
  const request: ProviderRequestRecord = {
    requestId: 'match-only',
    tabId: session.authTabId ?? -1,
    url,
    method,
    type: 'xmlhttprequest',
    initiator: null,
    requestBody: body,
  };
  const { metadata } = session.template;
  return (
    matchesRequestCriteria(
      request,
      metadata.method ?? session.template.method,
      metadata.urlRegex,
      metadata.bodyRegex,
    )
    || matchesRequestCriteria(
      request,
      metadata.fallbackMethod,
      metadata.fallbackUrlRegex,
      metadata.fallbackBodyRegex,
    )
  );
}

type RequestBody = chrome.webRequest.OnBeforeRequestDetails['requestBody'];

function requestBodyPatch(requestBody: RequestBody): Partial<ProviderRequestRecord> {
  if (!requestBody) return { requestBody: '' };
  if (requestBody.raw?.length) {
    try {
      const decoder = new TextDecoder();
      return {
        requestBody: requestBody.raw
          .map((part) => (part.bytes ? decoder.decode(part.bytes) : ''))
          .join(''),
      };
    } catch {
      return { requestBody: '' };
    }
  }
  if (requestBody.formData) {
    return {
      formData: Object.fromEntries(
        Object.entries(requestBody.formData)
          .map(([key, values]) => [key, values.map((value) => String(value))]),
      ),
    };
  }
  return { requestBody: '' };
}

function headersToRecord(
  headers: chrome.webRequest.HttpHeader[] | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers ?? []) {
    if (header.name && header.value != null) result[header.name] = header.value;
  }
  return result;
}

function baseRequestPatch(details: {
  tabId: number;
  url: string;
  method: string;
  type: `${chrome.webRequest.ResourceType}`;
  initiator?: string;
}): Partial<ProviderRequestRecord> {
  return {
    tabId: details.tabId,
    url: details.url,
    method: details.method,
    type: details.type,
    initiator: details.initiator ?? null,
  };
}

function relevant(details: {
  type: `${chrome.webRequest.ResourceType}`;
  method: string;
  url: string;
  initiator?: string;
}): boolean {
  return isRelevantProviderRequest({
    ...details,
    extensionId: chrome.runtime.id,
  });
}

// Chrome may dispatch successive lifecycle events faster than storage-backed
// session reads resolve. Peer's reference engine serializes them with a mutex;
// this promise queue provides the same ordering without another dependency.
let eventQueue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  eventQueue = eventQueue
    .then(task, task)
    .catch((error) => {
      console.error('[peer-capture] webRequest lifecycle failed', error);
    });
}

const onBeforeRequestListener = (
  details: chrome.webRequest.OnBeforeRequestDetails,
): chrome.webRequest.BlockingResponse | undefined => {
  if (details.tabId < 0 || !relevant(details)) return undefined;
  enqueue(async () => {
    const session = await findSessionByAuthTab(details.tabId);
    if (!session || !matchesConfiguredRequest(session.template, details.url)) return;
    requestCache.merge(session.requestId, details.requestId, {
      ...baseRequestPatch(details),
      ...requestBodyPatch(details.requestBody),
    });
  });
  return undefined;
};

const onSendHeadersListener = (
  details: chrome.webRequest.OnSendHeadersDetails,
): void => {
  if (details.tabId < 0 || !relevant(details)) return;
  enqueue(async () => {
    const session = await findSessionByAuthTab(details.tabId);
    if (!session || !matchesConfiguredRequest(session.template, details.url)) return;
    requestCache.merge(session.requestId, details.requestId, {
      ...baseRequestPatch(details),
      requestHeaders: headersToRecord(details.requestHeaders),
    });
  });
};

const onResponseStartedListener = (
  details: chrome.webRequest.OnResponseStartedDetails,
): void => {
  if (
    details.tabId < 0
    || !relevant(details)
    || details.statusCode < 200
    || details.statusCode >= 300
  ) return;

  enqueue(async () => {
    const session = await findSessionByAuthTab(details.tabId);
    if (!session || !matchesConfiguredRequest(session.template, details.url)) return;

    requestCache.merge(session.requestId, details.requestId, {
      ...baseRequestPatch(details),
      statusCode: details.statusCode,
      responseHeaders: headersToRecord(details.responseHeaders),
      timestamp: Date.now(),
    });

    const selected = selectCompletedProviderContext(
      requestCache.list(session.requestId),
      session.template,
    );
    if (!selected) return;

    const context = selected.request;
    const captured: CapturedRequest = {
      url: context.url,
      method: context.method,
      headers: context.requestHeaders ?? {},
      body: sessionRequestBody(context),
      responseHeaders: context.responseHeaders ?? {},
      statusCode: context.statusCode ?? details.statusCode,
      timestamp: context.timestamp ?? Date.now(),
      contextKind: selected.kind,
    };
    const current = await getSession(session.requestId);
    if (!current || current.status !== 'awaiting_request') return;
    const updated: CaptureSession = { ...current, captured, status: 'captured' };
    await putSession(updated);
    requestCache.clear(session.requestId);
    onCaptureComplete?.(updated);
  });
};

/**
 * Register listeners synchronously at service-worker startup. Re-registering
 * after optional host permission is granted is required by Chromium.
 */
export function registerInterceptor(): void {
  try { chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequestListener); } catch { /* not registered */ }
  try { chrome.webRequest.onSendHeaders.removeListener(onSendHeadersListener); } catch { /* not registered */ }
  try { chrome.webRequest.onResponseStarted.removeListener(onResponseStartedListener); } catch { /* not registered */ }

  const filter: chrome.webRequest.RequestFilter = {
    urls: allCapturePatterns(),
    types: ['xmlhttprequest', 'main_frame'],
  };
  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequestListener, filter, ['requestBody']);

  const requestHeaderSpec = (IS_FIREFOX
    ? ['requestHeaders']
    : ['requestHeaders', 'extraHeaders']) as `${chrome.webRequest.OnSendHeadersOptions}`[];
  chrome.webRequest.onSendHeaders.addListener(onSendHeadersListener, filter, requestHeaderSpec);

  const responseHeaderSpec = (IS_FIREFOX
    ? ['responseHeaders']
    : ['responseHeaders', 'extraHeaders']) as `${chrome.webRequest.OnResponseStartedOptions}`[];
  chrome.webRequest.onResponseStarted.addListener(
    onResponseStartedListener,
    filter,
    responseHeaderSpec,
  );
}
