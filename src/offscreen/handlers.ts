/**
 * The @zkp2p/sdk cryptography + DOM/XPath extraction handlers, factored out of
 * the Chrome offscreen document so both targets can share them:
 *   - Chrome: the MV3 service worker can't touch the DOM/WASM, so these run in
 *     an offscreen document (src/offscreen/offscreen.ts wires the RPC listener).
 *   - Firefox: the MV3 background is an event page that CAN use the DOM +
 *     WebCrypto directly, so `offscreenCall` invokes `dispatchOffscreen` here
 *     in-process — no offscreen document, no RPC round-trip.
 *
 * Plaintext session material is held only transiently and never persisted —
 * only ciphertext / extracted fields are returned.
 */
import {
  apiCreateSellerCredentialBundle,
  createEncryptedBuyerTeeSessionMaterial,
  type SellerCredentialAttestationRuntime,
} from '@zkp2p/sdk';
import type { OffscreenRequest } from '../core/offscreen/rpc.js';

const attestationRuntime: SellerCredentialAttestationRuntime = {
  fetch: globalThis.fetch.bind(globalThis),
  subtle: globalThis.crypto.subtle,
  getRandomValues: (array) => globalThis.crypto.getRandomValues(array),
};

export async function handleEncryptBuyerTee(
  payload: Extract<OffscreenRequest, { type: 'encrypt-buyer-tee' }>['payload'],
): Promise<{ encryptedSessionMaterial: unknown }> {
  const encrypted = await createEncryptedBuyerTeeSessionMaterial({
    platform: payload.platform,
    actionType: payload.actionType,
    attestationServiceUrl: payload.attestationServiceUrl,
    sessionMaterial: payload.sessionMaterial,
  } as Parameters<typeof createEncryptedBuyerTeeSessionMaterial>[0]);
  return { encryptedSessionMaterial: encrypted };
}

export async function handleCreateSellerBundle(
  payload: Extract<OffscreenRequest, { type: 'create-seller-bundle' }>['payload'],
): Promise<{ credentialBundle: unknown }> {
  const response = await apiCreateSellerCredentialBundle(
    { payeeId: payload.payeeId, sessionMaterial: payload.sessionMaterial } as never,
    payload.attestationServiceUrl,
    payload.platform as never,
    undefined,
    attestationRuntime,
  );
  return { credentialBundle: (response as { responseObject?: unknown }).responseObject ?? response };
}

export function handleXPathExtract(
  payload: Extract<OffscreenRequest, { type: 'xpath-extract' }>['payload'],
): { rows: Array<Record<string, unknown>> } {
  const doc = new DOMParser().parseFromString(payload.html, 'text/html');
  const evaluateNodes = (context: Node, expr: string): Node[] => {
    const result = doc.evaluate(expr, context, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const nodes: Node[] = [];
    for (let i = 0; i < result.snapshotLength; i += 1) {
      const node = result.snapshotItem(i);
      if (node) nodes.push(node);
    }
    return nodes;
  };
  const rows = evaluateNodes(doc, payload.listSelector).map((node, originalIndex) => {
    const row: Record<string, unknown> = { originalIndex };
    for (const [field, expr] of Object.entries(payload.fieldSelectors)) {
      const matches = evaluateNodes(node, expr);
      row[field] = matches[0]?.textContent ?? null;
    }
    return row;
  });
  return { rows };
}

/**
 * Dispatch an offscreen request to its handler. Used by the Chrome offscreen
 * document's message listener AND directly by Firefox's background event page.
 */
export async function dispatchOffscreen(request: OffscreenRequest): Promise<unknown> {
  switch (request.type) {
    case 'encrypt-buyer-tee':
      return handleEncryptBuyerTee(request.payload);
    case 'create-seller-bundle':
      return handleCreateSellerBundle(request.payload);
    case 'xpath-extract':
      return handleXPathExtract(request.payload);
    default:
      throw new Error('Unknown offscreen request');
  }
}
