import {
  TAB_PORT_NAME,
  busErr,
  isBusEvent,
  isBusRequest,
} from '../core/bus/protocol.js';

/**
 * Side-panel relay. The panel is an extension page that hosts the uSwap web app
 * in a cross-origin iframe. Rather than relying on a content script injecting
 * `window.peer` into that iframe (which Firefox does NOT do for an app frame
 * whose parent is a moz-extension:// page), the panel page itself relays the
 * peer bus between the iframe and the background:
 *
 *   app iframe  ⇄ window.postMessage ⇄  panel page (this)  ⇄ chrome.runtime ⇄  background
 *
 * This is the SAME transport on Chrome and Firefox — no script injection, no
 * content-script-in-iframe dependency. See AGENTS.md ("Cross-browser parity").
 *
 * The handshake (`hello`) tells the embedded app to install its parent-bridge
 * `window.peer`. The app only trusts a `hello` from a chrome-extension:// /
 * moz-extension:// origin, which a web page cannot spoof.
 */

const HANDSHAKE = '__uswapPeerBridge';

export function installPeerBridge(iframe: HTMLIFrameElement, appOrigin: string): void {
  const origin = new URL(appOrigin).origin;

  // Long-lived port: lets the background push events (capture metadata) to this
  // panel connection. Opened eagerly so the background learns the connection
  // before the first call.
  let port: chrome.runtime.Port | null = null;
  function ensurePort(): chrome.runtime.Port {
    if (port) return port;
    const next = chrome.runtime.connect({ name: TAB_PORT_NAME });
    next.onMessage.addListener((message: unknown) => {
      if (isBusEvent(message)) iframe.contentWindow?.postMessage(message, origin);
    });
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
    });
    port = next;
    return next;
  }
  ensurePort();

  // Requests from the embedded app → background → response back to the app.
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.origin !== origin) return;
    const data: unknown = event.data;
    // Handshake: the app asks who its parent is; re-announce so it installs the
    // panel transport regardless of hello/load ordering.
    if (data && typeof data === 'object' && (data as Record<string, unknown>)[HANDSHAKE] === 'syn') {
      sayHello();
      return;
    }
    if (!isBusRequest(data)) return;
    ensurePort();
    chrome.runtime.sendMessage(data).then(
      (response: unknown) => iframe.contentWindow?.postMessage(response, origin),
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        iframe.contentWindow?.postMessage(busErr(data.id, text), origin);
      },
    );
  });

  // Tell the app to install its parent-bridge window.peer. Re-sent on every load
  // (e.g. iframe reload) — the app re-installs idempotently.
  function sayHello(): void {
    iframe.contentWindow?.postMessage({ [HANDSHAKE]: 'hello' }, origin);
  }
  iframe.addEventListener('load', sayHello);
  if (iframe.contentWindow) sayHello();
}
