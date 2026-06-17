import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

/**
 * Single source of truth for the extension manifest, target-aware.
 *
 * `EXT_TARGET=firefox` switches the surface differences that crxjs's `browser`
 * option does NOT handle for us:
 *   - side_panel (Chrome) → sidebar_action (Firefox has no sidePanel API)
 *   - drop `sidePanel` + `offscreen` permissions (Firefox has neither; its
 *     event-page background runs the @zkp2p crypto/DOM work directly)
 *   - drop the offscreen web_accessible_resource
 *   - add browser_specific_settings.gecko (id + strict_min_version 128 for
 *     world:'MAIN' content scripts + DNR modifyHeaders)
 * crxjs (`browser: 'firefox'`) converts background.service_worker → an event
 * page automatically.
 *
 * Permission ownership (audit map):
 * - storage                  core      origin connection grants (local) + capture sessions (session)
 * - sidePanel                core      main surface hosting the uSwap app (Chrome only)
 * - webRequest               peer-capture   observe platform request headers/bodies (non-blocking)
 * - declarativeNetRequest    peer-capture   inject captured forbidden headers on replay fetches
 * - offscreen                peer-capture   @zkp2p/sdk crypto + HTML/XPath host (Chrome only)
 * - alarms                   peer-capture   capture-session expiry/garbage collection
 */

const IS_FIREFOX = process.env.EXT_TARGET === 'firefox';

const USWAP_APP_ORIGINS = [
  'https://app.uswap.net/*',
  'https://v4-staging.uswap.net/*',
  'https://uswap.net/*',
  'http://localhost:5173/*',
];

const BASE_PERMISSIONS = ['storage', 'webRequest', 'declarativeNetRequest', 'alarms'];
// sidePanel + offscreen are Chrome-only surfaces; Firefox uses sidebar_action +
// in-background crypto, so it needs neither permission.
const permissions = IS_FIREFOX ? BASE_PERMISSIONS : [...BASE_PERMISSIONS, 'sidePanel', 'offscreen'];

const panelSurface = IS_FIREFOX
  ? {
      sidebar_action: {
        default_panel: 'src/sidepanel/index.html',
        default_title: 'uSwap',
        default_icon: { 36: 'icons/36.png', 48: 'icons/48.png' },
      },
    }
  : {
      side_panel: {
        default_path: 'src/sidepanel/index.html',
      },
    };

// Firefox has no offscreen document; the background event page hosts the crypto
// directly, so the offscreen web-accessible resource is Chrome-only. Firefox
// needs no web-accessible resources at all (window.peer is app-owned — nothing
// is injected from an extension URL).
const webAccessibleResources = IS_FIREFOX
  ? []
  : [
      {
        resources: ['src/offscreen/offscreen.html'],
        matches: ['https://app.uswap.net/*'],
      },
    ];

export default defineManifest({
  manifest_version: 3,
  // Firefox/AMO caps `name` at 45 chars; Chrome allows the longer marketing
  // name. Keep both on-brand.
  name: IS_FIREFOX
    ? 'uSwap — Anything in, anything out'
    : 'uSwap — Anything in, anything out: Verify Payments Securely',
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
  ...panelSurface,
  options_page: 'src/options/index.html',
  // Chrome MV3 = service worker; Firefox MV3 = non-persistent event page
  // (background.scripts). Same entry module, different host.
  background: (IS_FIREFOX
    ? { scripts: ['src/background/index.ts'], type: 'module' }
    : { service_worker: 'src/background/index.ts', type: 'module' }) as
      | { service_worker: string; type: 'module' }
      | { scripts: string[]; type: 'module' },
  permissions,
  ...(IS_FIREFOX
    ? {
        browser_specific_settings: {
          gecko: {
            id: 'extension@uswap.net',
            strict_min_version: '128.0',
            // Mozilla-required disclosure (FF 128+). The extension reads
            // payment-platform page data to build the payment proof, so we
            // declare the financial category — even though the plaintext never
            // leaves the extension (only a TEE-encrypted attestation blob goes to
            // the zkp2p attestation service, never to uSwap). The encryption /
            // local-only processing is explained in the AMO reviewer notes.
            data_collection_permissions: {
              required: ['financialAndPaymentInfo'],
            },
          },
        },
      }
    : {}),
  host_permissions: [
    // Firefox MV3 only injects the relay content script on origins it holds a
    // host permission for (Chrome injects from content_scripts.matches alone, so
    // adding these there would only bloat the install prompt). Firefox-only.
    ...(IS_FIREFOX ? USWAP_APP_ORIGINS : []),
    // peer-capture: provider templates + attestation service (required — these
    // are uSwap/Peer endpoints, not the user's payment accounts).
    'https://api.zkp2p.xyz/*',
    'https://*.zkp2p.xyz/*',
    'https://*.peer.xyz/*',
  ],
  optional_host_permissions: [
    // Payment-platform capture domains: requested on-demand at first capture
    // (the platform-permission consent prompt → permissions.request), so the
    // install prompt never asks for access to the user's payment accounts.
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
  web_accessible_resources: webAccessibleResources,
  content_scripts: [
    {
      // ISOLATED relay only. window.peer is defined by the APP (packages/web),
      // not injected here — it talks to this relay (tab) or the side-panel page
      // (panel) over postMessage. No MAIN-world content script, no injection;
      // identical on Chrome and Firefox.
      matches: USWAP_APP_ORIGINS,
      js: ['src/content/peer-relay.content.ts'],
      run_at: 'document_start',
      all_frames: true,
    },
  ],
});
