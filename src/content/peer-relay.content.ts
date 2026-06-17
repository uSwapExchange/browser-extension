/**
 * ISOLATED-world relay for app tabs: bridges window.postMessage (the app's
 * window.peer, defined by the app itself — NOT injected by us) to the
 * background. The SW treats sender.origin/sender.tab as authoritative; nothing
 * security-relevant is taken from page payloads.
 *
 * The app owns window.peer and talks to whichever transport answers its
 * handshake (this relay in a tab, or the side-panel page in the panel). We
 * announce `relay-ready` so the app installs window.peer over this same-window
 * channel. No script injection, no MAIN-world content script.
 *
 * SELF-CONTAINED ON PURPOSE: this file imports nothing. crxjs splits any
 * content script with ES imports into a loader that does a dynamic `import()`,
 * which fails silently in Firefox's content-script sandbox (the script then
 * never runs). With zero imports crxjs emits a single classic script that runs
 * on both engines. Keep the bus constants/guards inlined below in sync with
 * core/bus/protocol.ts.
 */

const BUS_CHANNEL = 'uswap-ext';
const TAB_PORT_NAME = 'uswap-ext:tab';
const HANDSHAKE = '__uswapPeerBridge';

interface BusMsg { channel?: unknown; kind?: unknown; id?: unknown }
function isBusMessage(v: unknown): v is BusMsg {
  return typeof v === 'object' && v !== null && (v as BusMsg).channel === BUS_CHANNEL && typeof (v as BusMsg).kind === 'string';
}
function isBusRequest(v: unknown): v is { id: string } {
  return isBusMessage(v) && (v as BusMsg).kind === 'req';
}
function isBusEvent(v: unknown): boolean {
  return isBusMessage(v) && (v as BusMsg).kind === 'event';
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

// Open the port immediately so the SW learns tabId -> origin and can push
// events even before the first page call.
ensurePort();

function announceReady(): void {
  window.postMessage({ [HANDSHAKE]: 'relay-ready' }, window.location.origin);
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data: unknown = event.data;

  // Handshake: the app asks whether a relay is present; announce ourselves so it
  // installs window.peer over this transport.
  if (data && typeof data === 'object' && (data as Record<string, unknown>)[HANDSHAKE] === 'syn') {
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

// Proactively announce once in case the app's handshake listener is already up
// (the app also retries `syn`, so delivery doesn't depend on this).
announceReady();
