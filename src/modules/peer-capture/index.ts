import type { ExtensionModule, ModuleContext } from '../../core/modules/registry.js';
import { busEvent, connKeyForSender } from '../../core/bus/protocol.js';
import { FIRST_PARTY_ORIGIN, isFirstPartySender } from '../../core/sender.js';
import { extensionVersion } from '../../core/version.js';
import { hasOpenPrompt, openPrompt } from '../../core/consent/prompt.js';
import { isOriginGranted } from '../../core/storage/origin-grants.js';
import {
  PEER_TYPES,
  type PeerAuthenticateParams,
  type PeerConnectionStatus,
  type PeerMetadataMessage,
} from './api-contract.js';
import { resolveTemplate } from './templates/fetch.js';
import { hostsForPlatform } from './templates/platforms.js';
import { registerInterceptor, setCaptureCompleteHandler } from './capture/interceptor.js';
import {
  putSession,
  wipeSession,
  listSessions,
  findAnySessionByAuthTab,
  type CaptureSession,
} from './capture/session.js';
import { runBuyerCapture, setBuyerDeliver } from './flows/buyer.js';
import { installUserInputGuide } from './capture/user-input.js';
import { runSellerCapture, setSellerDeliver } from './flows/seller.js';

const CAPTURE_TTL_MS = 10 * 60 * 1000;
const EXPIRY_ALARM = 'peer-capture:expiry';
const DEFAULT_ATTESTATION_SERVICE_URL = 'https://attestation-service.zkp2p.xyz';

function senderOrigin(sender: chrome.runtime.MessageSender): string {
  if (isFirstPartySender(sender)) return FIRST_PARTY_ORIGIN;
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : null);
  if (!origin) throw new Error('Cannot resolve sender origin');
  return origin;
}

let ctx: ModuleContext | null = null;

function deliverMetadata(session: CaptureSession, message: PeerMetadataMessage): void {
  ctx?.pushToConnection(session.connectionKey, busEvent('peer-capture', PEER_TYPES.metadataMessage, message));
}

async function ensurePlatformPermission(platform: string, origin: string): Promise<void> {
  const hosts = hostsForPlatform(platform);
  if (!hosts || hosts.baked) return;
  const granted = await chrome.permissions.contains({ origins: hosts.patterns });
  if (granted) return;
  // The optional permission must be requested from a user gesture; route it
  // through the consent popup which calls chrome.permissions.request on click.
  const approved = await openPrompt({
    kind: 'platform-permission',
    origin,
    detail: { platform, patterns: hosts.patterns },
  });
  if (!approved) throw new Error(`Permission for ${platform} was declined`);
}

async function startAuthenticate(params: PeerAuthenticateParams, sender: chrome.runtime.MessageSender): Promise<void> {
  const origin = senderOrigin(sender);
  const connectionKey = connKeyForSender(sender);
  if (!connectionKey) throw new Error('authenticate must originate from a page');
  if (!isFirstPartySender(sender) && !(await isOriginGranted(origin))) {
    throw new Error('Origin is not connected — call requestConnection() first');
  }
  if (params.captureMode !== 'buyerTee' && params.captureMode !== 'sellerCredential') {
    throw new Error('Unsupported Peer capture mode');
  }
  if (
    params.captureMode === 'sellerCredential'
    && params.platform !== 'venmo'
    && params.platform !== 'cashapp'
  ) {
    throw new Error(`Seller credential capture is not supported for ${params.platform}`);
  }
  const suppliedAttestationUrl = params.attestationServiceUrl?.trim().replace(/\/+$/, '');
  if (params.captureMode === 'buyerTee' && !suppliedAttestationUrl) {
    throw new Error('buyerTee capture requires attestationServiceUrl');
  }
  const attestationServiceUrl = suppliedAttestationUrl || DEFAULT_ATTESTATION_SERVICE_URL;

  await ensurePlatformPermission(params.platform, origin);
  const { template, inline } = await resolveTemplate({
    platform: params.platform,
    actionType: params.actionType,
    providerConfig: params.providerConfig,
  });

  const superseded = (await listSessions())
    .filter((session) => session.connectionKey === connectionKey);
  await Promise.all(superseded.map(async (session) => {
    await wipeSession(session.requestId);
    if (session.authTabId != null) {
      try { await chrome.tabs.remove(session.authTabId); } catch { /* already closed */ }
    }
  }));
  // Create a stable tab first, persist the matching session, THEN navigate.
  // Fast SPAs such as Revolut can issue their transactions request before
  // chrome.tabs.create({ url }) resolves; storing after navigation loses that
  // only request and leaves the page waiting for the full capture TTL.
  const authTab = await chrome.tabs.create({ url: 'about:blank' });
  if (authTab.id == null) throw new Error('Could not open the payment provider tab');
  const now = Date.now();
  const session: CaptureSession = {
    requestId: crypto.randomUUID(),
    connectionKey,
    origin,
    platform: params.platform,
    actionType: params.actionType,
    attestationActionType: params.attestationActionType?.trim() || params.actionType,
    captureMode: params.captureMode,
    attestationServiceUrl,
    template,
    inline,
    sourceTabId: sender.tab?.id ?? null,
    authTabId: authTab.id,
    status: 'awaiting_request',
    captured: null,
    createdAt: now,
    expiresAt: now + CAPTURE_TTL_MS,
  };
  await putSession(session);
  try {
    await chrome.tabs.update(authTab.id, { url: template.authLink });
    await chrome.alarms.create(EXPIRY_ALARM, { periodInMinutes: 1 });
  } catch (error) {
    await wipeSession(session.requestId);
    try { await chrome.tabs.remove(authTab.id); } catch { /* already closed */ }
    throw error;
  }
}

