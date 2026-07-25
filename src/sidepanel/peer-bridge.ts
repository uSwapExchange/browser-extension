/**
 * Bridges the cross-origin uSwap iframe in the browser panel to the extension
 * background. This is the same transport on Chrome and Firefox.
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

export function installPeerBridge(iframe: HTMLIFrameElement, appUrl: string): () => void {
  const appOrigin = new URL(appUrl).origin;
  let port: chrome.runtime.Port | null = null;

  function ensurePort(): chrome.runtime.Port {
    if (port) return port;
    const next = chrome.runtime.connect({ name: TAB_PORT_NAME });
    next.onMessage.addListener((message: unknown) => {
      if (isBusEvent(message)) iframe.contentWindow?.postMessage(message, appOrigin);
    });
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
    });
    port = next;
    return next;
  }

  function sayHello(): void {
    iframe.contentWindow?.postMessage(
      { [HANDSHAKE]: 'hello', protocol: BRIDGE_PROTOCOL },
      appOrigin,
    );
  }

  function onMessage(event: MessageEvent): void {
    if (event.source !== iframe.contentWindow || event.origin !== appOrigin) return;
    const data: unknown = event.data;
    if (
      data
      && typeof data === 'object'
      && (data as Record<string, unknown>)[HANDSHAKE] === 'syn'
    ) {
      sayHello();
      return;
    }
    if (!isBusRequest(data)) return;
    ensurePort();
    chrome.runtime.sendMessage(data).then(
      (response: unknown) => iframe.contentWindow?.postMessage(response, appOrigin),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        iframe.contentWindow?.postMessage(busErr(data.id, message), appOrigin);
      },
    );
  }

  ensurePort();
  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', sayHello);
  sayHello();

  return () => {
    window.removeEventListener('message', onMessage);
    iframe.removeEventListener('load', sayHello);
    port?.disconnect();
    port = null;
  };
}
