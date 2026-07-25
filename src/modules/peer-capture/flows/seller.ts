import { offscreenCall } from '../../../core/offscreen/rpc.js';
import { openPrompt } from '../../../core/consent/prompt.js';
import {
  getSession,
  putSession,
  wipeSession,
  type CaptureSession,
} from '../capture/session.js';
import { resolveMetadataPayload } from '../capture/metadata-engine.js';
import type { PeerMetadataMessage } from '../api-contract.js';

type DeliverFn = (session: CaptureSession, message: PeerMetadataMessage) => void;
type SellerPayload = {
  payeeId: string;
  offchainId: string;
  sessionMaterial: Record<string, unknown>;
};

let deliver: DeliverFn = () => {};
export function setSellerDeliver(fn: DeliverFn): void {
  deliver = fn;
}

function header(headers: Record<string, string>, name: string): string | null {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key]?.trim() : '';
  return value || null;
}

function venmoPayload(
  session: CaptureSession,
  response: unknown,
): SellerPayload {
  if (!session.captured) throw new Error('Venmo capture is unavailable');
  const cookie = header(session.captured.headers, 'cookie');
  if (!cookie) throw new Error('No Venmo session cookie was captured');

  const accountId = new URL(session.captured.url).searchParams.get('externalId')?.trim();
  if (!accountId || !/^[0-9]+$/.test(accountId)) {
    throw new Error('Could not extract the Venmo account ID');
  }

  const stories = (
    response
    && typeof response === 'object'
    && Array.isArray((response as { stories?: unknown }).stories)
  ) ? (response as { stories: unknown[] }).stories : [];
  let username: string | null = null;
  for (const story of stories) {
    if (!story || typeof story !== 'object') continue;
    const title = (story as { title?: unknown }).title;
    if (!title || typeof title !== 'object') continue;
    for (const actor of [
      (title as { sender?: unknown }).sender,
      (title as { receiver?: unknown }).receiver,
    ]) {
      if (!actor || typeof actor !== 'object') continue;
      if (
        String((actor as { id?: unknown }).id) === accountId
        && typeof (actor as { username?: unknown }).username === 'string'
      ) {
        username = (actor as { username: string }).username.trim() || null;
      }
    }
  }
  if (!username) throw new Error('Could not extract the Venmo username');

  return {
    payeeId: accountId,
    offchainId: username,
    sessionMaterial: {
      accountId,
      recipientUsername: username,
      requestHeaders: session.captured.headers,
      sessionCookie: cookie,
    },
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cashAppPayload(
  session: CaptureSession,
  response: unknown,
): SellerPayload {
  if (!session.captured) throw new Error('Cash App capture is unavailable');
  const cookie = header(session.captured.headers, 'cookie');
  if (!cookie) throw new Error('No Cash App session cookie was captured');
  if (!session.captured.body) throw new Error('Cash App activity request payload is missing');

  const rows = (
    response
    && typeof response === 'object'
    && Array.isArray((response as { activity_rows?: unknown }).activity_rows)
  ) ? (response as { activity_rows: unknown[] }).activity_rows : [];

  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as {
      activity_item_global_id?: { primary_activity_token?: { token?: unknown } };
      payment_history_inputs_row?: { payment?: { render_data?: unknown } };
    };
    const token = stringValue(item.activity_item_global_id?.primary_activity_token?.token);
    if (token) ids.add(token);
    const render = stringValue(item.payment_history_inputs_row?.payment?.render_data);
    if (render) {
      try {
        const renderToken = stringValue(
          (JSON.parse(render) as { callerCustomerToken?: unknown }).callerCustomerToken,
        );
        if (renderToken) ids.add(renderToken);
      } catch { /* ignore malformed render metadata */ }
    }
  }
  if (ids.size !== 1) throw new Error('Cash App did not expose a stable customer ID');
  const customerId = [...ids][0]!;

  const cashtags = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const inputs = (row as {
      payment_history_inputs_row?: {
        sender?: { id?: unknown; cashtag?: unknown };
        recipient?: { id?: unknown; cashtag?: unknown };
      };
    }).payment_history_inputs_row;
    for (const actor of [inputs?.sender, inputs?.recipient]) {
      const id = stringValue(actor?.id);
      const cashtag = stringValue(actor?.cashtag)?.replace(/^\$/, '');
      if (cashtag && (id === customerId || id === 'C_SELF')) cashtags.add(cashtag);
    }
  }
  if (cashtags.size !== 1) throw new Error('Cash App did not expose a stable cashtag');
  const cashtag = [...cashtags][0]!;

  return {
    payeeId: cashtag,
    offchainId: cashtag,
    sessionMaterial: {
      customerId,
      recipientCashtag: cashtag,
      requestHeaders: session.captured.headers,
      requestPayload: session.captured.body,
      sessionCookie: cookie,
    },
  };
}

export function prepareSellerPayload(session: CaptureSession, response: unknown): SellerPayload {
  if (session.platform === 'venmo') return venmoPayload(session, response);
  if (session.platform === 'cashapp') return cashAppPayload(session, response);
  throw new Error(`Seller credential capture is not supported for ${session.platform}`);
}

async function finishProviderTab(session: CaptureSession): Promise<void> {
  if (session.sourceTabId != null) {
    try { await chrome.tabs.update(session.sourceTabId, { active: true }); } catch { /* source closed */ }
  }
  if (!session.template.metadata.shouldSkipCloseTab && session.authTabId != null) {
    try { await chrome.tabs.remove(session.authTabId); } catch { /* already closed */ }
  }
}

export async function runSellerCapture(requestId: string): Promise<void> {
  const session = await getSession(requestId);
  if (!session?.captured) return;

  try {
    await putSession({ ...session, status: 'extracting' });
    const metadata = await resolveMetadataPayload({
      context: session.captured,
      template: session.template,
      authTabId: session.authTabId,
    });
    if (metadata.parsed.json == null) {
      throw new Error('Provider response was not valid JSON');
    }
    const payload = prepareSellerPayload(session, metadata.parsed.json);

    if (session.inline) {
      await putSession({ ...session, status: 'awaiting_approval' });
      const approved = await openPrompt({
        kind: 'inline-template',
        origin: session.origin,
        detail: {
          platform: session.platform,
          actionType: session.actionType,
          rows: 0,
          paramNames: [],
        },
      });
      if (!approved) throw new Error('Capture declined');
    }

    const result = await offscreenCall<{ credentialBundle: unknown }>('create-seller-bundle', {
      platform: session.platform,
      attestationServiceUrl: session.attestationServiceUrl,
      payeeId: payload.payeeId,
      sessionMaterial: payload.sessionMaterial,
    });
    deliver(session, {
      requestId: session.requestId,
      platform: session.template.metadata.platform,
      metadata: [],
      expiresAt: session.expiresAt,
      sarCredentialCapture: {
        credentialBundle: result.credentialBundle,
        offchainId: payload.offchainId,
      },
    });
    await wipeSession(requestId);
    await finishProviderTab(session);
  } catch (error) {
    await wipeSession(requestId);
    deliver(session, {
      requestId: session.requestId,
      platform: session.template.metadata.platform,
      metadata: [],
      expiresAt: session.expiresAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