async function maybeInstallUserInputGuide(session: CaptureSession): Promise<void> {
  const userInput = session.template.metadata.userInput;
  if (!userInput || session.authTabId == null) return;
  try {
    await installUserInputGuide(session.authTabId, userInput);
  } catch {
    // The page may still be navigating. tabs.onUpdated retries on completion.
  }
}

async function sweepExpired(): Promise<void> {
  const now = Date.now();
  for (const session of await listSessions()) {
    if (session.expiresAt <= now) {
      await wipeSession(session.requestId);
      deliverMetadata(session, {
        requestId: session.requestId,
        platform: session.platform,
        metadata: [],
        expiresAt: session.expiresAt,
        error: 'Capture timed out',
      });
      if (session.authTabId != null) {
        try { await chrome.tabs.remove(session.authTabId); } catch { /* already closed */ }
      }
    }
  }
}

export const peerCaptureModule: ExtensionModule = {
  id: 'peer-capture',
  init(context) {
    ctx = context;
    setBuyerDeliver(deliverMetadata);
    setSellerDeliver(deliverMetadata);
    setCaptureCompleteHandler((session) => {
      if (session.captureMode === 'buyerTee') {
        void runBuyerCapture(session.requestId);
      } else {
        void runSellerCapture(session.requestId);
      }
    });
    registerInterceptor();
    // Payment-platform hosts are optional permissions granted on demand. A
    // webRequest listener registered before the grant won't observe the new
    // host until it's re-added — so re-register whenever a permission is added.
    // Without this, the FIRST capture on a freshly-granted platform (e.g. the
    // user's first Cash App buy) silently never fires.
    chrome.permissions.onAdded.addListener(() => registerInterceptor());
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === EXPIRY_ALARM) void sweepExpired();
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status !== 'complete') return;
      void (async () => {
        const session = await findAnySessionByAuthTab(tabId);
        if (session?.status !== 'awaiting_request') return;
        await maybeInstallUserInputGuide(session);
      })();
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      void (async () => {
        const session = await findAnySessionByAuthTab(tabId);
        if (!session) return;
        await wipeSession(session.requestId);
        deliverMetadata(session, {
          requestId: session.requestId,
          platform: session.template.metadata.platform,
          metadata: [],
          expiresAt: Date.now(),
          error: 'Provider authentication was cancelled',
        });
      })();
    });
  },
  handlers: {
    async [PEER_TYPES.getVersion]() {
      return extensionVersion();
    },

    async [PEER_TYPES.checkConnectionStatus](_payload, sender): Promise<PeerConnectionStatus> {
      if (isFirstPartySender(sender)) return 'connected';
      const origin = senderOrigin(sender);
      if (await isOriginGranted(origin)) return 'connected';
      if (await hasOpenPrompt(origin, 'connect')) return 'pending';
      return 'disconnected';
    },

    async [PEER_TYPES.requestConnection](_payload, sender): Promise<boolean> {
      if (isFirstPartySender(sender)) return true;
      const origin = senderOrigin(sender);
      if (await isOriginGranted(origin)) return true;
      return openPrompt({ kind: 'connect', origin });
    },

    async [PEER_TYPES.authenticate](payload, sender): Promise<{ accepted: true }> {
      await startAuthenticate(payload as PeerAuthenticateParams, sender);
      return { accepted: true };
    },
  },
};
