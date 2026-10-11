import { offscreenCall } from '../../../core/offscreen/rpc.js';
import { openPrompt } from '../../../core/consent/prompt.js';
import { busEvent } from '../../../core/bus/protocol.js';
import { extractRows } from '../capture/extract.js';
import { buildParams, type CaptureSources } from '../capture/selectors.js';
import { assertBuyerMetadataPrivacy } from '../capture/redact.js';
import { captureErrorMessage } from '../capture/error.js';
import { prepareBuyerRows, unusableRowsMessage } from '../capture/buyer-rows.js';
import { resolveMetadataPayload } from '../capture/metadata-engine.js';
import {
  getSession,
  isLiveSession,
  updateLiveSession,
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
    if (!await isLiveSession(session) || !await updateLiveSession(session, 'extracting')) return;
    const readRows = async (inPage?: boolean) => {
      const payload = await resolveMetadataPayload({
        context: session.captured!, template: session.template, authTabId: session.authTabId, inPage,
      });
      const rows = await extractRows(session.template, payload.parsed.text, payload.parsed.json);
      const sources: CaptureSources = {
        responseJson: payload.parsed.json, responseText: payload.parsed.text,
        requestBody: session.captured!.body, requestHeaders: session.captured!.headers,
        responseHeaders: payload.response.headers, url: payload.request.url,
      };
      const privateValues: unknown[] = [];
      const paramsByIndex = new Map<number, Record<string, unknown>>();
      for (const row of rows) {
        const built = await buildParams(session.template, row.originalIndex, sources);
        paramsByIndex.set(row.originalIndex, built.params);
        privateValues.push(...built.privateValues);
      }
      const metadata = prepareBuyerRows(session.platform, rows, paramsByIndex, {
        template: session.template, inline: session.inline,
      });
      assertBuyerMetadataPrivacy({
        rows: metadata, platform: session.platform, inline: session.inline,
        headers: session.captured!.headers, secretHeaders: session.template.secretHeaders,
        privateValues,
      });
      return metadata;
    };
    let metadata: PeerMetadataRow[];
    let retriedInPage = false;
    try {
      metadata = await readRows();
    } catch (error) {
      if (session.platform !== 'wise' || !await isLiveSession(session)) throw error;
      // One retry, using the actual logged-in tab's cookie context. No payment
      // requests are sent: this replays only the intercepted history query.
      retriedInPage = true;
      metadata = await readRows(true);
    }
    if (!retriedInPage && session.platform === 'wise' && !metadata.some((row) => !row.hidden)
      && await isLiveSession(session)) {
      metadata = await readRows(true);
    }
    if (!metadata.some((row) => !row.hidden)) {
      throw new Error(unusableRowsMessage(session.platform, metadata as import('../templates/types.js').ExtractedRow[]));
    }
    if (!await isLiveSession(session)) return;
    // Inline templates require explicit approval before any result is posted.
    if (session.inline && !session.inlineApproved) {
      if (!await updateLiveSession(session, 'awaiting_approval')) return;
      const approved = await openPrompt({
        kind: 'inline-template',
        origin: session.origin,
        detail: {
          platform: session.platform,
          actionType: session.actionType,
          rows: metadata.length,
          paramNames: session.template.paramNames,
        },
      });
      if (!approved) {
        throw new Error('Capture declined');
      }
    }

    if (!await isLiveSession(session)) return;
    // Encrypt the captured session material in the offscreen document.
    const sessionMaterial: Record<string, string> = { ...session.captured.headers };
    if (session.captured.body) sessionMaterial.body = session.captured.body;
    const { encryptedSessionMaterial } = await offscreenCall<{ encryptedSessionMaterial: string }>(
      'encrypt-buyer-tee',
      {
        platform: session.actionPlatform ?? session.platform,
        actionType: session.attestationActionType,
        attestationServiceUrl: session.attestationServiceUrl,
        sessionMaterial,
      },
    );

    if (!await isLiveSession(session)) return;
    const firstParams = metadata.find((row) => !row.hidden)?.params as Record<string, unknown> ?? {};
    deliver(session, {
      requestId: session.requestId,
      platform: session.platform,
      actionPlatform: session.actionPlatform ?? session.platform,
      actionType: session.attestationActionType,
      metadata,
      expiresAt: session.expiresAt,
      buyerTeeCapture: { encryptedSessionMaterial, params: firstParams },
    });
    await wipeSession(requestId);
    await finishProviderTab(session);
  } catch (error) {
    if (!await isLiveSession(session)) return;
    await wipeSession(requestId);
    deliverError(session, captureErrorMessage(error, session.captured));
    await finishProviderTab(session);
  }
}

export const BUYER_METADATA_EVENT = busEvent('peer-capture', PEER_TYPES.metadataMessage);
