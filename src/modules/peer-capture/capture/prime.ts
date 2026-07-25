import type { CaptureSession } from './session.js';

/**
 * Revolut's all-pockets page no longer reliably requests the legacy
 * transactions endpoint on its own. Buyer capture still needs one
 * authenticated request so webRequest can collect the real session headers
 * before the response is replayed and encrypted.
 *
 * Prime only Revolut. Other in-page providers may require a user-selected
 * transaction or a request body, so proactively calling their metadata URL
 * could change behavior.
 */
export function revolutCapturePrimeUrl(session: CaptureSession): string | null {
  if (
    session.platform !== 'revolut'
    || session.template.metadata.shouldReplayRequestInPage !== true
  ) {
    return null;
  }

  const rawUrl = session.template.metadata.metadataUrl?.trim();
  if (!rawUrl) return null;

  const target = new URL(rawUrl);
  const auth = new URL(session.template.authLink);
  if (target.protocol !== 'https:' || target.host !== auth.host) {
    throw new Error(
      `Unsafe Revolut capture URL: expected HTTPS on ${auth.host}, received ${target.protocol}//${target.host}`,
    );
  }
  return target.toString();
}

export async function primeRevolutCapture(session: CaptureSession): Promise<void> {
  const url = revolutCapturePrimeUrl(session);
  if (!url || session.authTabId == null) return;

  const providerTab = await chrome.tabs.get(session.authTabId);
  if (!providerTab.url) return;
  const current = new URL(providerTab.url);
  const auth = new URL(session.template.authLink);
  // Do not hit an authenticated API while the user is still on Revolut's
  // login/verification route. The eventual navigation back to /home produces
  // another tabs.onUpdated("complete") event and retries safely.
  if (current.origin !== auth.origin || current.pathname !== auth.pathname) return;

  const results = await chrome.scripting.executeScript({
    target: { tabId: session.authTabId },
    // This is the same isolated, same-origin execution context used by replay.
    // It receives the provider tab's cookie jar without exposing anything to
    // the provider page.
    world: 'ISOLATED',
    func: async (metadataUrl: string) => {
      const response = await fetch(metadataUrl, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });
      // Consume the body so the request completes normally. The interceptor
      // captures request headers; the existing replay path reads the response.
      await response.arrayBuffer();
      return response.status;
    },
    args: [url],
  });

  if (results[0]?.result == null) {
    throw new Error('Revolut capture request did not return a result');
  }
}
