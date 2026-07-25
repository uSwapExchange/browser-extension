/**
 * Build target injected by Vite from EXT_TARGET. The default remains Chrome so
 * existing release commands retain their behavior.
 */
declare const __EXT_TARGET__: 'chrome' | 'firefox';

export const EXT_TARGET: 'chrome' | 'firefox' =
  typeof __EXT_TARGET__ === 'undefined' ? 'chrome' : __EXT_TARGET__;

export const IS_FIREFOX = EXT_TARGET === 'firefox';
export const IS_CHROME = EXT_TARGET === 'chrome';
