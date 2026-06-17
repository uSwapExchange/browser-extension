/**
 * Trust helpers for classifying chrome.runtime message senders.
 *
 * The extension's own pages (side panel / sidebar, options, prompt) are
 * first-party: they ARE the uSwap surface, so they don't go through the
 * website connection-consent gate that external pages do. Everything else
 * (content-script relays for app.uswap.net, payment-platform tabs) is
 * attributed to its real web origin.
 */

/**
 * True when the message came from one of the extension's own pages rather than
 * a content script or web page. Extension pages carry a `chrome-extension://`
 * (`moz-extension://`) sender url; content scripts carry the http(s) page url.
 */
export function isFirstPartySender(sender: chrome.runtime.MessageSender): boolean {
  const url = sender.url ?? sender.tab?.url;
  return !!url && url.startsWith(chrome.runtime.getURL(''));
}

/**
 * Origin attributed to first-party surfaces. The side panel hosts the uSwap web
 * app, so capture sessions opened from it carry a meaningful payment origin
 * instead of `chrome-extension://<id>`.
 */
export const FIRST_PARTY_ORIGIN = 'https://app.uswap.net';
