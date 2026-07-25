/**
 * ISOLATED-world relay for app tabs. The app owns window.peer and installs it
 * after this relay answers the handshake.
 *
 * This file must remain import-free: CRXJS otherwise emits a dynamic-import
 * loader that Firefox cannot execute in the content-script sandbox.
 */

const BUS_CHANNEL = 'uswap-ext';
const TAB_PORT_NAME = 'uswap-ext:tab';
const HANDSHAKE = '__uswapPeerBridge';
const BRIDGE_PROTOCOL = 1;

interface BusMessage {
  channel?: unknown;
  kind?: unknown;
  id?: unknown;
}

function isBusMessage(value: unknown): value is BusMessage {
  return (
    typeof value === 'object'
    && value !== null
    && (value as BusMessage).channel === BUS_CHANNEL
    && typeof (value as BusMessage).kind === 'string'
  );
}

function isBusRequest(value: unknown): value is { id: string } {
  return isBusMessage(value) && value.kind === 'req' && typeof value.id === 'string';
}

function isBusEvent(value: unknown): boolean {
  return isBusMessage(value) && value.kind === 'event';
}

function busErr(id: string, error: string) {
  return { channel: BUS_CHANNEL, kind: 'res' as const, id, ok: false, error };
}

let port: chrome.runtime.Port | null = null;

function ensurePort(): chrome.runtime.Port {
  if (port) return port;
  const next = chrome.runtime.connect({ name: TAB_PORT_NAME });
  next.onMessage.addListener((message: unknown) => {
    if (isBusEvent(message)) {
      window.postMessage(message, window.location.origin);
    }
  });
  next.onDisconnect.addListener(() => {
    if (port === next) port = null;
  });
  port = next;
  return next;
}

// Open eagerly so pushed capture events can arrive before the first page call.
ensurePort();

function announceReady(): void {
  // Keep the legacy `relay-ready` value for the already-published Firefox
  // extension while making the protocol version explicit for future releases.
  window.postMessage(
    { [HANDSHAKE]: 'relay-ready', protocol: BRIDGE_PROTOCOL },
    window.location.origin,
  );
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data: unknown = event.data;

  if (
    data
    && typeof data === 'object'
    && (data as Record<string, unknown>)[HANDSHAKE] === 'syn'
  ) {
    announceReady();
    return;
  }

  if (!isBusRequest(data)) return;
  ensurePort();
  chrome.runtime.sendMessage(data).then(
    (response: unknown) => {
      window.postMessage(response, window.location.origin);
    },
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      window.postMessage(busErr(data.id, text), window.location.origin);
    },
  );
});

announceReady();
