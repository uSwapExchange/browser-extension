import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

/**
 * One manifest source, two MV3 targets. `EXT_TARGET=firefox` switches only the
 * surfaces Firefox genuinely implements differently: sidebar, event-page
 * background, in-background crypto, and explicit app-origin host access.
 */
const IS_FIREFOX = process.env.EXT_TARGET === 'firefox';

const USWAP_APP_ORIGINS = [
  'https://app.uswap.net/*',
  'https://v4-staging.uswap.net/*',
  'https://uswap.net/*',
  // WebExtension match patterns do not include ports; this covers every local
  // Vite/dev-server port, including the usual :5173.
  'http://localhost/*',
];

const BASE_PERMISSIONS = [
  'storage',
  'webRequest',
  'declarativeNetRequest',
  'alarms',
  // Revolut marks its transactions template shouldReplayRequestInPage; execute
  // that authenticated replay inside the already user-approved provider tab.
  'scripting',
];
const permissions = IS_FIREFOX
  ? BASE_PERMISSIONS
  : [...BASE_PERMISSIONS, 'sidePanel', 'offscreen'];

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
  name: 'uSwap — Anything in, anything out',
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
            // `data_collection_permissions` is supported on both desktop and
            // Android from Firefox 142. Keeping the manifest honest avoids an
            // install range the AMO validator cannot actually guarantee.
            strict_min_version: '142.0',
            data_collection_permissions: {
              required: ['financialAndPaymentInfo'],
            },
          },
        },
      }
    : {}),
  host_permissions: [
    // Firefox requires an explicit host grant before it injects the app relay.
    ...(IS_FIREFOX ? USWAP_APP_ORIGINS : []),
    'https://api.zkp2p.xyz/*',
    'https://*.zkp2p.xyz/*',
    'https://*.peer.xyz/*',
  ],
  optional_host_permissions: [
    'https://*.venmo.com/*',
    'https://*.cash.app/*',
    'https://*.cashapp.com/*',
    'https://*.revolut.com/*',
    'https://*.wise.com/*',
    'https://*.paypal.com/*',
    'https://*.mercadopago.com/*',
    'https://*.mercadopago.com.ar/*',
    'https://*.monzo.com/*',
    'https://*.n26.com/*',
    'https://*.alipay.com/*',
    'https://*.chime.com/*',
    'https://*.luxon.com/*',
    'https://*.chase.com/*',
    'https://*.bankofamerica.com/*',
    'https://*.citi.com/*',
  ],
  web_accessible_resources: webAccessibleResources,
  content_scripts: [
    {
      // Import-free classic relay. The app owns window.peer and installs it
      // only after this relay (tab) or the panel page answers the handshake.
      matches: USWAP_APP_ORIGINS,
      js: ['src/content/peer-relay.content.ts'],
      run_at: 'document_start',
      all_frames: true,
    },
  ],
});
