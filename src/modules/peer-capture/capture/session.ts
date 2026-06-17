import { sessionGet, sessionKeys, sessionRemove, sessionSet } from '../../../core/storage/session-state.js';
import type { ProviderTemplate } from '../templates/types.js';
import type { PeerCaptureMode } from '../api-contract.js';

/**
 * Per-capture session state, memory-backed in chrome.storage.session. Holds
 * transient material only and is wiped on completion/expiry. One active
 * session per origin tab.
 */

export type CaptureStatus =
  | 'awaiting_request'
  | 'captured'
  | 'extracting'
  | 'awaiting_approval'
  | 'delivered'
  | 'failed';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface CaptureSession {
  requestId: string;
  /** Routing key of the frame that called authenticate (connKeyForSender). */
  connectionKey: string;
  origin: string;
  platform: string;
  actionType: string;
  captureMode: PeerCaptureMode;
  attestationServiceUrl: string;
  template: ProviderTemplate;
  inline: boolean;
  authTabId: number | null;
  status: CaptureStatus;
  captured: CapturedRequest | null;
  createdAt: number;
  expiresAt: number;
}

const PREFIX = 'capture:';
const key = (requestId: string) => PREFIX + requestId;

export async function putSession(session: CaptureSession): Promise<void> {
  await sessionSet(key(session.requestId), session);
}

export async function getSession(requestId: string): Promise<CaptureSession | null> {
  return sessionGet<CaptureSession>(key(requestId));
}

export async function listSessions(): Promise<CaptureSession[]> {
  const keys = await sessionKeys(PREFIX);
  const sessions = await Promise.all(keys.map((k) => sessionGet<CaptureSession>(k)));
  return sessions.filter((s): s is CaptureSession => s !== null);
}

export async function findSessionByAuthTab(tabId: number): Promise<CaptureSession | null> {
  const sessions = await listSessions();
  return sessions.find((s) => s.authTabId === tabId && s.status === 'awaiting_request') ?? null;
}

export async function wipeSession(requestId: string): Promise<void> {
  await sessionRemove(key(requestId));
}

/** Remove any existing session for a connection — a new authenticate supersedes it. */
export async function supersedeForConnection(connectionKey: string): Promise<void> {
  const sessions = await listSessions();
  await Promise.all(
    sessions.filter((s) => s.connectionKey === connectionKey).map((s) => wipeSession(s.requestId)),
  );
}
