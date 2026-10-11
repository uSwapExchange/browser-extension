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
import { captureTarget, validateAttestationUrl } from './templates/target.js';
import { clearReplayRules } from './capture/replay.js';
import { hostsForPlatform } from './templates/platforms.js';
import {
  clearCaptureRequestCache,
  registerInterceptor,
  setCaptureCompleteHandler,
  setProviderActivityHandler,
} from './capture/interceptor.js';
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
import { clearMetadataPrimeState, primeMetadataRequest } from './capture/prime.js';

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
const authenticating = new Set<string>();
let replayRulesReady: Promise<void> = Promise.resolve();

function deliverMetadata(session: CaptureSession, message: PeerMetadataMessage): void {
  if (message.error) message = { ...message, errorMessage: message.error };
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
  if (!params || typeof params.platform !== 'string' || typeof params.actionType !== 'string') {
    throw new Error('Payment platform and actionType are required');
  }
  const target = captureTarget(params.platform, params.actionType);
  await replayRulesReady;
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
  const attestationServiceUrl = validateAttestationUrl(suppliedAttestationUrl || DEFAULT_ATTESTATION_SERVICE_URL, origin);

  await ensurePlatformPermission(target.permissionPlatform, origin);
  const { template, inline } = await resolveTemplate({
    platform: target.platform,
    actionType: target.actionType,
    permissionPlatform: target.permissionPlatform,
    providerConfig: params.providerConfig,
  });

  if (inline) {
    const approved = await openPrompt({ kind: 'inline-template', origin, detail: {
      platform: params.platform, actionType: target.actionType, beforeCapture: true,
    } });
    if (!approved) throw new Error('Custom capture declined');
  }
  if (!isFirstPartySender(sender) && !await isOriginGranted(origin)) {
    throw new Error('Connection was revoked during capture setup');
  }
  const sessions = await listSessions();
  if (sessions.filter((session) => session.connectionKey !== connectionKey).length >= 8) {
    throw new Error('Too many active payment captures. Finish or cancel one, then retry.');
  }
  const superseded = sessions
    .filter((session) => session.connectionKey === connectionKey);
  await Promise.all(superseded.map(async (session) => {
    clearCaptureRequestCache(session.requestId);
    clearMetadataPrimeState(session.requestId);
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
    actionPlatform: target.platform,
    actionType: target.actionType,
    attestationActionType: params.attestationActionType?.trim() || target.actionType,
    captureMode: params.captureMode,
    attestationServiceUrl,
    template,
    inline,
    inlineApproved: inline,
    firstParty: isFirstPartySender(sender),
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
    clearCaptureRequestCache(session.requestId);
    clearMetadataPrimeState(session.requestId);
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
      clearCaptureRequestCache(session.requestId);
      clearMetadataPrimeState(session.requestId);
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
      clearMetadataPrimeState(session.requestId);
      if (session.captureMode === 'buyerTee') {
        void runBuyerCapture(session.requestId);
      } else {
        void runSellerCapture(session.requestId);
      }
    });
    setProviderActivityHandler(async (session, context) => {
      await primeMetadataRequest(session, context);
    });
    replayRulesReady = clearReplayRules().catch(() => console.warn('[peer-capture] replay rule cleanup failed'));
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
        await primeMetadataRequest(session).catch((error) => {
          console.warn(
            '[peer-capture] initial template metadata prime failed',
            error instanceof Error ? error.message : String(error),
          );
        });
      })();
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      void (async () => {
        const session = await findAnySessionByAuthTab(tabId);
        if (!session) return;
        clearCaptureRequestCache(session.requestId);
        clearMetadataPrimeState(session.requestId);
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
      const key = connKeyForSender(sender);
      if (!key || authenticating.has(key)) throw new Error('A capture request is already being opened');
      authenticating.add(key);
      try {
        await startAuthenticate(payload as PeerAuthenticateParams, sender);
        return { accepted: true };
      } finally { authenticating.delete(key); }
    },
  },
};
