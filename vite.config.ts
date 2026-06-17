import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.js';

// Build target: `EXT_TARGET=firefox bun run build` produces the Firefox build;
// default is Chrome so the shipped Chrome build is never affected. crxjs's
// `browser` option auto-adapts the MV3 manifest (service_worker → event-page
// scripts, etc.); manifest.config.ts handles the surface differences
// (sidebar_action vs side_panel, gecko id, dropped offscreen/sidePanel perms).
const TARGET: 'chrome' | 'firefox' =
  process.env.EXT_TARGET === 'firefox' ? 'firefox' : 'chrome';

export default defineConfig({
  define: {
    __EXT_TARGET__: JSON.stringify(TARGET),
  },
  plugins: [react(), crx({ manifest, browser: TARGET })],
  build: {
    // Keep Chrome at the existing `dist/` (the shipped flow + scripts/zip.ts
    // are unchanged); Firefox builds into `dist/firefox/`.
    outDir: TARGET === 'firefox' ? 'dist/firefox' : 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        sidepanel: 'src/sidepanel/index.html',
        prompt: 'src/prompt/index.html',
        options: 'src/options/index.html',
        // Chrome creates the offscreen document at runtime via chrome.offscreen
        // (not referenced from the manifest), so it must be an explicit build
        // input. Firefox has no offscreen — its event-page background runs the
        // same crypto/DOM work directly, so the input is omitted there.
        ...(TARGET === 'chrome' ? { offscreen: 'src/offscreen/offscreen.html' } : {}),
        harness: 'src/dev/harness.html',
      },
    },
  },
  server: {
    port: 5190,
    strictPort: true,
    hmr: { port: 5190 },
  },
});
