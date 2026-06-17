import { ensureOffscreenDocument } from './manager.js';
import { IS_FIREFOX } from '../target.js';

/**
 * Typed request/response RPC to the offscreen document over chrome.runtime.
 * Messages carry target:'offscreen' so they don't collide with bus traffic.
 */

export type OffscreenRequest =
  | {
      target: 'offscreen';
      type: 'encrypt-buyer-tee';
      id: string;
      payload: {
        platform: string;
        actionType: string;
        attestationServiceUrl: string;
        sessionMaterial: Record<string, string>;
      };
    }
  | {
      target: 'offscreen';
      type: 'create-seller-bundle';
      id: string;
      payload: {
        platform: string;
        attestationServiceUrl: string;
        payeeId: string;
        sessionMaterial: Record<string, unknown>;
      };
    }
  | {
      target: 'offscreen';
      type: 'xpath-extract';
      id: string;
      payload: { html: string; listSelector: string; fieldSelectors: Record<string, string> };
    };

export interface OffscreenResponse {
  target: 'offscreen-result';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `osc-${counter}`;
}

export async function offscreenCall<T>(
  type: OffscreenRequest['type'],
  payload: Extract<OffscreenRequest, { type: typeof type }>['payload'],
  timeoutMs = 30_000,
): Promise<T> {
  // Firefox has no offscreen document; its event-page background can run the
  // @zkp2p crypto + DOM work directly, so dispatch in-process (no RPC). The
  // import is dynamic so the offscreen handlers (and @zkp2p/sdk) don't get
  // pulled into the Chrome service-worker bundle, which uses the RPC path.
  if (IS_FIREFOX) {
    const id = nextId();
    const { dispatchOffscreen } = await import('../../offscreen/handlers.js');
    return (await dispatchOffscreen({ target: 'offscreen', type, id, payload } as OffscreenRequest)) as T;
  }

  await ensureOffscreenDocument();
  const id = nextId();
  const request = { target: 'offscreen', type, id, payload } as OffscreenRequest;

  const response = (await Promise.race([
    chrome.runtime.sendMessage(request),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`offscreen ${type} timed out`)), timeoutMs),
    ),
  ])) as OffscreenResponse;

  if (!response || response.target !== 'offscreen-result' || response.id !== id) {
    throw new Error(`Malformed offscreen response for ${type}`);
  }
  if (!response.ok) throw new Error(response.error ?? `offscreen ${type} failed`);
  return response.result as T;
}
