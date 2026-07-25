/**
 * Platform → host match patterns. Used to (a) scope webRequest interception
 * and (b) decide which optional_host_permissions to request at first use.
 *
 * ALL payment-platform hosts are optional_host_permissions, granted on demand
 * at first capture — the install prompt never asks for access to the user's
 * payment accounts. `baked` is reserved for hosts that ever live in manifest
 * host_permissions (none today).
 */

export interface PlatformHosts {
  /** chrome match patterns for the platform's capture domains. */
  patterns: string[];
  /** True when the host is already in manifest host_permissions. */
  baked: boolean;
}

export const PLATFORM_HOSTS: Record<string, PlatformHosts> = {
  venmo: { patterns: ['https://*.venmo.com/*'], baked: false },
  cashapp: { patterns: ['https://*.cash.app/*', 'https://*.cashapp.com/*'], baked: false },
  revolut: { patterns: ['https://*.revolut.com/*'], baked: false },
  wise: { patterns: ['https://*.wise.com/*'], baked: false },
  paypal: { patterns: ['https://*.paypal.com/*'], baked: false },
  mercadopago: {
    patterns: ['https://*.mercadopago.com/*', 'https://*.mercadopago.com.ar/*'],
    baked: false,
  },
  monzo: { patterns: ['https://*.monzo.com/*'], baked: false },
  n26: { patterns: ['https://*.n26.com/*'], baked: false },
  alipay: { patterns: ['https://*.alipay.com/*'], baked: false },
  chime: { patterns: ['https://*.chime.com/*'], baked: false },
  luxon: { patterns: ['https://*.luxon.com/*'], baked: false },
  'zelle-chase': { patterns: ['https://*.chase.com/*'], baked: false },
  'zelle-bofa': { patterns: ['https://*.bankofamerica.com/*'], baked: false },
  'zelle-citi': { patterns: ['https://*.citi.com/*'], baked: false },
};

export function hostsForPlatform(platform: string): PlatformHosts | null {
  return PLATFORM_HOSTS[platform] ?? null;
}

/** Match patterns for every known platform — the webRequest filter superset. */
export function allCapturePatterns(): string[] {
  const set = new Set<string>();
  for (const entry of Object.values(PLATFORM_HOSTS)) {
    for (const pattern of entry.patterns) set.add(pattern);
  }
  return [...set];
}
