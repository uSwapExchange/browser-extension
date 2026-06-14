import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

/**
 * Single source of truth for the extension manifest.
 *
 * Permission ownership (audit map):
 * - storage                  core      origin connection grants (local) + capture sessions (session)
 * - sidePanel                core      main surface hosting the uSwap app
 * - webRequest               peer-capture   observe platform request headers/bodies (non-blocking)
 * - declarativeNetRequest    peer-capture   inject captured forbidden headers on replay fetches
 * - offscreen                peer-capture   @zkp2p/sdk crypto + HTML/XPath extraction host
 * - alarms                   peer-capture   capture-session expiry/garbage collection
 */

const USWAP_APP_ORIGINS = [
  'https://app.uswap.net/*',
  'https://v4-staging.uswap.net/*',
  'https://uswap.net/*',
  'http://localhost:5173/*',
];

export default defineManifest({
  manifest_version: 3,
  name: 'uSwap — Anything in, anything out: Verify Payments Securely',
  version: pkg.version,
  description: 'uSwap in your browser — instant crypto swaps, fiat onramp payment capture, and checkout tools.',
  icons: {
    36: 'icons/36.png',
    48: 'icons/48.png',
    144: 'icons/144.png',
  },
  action: {
    default_title: 'uSwap',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: [
    'storage',
    'sidePanel',
    'webRequest',
    'declarativeNetRequest',
    'offscreen',
    'alarms',
  ],
  host_permissions: [
    // peer-capture: provider templates + attestation service (required — these
    // are uSwap/Peer endpoints, not the user's payment accounts).
    'https://api.zkp2p.xyz/*',
    'https://*.zkp2p.xyz/*',
    'https://*.peer.xyz/*',
  ],
  optional_host_permissions: [
    // Payment-platform capture domains: requested on-demand at first capture
    // (the platform-permission consent prompt → chrome.permissions.request), so
    // the install prompt never asks for access to the user's payment accounts.
    'https://*.venmo.com/*',
    'https://*.cash.app/*',
    'https://*.cashapp.com/*',
    'https://*.revolut.com/*',
    'https://*.wise.com/*',
    'https://*.paypal.com/*',
    'https://*.mercadopago.com/*',
    'https://*.chime.com/*',
    // Zelle is bank-mediated
    'https://*.chase.com/*',
    'https://*.bankofamerica.com/*',
    'https://*.citi.com/*',
  ],
  web_accessible_resources: [
    {
      resources: ['src/offscreen/offscreen.html'],
      matches: ['https://app.uswap.net/*'],
    },
  ],
  content_scripts: [
    {
      matches: USWAP_APP_ORIGINS,
      js: ['src/content/peer-relay.content.ts'],
      run_at: 'document_start',
      all_frames: true,
    },
    {
      matches: USWAP_APP_ORIGINS,
      js: ['src/content/peer-page-api.main.ts'],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN', // Chrome 111+

    },
  ],
});
