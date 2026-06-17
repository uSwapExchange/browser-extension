import {
  TAB_PORT_NAME,
  busErr,
  busOk,
  connKeyForSender,
  isBusRequest,
  type BusEvent,
} from './protocol.js';
import { resolveHandler, type ModuleContext } from '../modules/registry.js';

/**
 * Background side of the bus: dispatches BusRequests to module handlers and
 * tracks the long-lived relay Port per CONNECTION (documentId) so modules can
 * push events (e.g. metadata messages) back to exactly the frame that called
 * window.peer. Keyed by connection — not tab — so it works from the Firefox
 * sidebar / side panel, which isn't a tab.
 *
 * Everything here must be wired synchronously at top level so webRequest/runtime
 * events wake the worker / event page.
 */

const connPorts = new Map<string, chrome.runtime.Port>();

export function pushToConnection(connectionKey: string, event: BusEvent): boolean {
  const port = connPorts.get(connectionKey);
  if (!port) return false;
  try {
    port.postMessage(event);
    return true;
  } catch {
    connPorts.delete(connectionKey);
    return false;
  }
}

export function createModuleContext(): ModuleContext {
  return { pushToConnection };
}

export function startBusRouter(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== TAB_PORT_NAME) return;
    const key = port.sender ? connKeyForSender(port.sender) : null;
    if (!key) {
      port.disconnect();
      return;
    }
    connPorts.set(key, port);
    port.onDisconnect.addListener(() => {
      if (connPorts.get(key) === port) connPorts.delete(key);
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isBusRequest(message)) return undefined;
    const handler = resolveHandler(message.module, message.type);
    if (!handler) {
      sendResponse(busErr(message.id, `Unknown message ${message.module}:${message.type}`));
      return undefined;
    }
    handler(message.payload, sender)
      .then((payload) => sendResponse(busOk(message.id, payload)))
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        sendResponse(busErr(message.id, text));
      });
    return true; // keep sendResponse alive for the async handler
  });
}
