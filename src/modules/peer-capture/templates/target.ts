import { hostsForPlatform } from './platforms.js';

/** Bank aliases used by older callers; Peer serves these under zelle/. */
export function captureTarget(platform: string, actionType: string) {
  const bank = platform.startsWith('zelle-') ? platform.slice(6)
    : platform === 'zelle' ? actionType.replace(/^transfer_zelle_/, '') : null;
  if (bank !== null) {
    if (!['citi', 'chase', 'bofa'].includes(bank)
      || ![`transfer_${bank}`, `transfer_zelle_${bank}`].includes(actionType)) {
      throw new Error('Unsupported Zelle bank/action');
    }
    return { platform: 'zelle', actionType: `transfer_zelle_${bank}`, permissionPlatform: `zelle-${bank}` };
  }
  const actions = [`transfer_${platform}`, `register_${platform}`];
  if (platform === 'paypal') actions.push('transfer_business_paypal', 'register_business_paypal');
  if (platform === 'upi') actions.push('transfer_upi_amazonpay', 'register_upi_amazonpay');
  if (!hostsForPlatform(platform) || !actions.includes(actionType)) {
    throw new Error('Unsupported payment platform/action');
  }
  return { platform, actionType, permissionPlatform: platform };
}

export function isPlatformUrl(platform: string, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    return (hostsForPlatform(platform)?.patterns ?? []).some((pattern) => {
      const wildcard = pattern.startsWith('https://*.');
      const domain = pattern.replace(/^https:\/\/(?:\*\.)?/, '').replace(/\/\*$/, '');
      return url.hostname === domain || (wildcard && url.hostname.endsWith(`.${domain}`));
    });
  } catch { return false; }
}

/** A connected website must not choose the key that encrypts account cookies. */
export function validateAttestationUrl(rawUrl: string, sourceOrigin: string): string {
  const url = new URL(rawUrl);
  const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  const trusted = url.hostname === 'attestation-service.zkp2p.xyz'
    || url.hostname === 'attestation-service-staging.zkp2p.xyz'
    || url.hostname === 'uswap.net' || url.hostname.endsWith('.uswap.net');
  const local = loopback(url.hostname) && loopback(new URL(sourceOrigin).hostname);
  if (url.username || url.password || url.search || url.hash
    || (!trusted && !local) || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('Untrusted attestation service URL');
  }
  return url.toString().replace(/\/+$/, '');
}
