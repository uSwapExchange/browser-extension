import type { ProviderTemplate } from '../templates/types.js';
import type { CapturedRequest } from './session.js';
import { parseReplayPayload } from './extract.js';
import {
  replayRequest,
  resolveReplayRequest,
  type ReplayResult,
} from './replay.js';

export interface MetadataPayload {
  request: CapturedRequest;
  response: ReplayResult;
  parsed: {
    text: string;
    json: unknown;
  };
}

export type MetadataReplay = (
  request: CapturedRequest,
  options: { inPage?: boolean; tabId?: number | null },
) => Promise<ReplayResult>;

/**
 * Resolve the provider response exactly as Peer's metadata engine does:
 *
 * - the selected primary/fallback request is authenticated context;
 * - metadataUrl, when configured, becomes the canonical replay target;
 * - shouldReplayRequestInPage chooses the authenticated-tab replay adapter;
 * - preprocessRegex is applied before extraction.
 */
export async function resolveMetadataPayload(
  input: {
    context: CapturedRequest;
    template: ProviderTemplate;
    authTabId: number | null;
  },
  replay: MetadataReplay = replayRequest,
): Promise<MetadataPayload> {
  const request = resolveReplayRequest(input.context, input.template);
  const response = await replay(request, {
    inPage: input.template.metadata.shouldReplayRequestInPage === true,
    tabId: input.authTabId,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Replay failed (HTTP ${response.status})`);
  }
  const parsed = parseReplayPayload(
    response.text,
    input.template.metadata.preprocessRegex,
  );
  return { request, response, parsed };
}

