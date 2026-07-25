/**
 * True when a runtime message came from one of the extension's own pages,
 * rather than a content script running on a web origin.
 */
export function isFirstPartySender(sender: chrome.runtime.MessageSender): boolean {
  const url = sender.url ?? sender.tab?.url;
  return !!url && url.startsWith(chrome.runtime.getURL(''));
}

/** Origin attributed to the extension-owned panel which hosts the uSwap app. */
export const FIRST_PARTY_ORIGIN = 'https://app.uswap.net';
