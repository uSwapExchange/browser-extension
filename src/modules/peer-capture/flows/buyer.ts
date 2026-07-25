import { offscreenCall } from '../../../core/offscreen/rpc.js';
import { openPrompt } from '../../../core/consent/prompt.js';
import { busEvent } from '../../../core/bus/protocol.js';
import { extractRows } from '../capture/extract.js';
import { buildParams, type CaptureSources } from '../capture/selectors.js';
import { assertNoPrivateLeak } from '../capture/redact.js';
import { resolveMetadataPayload } from '../capture/metadata-engine.js';
import {
  getSession,
  putSession,
  wipeSession,
  type CaptureSession,
} from '../capture/session.js';
import { PEER_TYPES, type PeerMetadataMessage, type PeerMetadataRow } from '../api-contract.js';

/**
 * Drives the buyer-TEE flow once the interceptor has captured the request:
 * replay → extract metadata → encrypt session material → deliver to the
 * originating tab. Stateless: the session is wiped on delivery or failure.
 */

type DeliverFn = (session: CaptureSession, message: PeerMetadataMessage) => void;

let deliver: DeliverFn = () => {};
export function setBuyerDeliver(fn: DeliverFn): void {
  deliver = fn;
}

function deliverError(session: CaptureSession, error: string): void {
  deliver(session, {
    requestId: session.requestId,
    platform: session.platform,
    metadata: [],
    expiresAt: session.expiresAt,
    error,
  });
}

async function finishProviderTab(session: CaptureSession): Promise<void> {
  if (session.sourceTabId != null) {
    try { await chrome.tabs.update(session.sourceTabId, { active: true }); } catch { /* source closed */ }
  }
  if (!session.template.metadata.shouldSkipCloseTab && session.authTabId != null) {
    try { await chrome.tabs.remove(session.authTabId); } catch { /* already closed */ }
  }
}

export async function runBuyerCapture(requestId: string): Promise<void> {
  const session = await getSession(requestId);
  if (!session || !session.captured) return;

  try {
    await putSession({ ...session, status: 'extracting' });
    const payload = await resolveMetadataPayload({
      context: session.captured,
      template: session.template,
      authTabId: session.authTabId,
    });
    const rows = await extractRows(
      session.template,
      payload.parsed.text,
      payload.parsed.json,
    );
    if (rows.length === 0) throw new Error('No transactions found to capture');

    const sources: CaptureSources = {
      responseJson: payload.parsed.json,
      responseText: payload.parsed.text,
      requestBody: session.captured.body,
      requestHeaders: session.captured.headers,
      responseHeaders: payload.response.headers,
      url: payload.request.url,
    };

    // Build per-row params up front so the page can select by metadata and
    // get the matching params. Collect private values to enforce redaction.
    const privateValues: unknown[] = [];
    const paramsByIndex = new Map<number, Record<string, unknown>>();
    for (const row of rows) {
      const built = await buildParams(session.template, row.originalIndex, sources);
      paramsByIndex.set(row.originalIndex, built.params);
      privateValues.push(...built.privateValues);
    }
    // Secret-header values are private too.
    for (const name of session.template.secretHeaders ?? []) {
      const matched = Object.keys(session.captured.headers)
        .find((header) => header.toLowerCase() === name.toLowerCase());
      const value = matched ? session.captured.headers[matched] : undefined;
      if (value) privateValues.push(value);
    }
    assertNoPrivateLeak(rows, privateValues);

    // Inline templates require explicit approval before any result is posted.
    if (session.inline) {
      await putSession({ ...session, status: 'awaiting_approval' });
      const approved = await openPrompt({
        kind: 'inline-template',
        origin: session.origin,
        detail: {
          platform: session.platform,
          actionType: session.actionType,
          rows: rows.length,
          paramNames: session.template.paramNames,
        },
      });
      if (!approved) {
        await wipeSession(requestId);
        deliverError(session, 'Capture declined');
        return;
      }
    }

    // Encrypt the captured session material in the offscreen document.
    const sessionMaterial: Record<string, string> = { ...session.captured.headers };
    if (session.captured.body) sessionMaterial.body = session.captured.body;
    const { encryptedSessionMaterial } = await offscreenCall<{ encryptedSessionMaterial: string }>(
      'encrypt-buyer-tee',
      {
        platform: session.platform,
        actionType: session.attestationActionType,
        attestationServiceUrl: session.attestationServiceUrl,
        sessionMaterial,
      },
    );

    // The page selects the matching row; we hand it the rows plus the params
    // for the first row, and embed per-row params on each metadata row so the
    // page can pick by originalIndex.
    const metadata: PeerMetadataRow[] = rows.map((row) => ({
      ...row,
      params: paramsByIndex.get(row.originalIndex),
    }));
    const firstParams = paramsByIndex.get(rows[0]!.originalIndex) ?? {};

    deliver(session, {
      requestId: session.requestId,
      platform: session.template.metadata.platform,
      metadata,
      expiresAt: session.expiresAt,
      buyerTeeCapture: { encryptedSessionMaterial, params: firstParams },
    });
    await wipeSession(requestId);
    await finishProviderTab(session);
  } catch (error) {
    await wipeSession(requestId);
    deliverError(session, error instanceof Error ? error.message : String(error));
  }
}

export const BUYER_METADATA_EVENT = busEvent('peer-capture', PEER_TYPES.metadataMessage);
