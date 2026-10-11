import { sessionGet, sessionRemove, sessionSet } from '../storage/session-state.js';

/**
 * Consent prompts open a small extension window and resolve when the user
 * decides. Prompt records live in chrome.storage.session; the resolver map
 * is in-memory (an SW restart mid-prompt rejects the originating call —
 * callers simply re-request).
 */

export type PromptKind = 'connect' | 'inline-template' | 'platform-permission';

export interface PromptRecord {
  promptId: string;
  kind: PromptKind;
  origin: string;
  createdAt: number;
  /** Kind-specific display payload (e.g. inline template summary). */
  detail?: unknown;
}

const PROMPT_PREFIX = 'prompt:';
const PROMPT_TTL_MS = 5 * 60 * 1000;
const resolvers = new Map<string, (approved: boolean) => void>();

export async function openPrompt(record: Omit<PromptRecord, 'promptId' | 'createdAt'>): Promise<boolean> {
  const promptId = crypto.randomUUID();
  const full: PromptRecord = { ...record, promptId, createdAt: Date.now() };
  await sessionSet(PROMPT_PREFIX + promptId, full);

  // Install the resolver before opening the window: a fast response must not
  // race windows.create(). Closing the popup is also an explicit cancellation.
  let decide!: (approved: boolean) => void;
  const result = new Promise<boolean>((resolve) => { decide = resolve; });
  let windowId: number | undefined;
  const closed = (id: number) => {
    if (id === windowId) void resolvePrompt(promptId, false);
  };
  const timer = setTimeout(() => {
    void resolvePrompt(promptId, false);
    if (windowId != null) void chrome.windows.remove(windowId).catch(() => {});
  }, PROMPT_TTL_MS);
  resolvers.set(promptId, (approved) => {
    clearTimeout(timer);
    chrome.windows.onRemoved.removeListener(closed);
    decide(approved);
  });
  chrome.windows.onRemoved.addListener(closed);
  try {
    const url = chrome.runtime.getURL(`src/prompt/index.html#/${record.kind}?promptId=${promptId}`);
    const window = await chrome.windows.create({ url, type: 'popup', width: 400, height: 600, focused: true });
    windowId = window.id;
    // The user may already have answered before windows.create resolves.
    if (!resolvers.has(promptId) && windowId != null) {
      await chrome.windows.remove(windowId).catch(() => {});
    }
    return await result;
  } catch (error) {
    await resolvePrompt(promptId, false);
    throw error;
  }

}

export async function getPrompt(promptId: string): Promise<PromptRecord | null> {
  if (!resolvers.has(promptId)) return null;
  const record = await sessionGet<PromptRecord>(PROMPT_PREFIX + promptId);
  return record && Date.now() - record.createdAt < PROMPT_TTL_MS ? record : null;
}

export async function resolvePrompt(promptId: string, approved: boolean): Promise<void> {
  await sessionRemove(PROMPT_PREFIX + promptId);
  const resolve = resolvers.get(promptId);
  resolvers.delete(promptId);
  resolve?.(approved);
}

export async function hasOpenPrompt(origin: string, kind: PromptKind): Promise<boolean> {
  // Only consult in-memory resolvers; storage records without a resolver are
  // stale leftovers from an SW restart and must not report 'pending' forever.
  for (const promptId of resolvers.keys()) {
    const record = await getPrompt(promptId);
    if (record && record.origin === origin && record.kind === kind) return true;
  }
  return false;
}
