/**
 * Shared @zkp2p cryptography and DOM/XPath handlers. Chrome invokes these from
 * its offscreen document; Firefox invokes them inside its background event
 * page, where DOM and WebCrypto are available.
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

async function handleEncryptBuyerTee(
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

async function handleCreateSellerBundle(
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

function handleXPathExtract(
  payload: Extract<OffscreenRequest, { type: 'xpath-extract' }>['payload'],
): { rows: Array<Record<string, unknown>> } {
  const doc = new DOMParser().parseFromString(payload.html, 'text/html');
  const evaluateNodes = (context: Node, expression: string): Node[] => {
    const result = doc.evaluate(expression, context, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const nodes: Node[] = [];
    for (let index = 0; index < result.snapshotLength; index += 1) {
      const node = result.snapshotItem(index);
      if (node) nodes.push(node);
    }
    return nodes;
  };

  const evaluateValue = (context: Node, expression: string): string | null => {
    const result = doc.evaluate(expression, context, null, XPathResult.ANY_TYPE, null);
    switch (result.resultType) {
      case XPathResult.STRING_TYPE:
        return result.stringValue.trim() || null;
      case XPathResult.NUMBER_TYPE:
        return Number.isFinite(result.numberValue) ? String(result.numberValue) : null;
      case XPathResult.BOOLEAN_TYPE:
        return String(result.booleanValue);
      default: {
        const node = result.iterateNext();
        return node?.textContent?.trim() || null;
      }
    }
  };

  const contexts = payload.listSelector ? evaluateNodes(doc, payload.listSelector) : [doc];
  const rows = contexts.map((node, originalIndex) => {
    const row: Record<string, unknown> = { originalIndex };
    for (const [field, expression] of Object.entries(payload.fieldSelectors)) {
      row[field] = evaluateValue(node, expression);
    }
    row.hidden = Object.entries(row)
      .filter(([field]) => field !== 'originalIndex' && field !== 'hidden')
      .some(([, value]) => value === null || value === undefined || value === '');
    return row;
  });
  return { rows };
}

function handleXPathValue(
  payload: Extract<OffscreenRequest, { type: 'xpath-value' }>['payload'],
): { value: string | null } {
  const doc = new DOMParser().parseFromString(payload.html, 'text/html');
  const result = doc.evaluate(payload.expression, doc, null, XPathResult.ANY_TYPE, null);
  switch (result.resultType) {
    case XPathResult.STRING_TYPE:
      return { value: result.stringValue.trim() || null };
    case XPathResult.NUMBER_TYPE:
      return { value: Number.isFinite(result.numberValue) ? String(result.numberValue) : null };
    case XPathResult.BOOLEAN_TYPE:
      return { value: String(result.booleanValue) };
    default:
      return { value: result.iterateNext()?.textContent?.trim() || null };
  }
}

export async function dispatchOffscreen(request: OffscreenRequest): Promise<unknown> {
  switch (request.type) {
    case 'encrypt-buyer-tee':
      return handleEncryptBuyerTee(request.payload);
    case 'create-seller-bundle':
      return handleCreateSellerBundle(request.payload);
    case 'xpath-extract':
      return handleXPathExtract(request.payload);
    case 'xpath-value':
      return handleXPathValue(request.payload);
    default:
      throw new Error('Unknown offscreen request');
  }
}
