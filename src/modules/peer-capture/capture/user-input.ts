import type { ProviderTemplate } from '../templates/types.js';

type UserInput = NonNullable<ProviderTemplate['metadata']['userInput']>;

/**
 * Minimal provider-tab guide for templates that require the user to open a
 * transaction before the matching detail request exists (currently Chime).
 * It runs in the isolated world, touches only the configured XPath matches,
 * and never reads or returns page data.
 */
export async function installUserInputGuide(
  tabId: number,
  userInput: UserInput,
): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (
      promptText: string,
      transactionXpath: string,
      waitForXpathMs: number,
      pollIntervalMs: number,
    ) => {
      const OVERLAY_ID = 'uswap-peer-transaction-guide';
      const MARKER = 'data-uswap-peer-guide';
      document.getElementById(OVERLAY_ID)?.remove();

      const overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      Object.assign(overlay.style, {
        position: 'fixed',
        top: '18px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        maxWidth: 'min(520px, calc(100vw - 32px))',
        padding: '12px 16px',
        borderRadius: '12px',
        border: '1px solid rgba(125, 145, 255, .7)',
        background: 'rgba(12, 18, 35, .96)',
        boxShadow: '0 12px 36px rgba(0, 0, 0, .35)',
        color: '#fff',
        font: '600 14px/1.4 system-ui, sans-serif',
        textAlign: 'center',
      });
      overlay.textContent = promptText || 'Select the payment you want to verify.';
      document.documentElement.appendChild(overlay);

      const clear = () => {
        document.querySelectorAll(`[${MARKER}]`).forEach((element) => {
          const html = element as HTMLElement;
          html.style.removeProperty('outline');
          html.style.removeProperty('outline-offset');
          html.removeAttribute(MARKER);
        });
        overlay.remove();
      };

      const visible = (element: Element): element is HTMLElement => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        const style = getComputedStyle(html);
        return (
          rect.width > 0
          && rect.height > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none'
        );
      };

      const startedAt = Date.now();
      const poll = () => {
        let result: XPathResult;
        try {
          result = document.evaluate(
            transactionXpath,
            document,
            null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null,
          );
        } catch {
          overlay.textContent = 'This payment provider guide could not be loaded.';
          return;
        }

        let found = false;
        for (let index = 0; index < result.snapshotLength; index += 1) {
          const element = result.snapshotItem(index);
          if (!(element instanceof Element) || !visible(element)) continue;
          found = true;
          if (element.hasAttribute(MARKER)) continue;
          element.setAttribute(MARKER, 'true');
          const html = element as HTMLElement;
          html.style.setProperty('outline', '2px solid #7d91ff', 'important');
          html.style.setProperty('outline-offset', '3px', 'important');
          element.addEventListener('click', () => setTimeout(clear, 250), { once: true });
        }

        if (found) return;
        if (Date.now() - startedAt < waitForXpathMs) {
          setTimeout(poll, pollIntervalMs);
        }
      };
      poll();
    },
    args: [
      userInput.promptText ?? 'Select the payment you want to verify.',
      userInput.transactionXpath,
      userInput.waitForXpathMs ?? 8_000,
      Math.max(50, userInput.pollIntervalMs ?? 250),
    ],
  });
}
