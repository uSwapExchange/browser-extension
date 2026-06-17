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
  supersedeForConnection,
  wipeSession,
  listSessions,
  type CaptureSession,
} from './capture/session.js';
import { runBuyerCapture, setBuyerDeliver } from './flows/buyer.js';

const CAPTURE_TTL_MS = 10 * 60 * 1000;
const EXPIRY_ALARM = 'peer-capture:expiry';

function senderOrigin(sender: chrome.runtime.MessageSender): string {
  // First-party surfaces (the side panel hosting the app) are attributed to the
  // canonical app origin, not chrome-extension://<id>.
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
  // Route by connection (documentId), not tab — the uSwap app may be running in
  // the Firefox sidebar / side panel, which isn't a tab.
  const connectionKey = connKeyForSender(sender);
  if (!connectionKey) throw new Error('authenticate must originate from a page');
  // First-party surfaces (the side panel) are implicitly connected — the website
  // consent gate only applies to external pages calling window.peer.
  if (!isFirstPartySender(sender) && !(await isOriginGranted(origin))) {
    throw new Error('Origin is not connected — call requestConnection() first');
  }

  await ensurePlatformPermission(params.platform, origin);
  const { template, inline } = await resolveTemplate({
    platform: params.platform,
    actionType: params.actionType,
    providerConfig: params.providerConfig,
  });

  await supersedeForConnection(connectionKey);
  const authTab = await chrome.tabs.create({ url: template.authLink });
  const now = Date.now();
  const session: CaptureSession = {
    requestId: crypto.randomUUID(),
    connectionKey,
    origin,
    platform: params.platform,
    actionType: params.actionType,
    captureMode: params.captureMode,
    attestationServiceUrl: params.attestationServiceUrl ?? '',
    template,
    inline,
    authTabId: authTab.id ?? null,
    status: 'awaiting_request',
    captured: null,
    createdAt: now,
    expiresAt: now + CAPTURE_TTL_MS,
  };
  await putSession(session);
  await chrome.alarms.create(EXPIRY_ALARM, { periodInMinutes: 1 });
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
    }
  }
}

export const peerCaptureModule: ExtensionModule = {
  id: 'peer-capture',
  init(context) {
    ctx = context;
    setBuyerDeliver(deliverMetadata);
    setCaptureCompleteHandler((session) => {
      if (session.captureMode === 'buyerTee') {
        void runBuyerCapture(session.requestId);
      }
      // sellerCredential capture is handled by the seller flow (added later).
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
