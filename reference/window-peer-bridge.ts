/**
 * REFERENCE ONLY — not part of the extension build.
 *
 * This is the app-side half of the Peer `window.peer` contract: the uSwap web
 * app (app.uswap.net) defines `window.peer` itself and talks to this extension
 * over postMessage (the ISOLATED relay in a tab, or the side-panel page in the
 * panel). The extension injects NO script into the page. This file is included
 * verbatim from the uSwap web app so the full contract is auditable here.
 */

/**
 * Installs `window.peer` (the Peer page contract) when the uSwap browser
 * extension is present, over a postMessage bridge — no script injection. The
 * extension never injects window.peer into the page; the APP owns it. Two
 * transports, picked by where the app runs:
 *
 *   • Top-level TAB:    app ⇄ window.postMessage(self) ⇄ ISOLATED relay content
 *                       script ⇄ chrome.runtime ⇄ background. Handshake: the
 *                       relay answers our `syn` with `relay-ready`.
 *   • Extension PANEL:  app (cross-origin iframe) ⇄ window.parent (panel page)
 *                       ⇄ chrome.runtime ⇄ background. Handshake: the panel
 *                       answers our `syn` with `hello` (from its extension
 *                       origin).
 *
 * window.peer is installed ONLY after a valid handshake, so a plain tab with no
 * extension never gets a window.peer (isExtensionPresent() stays false). The
 * panel transport additionally requires the handshake to originate from a
 * chrome-extension:// / moz-extension:// origin — a web page cannot forge that,
 * so a malicious site embedding the app cannot impersonate the panel.
 */

import type { PeerAuthenticateParams, PeerMetadataMessage } from './peer-extension';

const BUS_CHANNEL = 'uswap-ext';
const MODULE = 'peer-capture';
const HANDSHAKE = '__uswapPeerBridge';
const METADATA_TYPE = 'metadataMessage';

interface BusResponse {
  channel: typeof BUS_CHANNEL;
  kind: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

interface BusEvent {
  channel: typeof BUS_CHANNEL;
  kind: 'event';
  module: string;
  type: string;
  payload?: unknown;
}

function isExtensionOrigin(origin: string): boolean {
  return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

/**
 * Install the bridge window.peer if the extension is present. Idempotent and
 * safe to call unconditionally at app startup; no-ops in a plain tab with no
 * extension (no relay answers the handshake).
 */
export function installPeerParentBridge(): void {
  if (typeof window === 'undefined') return;

  const embedded = window.parent !== window;
  // Where bus messages go once the handshake completes: the parent panel page
  // (embedded) or the same window where the ISOLATED relay listens (tab).
  let target: Window | null = null;
  let targetOrigin: string | null = null;
  let installed = false;

  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const metadataCallbacks = new Set<(message: PeerMetadataMessage) => void>();

  function post(message: unknown): void {
    if (target && targetOrigin) target.postMessage(message, targetOrigin);
  }

  function call<T>(type: string, payload?: unknown): Promise<T> {
    const id = newId();
    return new Promise<T>((resolve, reject) => {
      if (!target) {
        reject(new Error('uSwap extension bridge not ready'));
        return;
      }
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      post({ channel: BUS_CHANNEL, kind: 'req', id, module: MODULE, type, payload });
    });
  }

  function installWindowPeer(): void {
    if (installed) return;
    installed = true;
    // Authoritative: overwrite any prior window.peer so the bridge transport is
    // the single source of truth in both tab and panel.
    window.peer = {
      getVersion: () => call<string>('getVersion'),
      requestConnection: () => call<boolean>('requestConnection'),
      checkConnectionStatus: () => call<'connected' | 'disconnected' | 'pending'>('checkConnectionStatus'),
      authenticate: (params: PeerAuthenticateParams) => {
        void call('authenticate', params).catch((error: unknown) => {
          const message: PeerMetadataMessage = {
            requestId: 'error',
            platform: params.platform,
            metadata: [],
            expiresAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          };
          for (const cb of metadataCallbacks) {
            try { cb(message); } catch { /* ignore */ }
          }
        });
      },
      onMetadataMessage: (cb: (message: PeerMetadataMessage) => void) => {
        metadataCallbacks.add(cb);
        return () => metadataCallbacks.delete(cb);
      },
    };
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return;

    // Handshake.
    if (data[HANDSHAKE] === 'hello' && embedded && event.source === window.parent && isExtensionOrigin(event.origin)) {
      target = window.parent;
      targetOrigin = event.origin;
      installWindowPeer();
      post({ [HANDSHAKE]: 'ready' });
      return;
    }
    if (data[HANDSHAKE] === 'relay-ready' && !embedded && event.source === window && event.origin === window.location.origin) {
      target = window;
      targetOrigin = window.location.origin;
      installWindowPeer();
      return;
    }

    if (!target || event.origin !== targetOrigin || event.source !== target || data.channel !== BUS_CHANNEL) return;

    if (data.kind === 'res') {
      const res = data as unknown as BusResponse;
      const waiter = pending.get(res.id);
      if (!waiter) return;
      pending.delete(res.id);
      if (res.ok) waiter.resolve(res.payload);
      else waiter.reject(new Error(res.error ?? 'Extension call failed'));
      return;
    }

    if (data.kind === 'event') {
      const evt = data as unknown as BusEvent;
      if (evt.module === MODULE && evt.type === METADATA_TYPE) {
        const message = evt.payload as PeerMetadataMessage;
        for (const cb of metadataCallbacks) {
          try { cb(message); } catch { /* page callback errors are the page's problem */ }
        }
      }
    }
  });

  // Kick the handshake: ask the panel parent (embedded) or the same-window relay
  // (tab) to announce itself. Re-sent a few times to cover the relay/app load
  // order without depending on it.
  let syns = 0;
  const syn = (): void => {
    if (installed) return;
    if (embedded) window.parent.postMessage({ [HANDSHAKE]: 'syn' }, '*');
    else window.postMessage({ [HANDSHAKE]: 'syn' }, window.location.origin);
    syns += 1;
    if (syns < 10) setTimeout(syn, 150);
  };
  syn();
}
