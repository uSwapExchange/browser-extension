import { createModuleContext, startBusRouter } from '../core/bus/router.js';
import { registerModules } from '../core/modules/registry.js';
import { lockSessionStorageToTrustedContexts } from '../core/storage/session-state.js';
import { coreModule } from '../modules/core-module.js';
import { peerCaptureModule } from '../modules/peer-capture/index.js';
import { IS_FIREFOX } from '../core/target.js';

// MV3 rule: every chrome.*/browser.* event listener must be registered
// synchronously in the first event-loop turn so events wake the worker/event page.

startBusRouter();
registerModules(createModuleContext(), [coreModule, peerCaptureModule]);

// Toolbar icon opens the main uSwap surface.
if (IS_FIREFOX) {
  // Firefox has no sidePanel API — the surface is a sidebar_action panel.
  // Wire the toolbar button to toggle it (must be a sync call in onClicked).
  const ff = globalThis as unknown as {
    browser?: {
      action?: { onClicked?: { addListener(cb: () => void): void } };
      sidebarAction?: { toggle(): void };
    };
  };
  ff.browser?.action?.onClicked?.addListener(() => {
    ff.browser?.sidebarAction?.toggle();
  });
} else {
  // Chrome: the side panel opens on action click.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => { /* pre-114 Chrome: side panel unavailable */ });
}

void lockSessionStorageToTrustedContexts();
