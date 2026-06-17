/**
 * Typed message envelopes shared by every leg of the extension:
 * page <-> content (window.postMessage) and content/popup/options/sidepanel/
 * offscreen <-> service worker (chrome.runtime messaging).
 */

export const BUS_CHANNEL = 'uswap-ext' as const;

export type ModuleId = 'core' | 'peer-capture' | 'checkout-pay' | 'context-bridge';

export interface BusRequest {
  channel: typeof BUS_CHANNEL;
  kind: 'req';
  id: string;
  module: ModuleId;
  type: string;
  payload?: unknown;
}

export interface BusResponse {
  channel: typeof BUS_CHANNEL;
  kind: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface BusEvent {
  channel: typeof BUS_CHANNEL;
  kind: 'event';
  module: ModuleId;
  type: string;
  payload?: unknown;
}

export type BusMessage = BusRequest | BusResponse | BusEvent;

export const TAB_PORT_NAME = 'uswap-ext:tab';

/**
 * Stable per-connection routing key for a content-script sender (port OR
 * message). The relay opens its port and sends requests from the SAME document,
 * so both carry the same key — letting the background route events back to the
 * exact frame that called window.peer.
 *
 * Keyed by `documentId` (present on Chrome 106+/Firefox 106+ for content scripts
 * in tabs AND in extension-page iframes like the side panel / sidebar), which is
 * why this works where the old tab.id keying didn't: the Firefox sidebar isn't a
 * tab, so `sender.tab` is undefined there. Falls back to tab+frame for any
 * context that somehow lacks documentId.
 */
export function connKeyForSender(sender: chrome.runtime.MessageSender): string | null {
  const documentId = (sender as { documentId?: string }).documentId;
  if (documentId) return `doc:${documentId}`;
  if (typeof sender.tab?.id === 'number') return `tab:${sender.tab.id}:${sender.frameId ?? 0}`;
  // Extension pages (side panel / sidebar / options) have no tab and — on older
  // engines — may lack documentId. They have a stable extension-origin url, and
  // there is only one of each surface, so the url is a sound routing key. This
  // is what lets the side-panel relay receive pushed events on both browsers.
  if (sender.url) return `url:${sender.url}`;
  return null;
}

export function newBusId(): string {
  return crypto.randomUUID();
}

export function isBusMessage(value: unknown): value is BusMessage {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { channel?: unknown }).channel === BUS_CHANNEL
    && typeof (value as { kind?: unknown }).kind === 'string'
  );
}

export function isBusRequest(value: unknown): value is BusRequest {
  return isBusMessage(value) && value.kind === 'req';
}

export function isBusResponse(value: unknown): value is BusResponse {
  return isBusMessage(value) && value.kind === 'res';
}

export function isBusEvent(value: unknown): value is BusEvent {
  return isBusMessage(value) && value.kind === 'event';
}

export function busOk(id: string, payload?: unknown): BusResponse {
  return { channel: BUS_CHANNEL, kind: 'res', id, ok: true, payload };
}

export function busErr(id: string, error: string): BusResponse {
  return { channel: BUS_CHANNEL, kind: 'res', id, ok: false, error };
}

export function busEvent(module: ModuleId, type: string, payload?: unknown): BusEvent {
  return { channel: BUS_CHANNEL, kind: 'event', module, type, payload };
}
