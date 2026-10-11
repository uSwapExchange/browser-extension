import { sessionGet, sessionKeys, sessionRemove, sessionSet } from '../../../core/storage/session-state.js';
import type { ProviderTemplate } from '../templates/types.js';
import type { PeerCaptureMode } from '../api-contract.js';

/**
 * Per-capture session state, memory-backed in chrome.storage.session. Holds
 * transient material only and is wiped on completion/expiry. One active
 * session per originating document connection.
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
  responseHeaders?: Record<string, string>;
  statusCode?: number;
  timestamp?: number;
  contextKind?: 'primary' | 'fallback';
}

export interface CaptureSession {
  requestId: string;
  connectionKey: string;
  origin: string;
  platform: string;
  actionPlatform?: string;
  actionType: string;
  attestationActionType: string;
  captureMode: PeerCaptureMode;
  attestationServiceUrl: string;
  template: ProviderTemplate;
  inline: boolean;
  inlineApproved?: boolean;
  firstParty?: boolean;
  sourceTabId: number | null;
  authTabId: number | null;
  status: CaptureStatus;
  captured: CapturedRequest | null;
  createdAt: number;
  expiresAt: number;
}

const PREFIX = 'capture:';
const key = (requestId: string) => PREFIX + requestId;
let mutations: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutations.then(fn, fn);
  mutations = result.catch(() => {});
  return result;
}

export async function putSession(session: CaptureSession): Promise<void> {
  await mutate(() => sessionSet(key(session.requestId), session));
}

/** Status changes cannot resurrect a cancelled capture. */
export function updateLiveSession(session: CaptureSession, status: CaptureStatus): Promise<boolean> {
  return mutate(async () => {
    const current = await getSession(session.requestId);
    if (!current || current.expiresAt <= Date.now()) return false;
    await sessionSet(key(session.requestId), { ...current, status });
    return true;
  });
}

export function captureRequest(session: CaptureSession, captured: CapturedRequest): Promise<CaptureSession | null> {
  return mutate(async () => {
    const current = await getSession(session.requestId);
    if (!current || current.status !== 'awaiting_request' || current.expiresAt <= Date.now()) return null;
    const updated: CaptureSession = { ...current, captured, status: 'captured' };
    await sessionSet(key(session.requestId), updated);
    return updated;
  });
}

export async function getSession(requestId: string): Promise<CaptureSession | null> {
  return sessionGet<CaptureSession>(key(requestId));
}

/** Recheck after every asynchronous boundary before publishing a result. */
export async function isLiveSession(session: CaptureSession): Promise<boolean> {
  const current = await getSession(session.requestId);
  if (!current || current.expiresAt <= Date.now()) return false;
  const { isOriginGranted } = await import('../../../core/storage/origin-grants.js');
  return current.connectionKey === session.connectionKey && (session.firstParty === true || await isOriginGranted(session.origin));
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

export async function findAnySessionByAuthTab(tabId: number): Promise<CaptureSession | null> {
  const sessions = await listSessions();
  return sessions.find((s) => s.authTabId === tabId) ?? null;
}

export async function wipeSession(requestId: string): Promise<void> {
  await mutate(() => sessionRemove(key(requestId)));
}

/** Remove any existing session for a connection — a new authenticate supersedes it. */
export async function supersedeForConnection(connectionKey: string): Promise<void> {
  const sessions = await listSessions();
  await Promise.all(
    sessions.filter((s) => s.connectionKey === connectionKey).map((s) => wipeSession(s.requestId)),
  );
}
