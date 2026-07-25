import type { CapturedRequest } from './session.js';
import type { ProviderTemplate } from '../templates/types.js';

/**
 * Replay the captured request from the service-worker context to read the
 * response body that webRequest can't expose in MV3.
 *
 * With host permission held, an extension fetch with credentials:'include'
 * attaches the browser cookie jar. For sessions pinned to forbidden headers
 * (Cookie/User-Agent set explicitly), we install a scoped
 * declarativeNetRequest session rule to inject them, then remove it.
 */

const FORBIDDEN_HEADERS = new Set([
  'cookie', 'origin', 'referer', 'user-agent',
  'content-length', 'host', 'connection', 'accept-encoding',
]);

const DNR_RULE_ID_MIN = 90_001;
const DNR_RULE_ID_MAX = 99_999;
let nextDnrRuleId = DNR_RULE_ID_MIN;
const activeDnrRuleIds = new Set<number>();

/** Reserve a rule ID so concurrent capture replays cannot overwrite each other. */
export function reserveReplayRuleId(): number {
  const capacity = DNR_RULE_ID_MAX - DNR_RULE_ID_MIN + 1;
  for (let attempt = 0; attempt < capacity; attempt += 1) {
    const ruleId = nextDnrRuleId;
    nextDnrRuleId = ruleId >= DNR_RULE_ID_MAX ? DNR_RULE_ID_MIN : ruleId + 1;
    if (!activeDnrRuleIds.has(ruleId)) {
      activeDnrRuleIds.add(ruleId);
      return ruleId;
    }
  }
  throw new Error('No replay header rule IDs are available');
}

export function releaseReplayRuleId(ruleId: number): void {
  activeDnrRuleIds.delete(ruleId);
}

function splitHeaders(headers: Record<string, string>): {
  safe: Record<string, string>;
  forbidden: Record<string, string>;
} {
  const safe: Record<string, string> = {};
  const forbidden: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (FORBIDDEN_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('sec-')) {
      forbidden[name] = value;
    } else {
      safe[name] = value;
    }
  }
  return { safe, forbidden };
}

async function withForbiddenHeaders<T>(
  url: string,
  forbidden: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const names = Object.keys(forbidden);
  if (names.length === 0) return run();
  const ruleId = reserveReplayRuleId();
  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = names.map((name) => ({
    header: name,
    operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
    value: forbidden[name],
  }));
  try {
    // Remove first to clean up the same ID if a previous background lifetime
    // ended before its finally block ran.
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 1,
        action: { type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType, requestHeaders },
        condition: { urlFilter: url, resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType] },
      }],
    });
    return await run();
  } finally {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    } finally {
      releaseReplayRuleId(ruleId);
    }
  }
}

export interface ReplayResult {
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
}

function replayResult(
  status: number,
  text: string,
  headers: Record<string, string>,
): ReplayResult {
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status, text, json, headers };
}

function headersFromResponse(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}

/**
 * Build the request whose response is extracted. metadataUrl is a distinct
 * replay target, not merely another intercept pattern. Peer requires it to be
 * HTTPS and same-host as the authenticated context request.
 */
export function resolveReplayRequest(
  captured: CapturedRequest,
  template: ProviderTemplate,
): CapturedRequest {
  const metadataUrl = template.metadata.metadataUrl?.trim();
  if (!metadataUrl) return captured;

  const target = new URL(metadataUrl);
  const context = new URL(captured.url);
  if (target.protocol !== 'https:' || target.host !== context.host) {
    throw new Error(
      `Unsafe metadataUrl: expected HTTPS on ${context.host}, received ${target.protocol}//${target.host}`,
    );
  }

  return {
    ...captured,
    url: target.toString(),
    method: (
      template.metadata.metadataUrlMethod
      || template.method
      || 'GET'
    ).toUpperCase(),
    body: template.metadata.metadataUrlBody ?? template.body ?? '',
  };
}

async function replayRequestInPage(
  captured: CapturedRequest,
  tabId: number,
): Promise<ReplayResult> {
  const { safe } = splitHeaders(captured.headers);
  const body = captured.method.toUpperCase() !== 'GET' && captured.body
    ? captured.body
    : null;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    // Match Peer's reference implementation: the isolated world shares the
    // provider origin/cookie jar without exposing the replay to page scripts.
    world: 'ISOLATED',
    func: async (
      url: string,
      method: string,
      headers: Record<string, string>,
      requestBody: string | null,
    ) => {
      try {
        const response = await fetch(url, {
          method,
          headers,
          credentials: 'include',
          ...(requestBody ? { body: requestBody } : {}),
        });
        return {
          ok: true as const,
          status: response.status,
          text: await response.text(),
          headers: Object.fromEntries(response.headers.entries()),
        };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    // Do not mutate the provider URL. Some authenticated APIs sign or
    // authorize the exact query string; appending replay_request=1 caused
    // otherwise valid provider requests to return 401. The capture session is
    // moved out of awaiting_request before normal extraction replays, so the
    // interceptor cannot recurse. Bootstrap replays are intentionally observed
    // once to seed that transition.
    args: [captured.url, captured.method, safe, body],
  });
  const result = results[0]?.result;
  if (!result) throw new Error('In-page replay did not return a result');
  if (!result.ok) throw new Error(`In-page replay failed: ${result.error}`);
  return replayResult(result.status, result.text, result.headers ?? {});
}

export async function replayRequest(
  captured: CapturedRequest,
  options: { inPage?: boolean; tabId?: number | null } = {},
): Promise<ReplayResult> {
  if (options.inPage) {
    if (options.tabId == null) {
      throw new Error('In-page replay requires the payment provider tab');
    }
    return replayRequestInPage(captured, options.tabId);
  }
  const { safe, forbidden } = splitHeaders(captured.headers);
  const init: RequestInit = {
    method: captured.method,
    headers: safe,
    credentials: 'include',
  };
  if (captured.method.toUpperCase() !== 'GET' && captured.body) {
    init.body = captured.body;
  }

  const replayUrl = captured.url;
  const response = await withForbiddenHeaders(replayUrl, forbidden, () => fetch(replayUrl, init));
  const text = await response.text();
  return replayResult(response.status, text, headersFromResponse(response));
}
