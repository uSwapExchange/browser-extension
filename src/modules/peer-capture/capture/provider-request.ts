import type { ProviderTemplate } from '../templates/types.js';

export type ProviderResourceType = `${chrome.webRequest.ResourceType}`;

export interface ProviderRequestRecord {
  requestId: string;
  tabId: number;
  url: string;
  method: string;
  type: ProviderResourceType;
  initiator: string | null;
  requestBody?: string;
  formData?: Record<string, string[]>;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  statusCode?: number;
  timestamp?: number;
}

/**
 * Reference-shaped, memory-only request cache. A service-worker restart drops
 * in-flight browser requests; the persisted capture session remains available
 * for a clean retry until its normal timeout.
 */
export class ProviderRequestCache {
  private readonly sessions = new Map<string, Map<string, ProviderRequestRecord>>();

  merge(
    sessionRequestId: string,
    browserRequestId: string,
    patch: Partial<ProviderRequestRecord>,
  ): ProviderRequestRecord {
    let session = this.sessions.get(sessionRequestId);
    if (!session) {
      session = new Map();
      this.sessions.set(sessionRequestId, session);
    }
    const current = session.get(browserRequestId);
    const merged = {
      ...current,
      ...patch,
      requestId: browserRequestId,
    } as ProviderRequestRecord;
    session.set(browserRequestId, merged);
    return merged;
  }

  get(sessionRequestId: string, browserRequestId: string): ProviderRequestRecord | undefined {
    return this.sessions.get(sessionRequestId)?.get(browserRequestId);
  }

  list(sessionRequestId: string): ProviderRequestRecord[] {
    return [...(this.sessions.get(sessionRequestId)?.values() ?? [])];
  }

  delete(sessionRequestId: string, browserRequestId: string): void {
    const session = this.sessions.get(sessionRequestId);
    session?.delete(browserRequestId);
    if (session?.size === 0) this.sessions.delete(sessionRequestId);
  }

  clear(sessionRequestId: string): void {
    this.sessions.delete(sessionRequestId);
  }
}

export function requestBodyText(request: ProviderRequestRecord): string {
  if (request.requestBody !== undefined) return request.requestBody;
  return request.formData ? JSON.stringify(request.formData) : '';
}

export function matchesRequestCriteria(
  request: ProviderRequestRecord,
  method: string | undefined,
  urlRegex: string | undefined,
  bodyRegex?: string,
): boolean {
  if (!method || !urlRegex) return false;
  if (request.method !== method || !new RegExp(urlRegex).test(request.url)) return false;
  if (!bodyRegex) return true;
  const body = requestBodyText(request);
  return Boolean(body && new RegExp(bodyRegex).test(body));
}

export function selectProviderContext(
  requests: ProviderRequestRecord[],
  template: ProviderTemplate,
): { kind: 'primary' | 'fallback'; request: ProviderRequestRecord } | null {
  const { metadata } = template;
  const primary = requests.find((request) => matchesRequestCriteria(
    request,
    metadata.method ?? template.method,
    metadata.urlRegex,
    metadata.bodyRegex,
  ));
  if (primary) return { kind: 'primary', request: primary };

  const fallback = requests.find((request) => matchesRequestCriteria(
    request,
    metadata.fallbackMethod,
    metadata.fallbackUrlRegex,
    metadata.fallbackBodyRegex,
  ));
  return fallback ? { kind: 'fallback', request: fallback } : null;
}

export function configuredRequestPatterns(template: ProviderTemplate): string[] {
  const patterns: string[] = [];
  const { metadata } = template;
  if (metadata.urlRegex) patterns.push(metadata.urlRegex);
  if (metadata.fallbackUrlRegex) patterns.push(metadata.fallbackUrlRegex);
  if (metadata.metadataUrl) {
    const metadataPattern = metadata.metadataUrl.replace(/\{\{[^}]+\}\}/g, '\\S+');
    if (!patterns.includes(metadataPattern)) patterns.push(metadataPattern);
  }
  return patterns;
}

export function matchesConfiguredRequest(
  template: ProviderTemplate,
  url: string,
): boolean {
  return configuredRequestPatterns(template)
    .some((pattern) => new RegExp(pattern).test(url));
}

export function isRelevantProviderRequest(input: {
  type: ProviderResourceType;
  method: string;
  url: string;
  initiator?: string;
  extensionId: string;
}): boolean {
  if (input.type !== 'xmlhttprequest' && input.type !== 'main_frame') return false;
  if (input.method === 'OPTIONS' || input.method === 'HEAD') return false;
  if (input.initiator?.includes(input.extensionId)) return false;
  return !input.url.includes('replay_request=1');
}
