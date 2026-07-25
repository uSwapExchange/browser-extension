/**
 * The page-facing Peer contract this extension implements, per
 * https://docs.peer.xyz/developer/build-your-own-extension — kept
 * dependency-free because the MAIN-world script bundles it.
 */

export type PeerConnectionStatus = 'connected' | 'disconnected' | 'pending';

export type PeerCaptureMode = 'buyerTee' | 'sellerCredential';

export interface PeerAuthenticateParams {
  /** Template action, e.g. `transfer_venmo`. */
  actionType: string;
  /** Platform name, e.g. `venmo`. */
  platform: string;
  captureMode: PeerCaptureMode;
  attestationServiceUrl?: string;
  /** Override when the attestation schema differs from the capture template. */
  attestationActionType?: string;
  /** Inline provider template — requires explicit user approval before results post. */
  providerConfig?: unknown;
}

export interface PeerMetadataRow {
  [key: string]: unknown;
  originalIndex?: number;
  hidden?: boolean;
}

export interface PeerBuyerTeeCapture {
  encryptedSessionMaterial: string;
  params: Record<string, unknown>;
}

export interface PeerSarCredentialCapture {
  credentialBundle: unknown;
  offchainId: string;
}

export interface PeerMetadataMessage {
  requestId: string;
  platform: string;
  metadata: PeerMetadataRow[];
  expiresAt: number;
  buyerTeeCapture?: PeerBuyerTeeCapture;
  sarCredentialCapture?: PeerSarCredentialCapture;
  error?: string;
}

export interface PeerPageApi {
  getVersion(): Promise<string>;
  requestConnection(): Promise<boolean>;
  checkConnectionStatus(): Promise<PeerConnectionStatus>;
  authenticate(params: PeerAuthenticateParams): void;
  onMetadataMessage(callback: (message: PeerMetadataMessage) => void): () => void;
}

/** Bus message types served by the peer-capture module. */
export const PEER_TYPES = {
  getVersion: 'getVersion',
  requestConnection: 'requestConnection',
  checkConnectionStatus: 'checkConnectionStatus',
  authenticate: 'authenticate',
  /** SW -> page event carrying a PeerMetadataMessage. */
  metadataMessage: 'metadataMessage',
} as const;
