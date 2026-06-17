/**
 * Chrome offscreen document: hosts @zkp2p/sdk cryptography + DOM/XPath parsing
 * because the MV3 service worker can't touch the DOM/WASM. The actual logic
 * lives in ./handlers.ts (shared with Firefox's background event page, which
 * runs it directly — no offscreen document there). This file is just the
 * Chrome-side RPC transport over chrome.runtime messaging.
 */
import { dispatchOffscreen } from './handlers.js';
import type { OffscreenRequest, OffscreenResponse } from '../core/offscreen/rpc.js';

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as OffscreenRequest;
  if (!request || request.target !== 'offscreen') return undefined;

  const respond = (response: Omit<OffscreenResponse, 'target' | 'id'>) =>
    sendResponse({ target: 'offscreen-result', id: request.id, ...response } satisfies OffscreenResponse);

  dispatchOffscreen(request)
    .then((result) => respond({ ok: true, result }))
    .catch((error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));

  return true; // async sendResponse
});
