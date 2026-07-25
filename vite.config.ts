import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.js';

const TARGET: 'chrome' | 'firefox' =
  process.env.EXT_TARGET === 'firefox' ? 'firefox' : 'chrome';

export default defineConfig({
  define: {
    __EXT_TARGET__: JSON.stringify(TARGET),
  },
  plugins: [react(), crx({ manifest, browser: TARGET })],
  build: {
    outDir: TARGET === 'firefox' ? 'dist/firefox' : 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        sidepanel: 'src/sidepanel/index.html',
        prompt: 'src/prompt/index.html',
        options: 'src/options/index.html',
        // Firefox runs the shared crypto/DOM handlers in its background event
        // page, so only Chrome needs the offscreen document build input.
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
