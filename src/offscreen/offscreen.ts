import { dispatchOffscreen } from './handlers.js';
import type { OffscreenRequest, OffscreenResponse } from '../core/offscreen/rpc.js';

/**
 * Hosts @zkp2p/sdk cryptography and DOM parsing. The SDK pulls in ethers/ox
 * and needs WebCrypto + a real document; keeping it out of the service worker
 * also keeps SW cold-start fast. Plaintext session material is held only
 * transiently here and never persisted — only ciphertext is returned.
 */

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
