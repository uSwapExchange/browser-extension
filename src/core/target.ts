/**
 * Build target, injected by Vite (`define.__EXT_TARGET__`) from the
 * `EXT_TARGET` env var. Lets a single source tree produce both the Chrome
 * (MV3 service worker + offscreen + sidePanel) and Firefox (MV3 event page +
 * in-background crypto + sidebar_action) builds, with the unused branch
 * dead-code-eliminated at build time.
 *
 * Default is 'chrome' so the shipped Chrome build is never affected by the
 * Firefox work — `EXT_TARGET=firefox` is opt-in.
 */
declare const __EXT_TARGET__: 'chrome' | 'firefox';

export const EXT_TARGET: 'chrome' | 'firefox' =
  typeof __EXT_TARGET__ === 'undefined' ? 'chrome' : __EXT_TARGET__;

export const IS_FIREFOX = EXT_TARGET === 'firefox';
export const IS_CHROME = EXT_TARGET === 'chrome';
