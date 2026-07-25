import { describe, expect, it } from 'bun:test';
import venmoTemplate from './fixtures/venmo_transfer_venmo.json';
import { resolveMetadataPayload } from '../src/modules/peer-capture/capture/metadata-engine.js';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';
import type { CapturedRequest } from '../src/modules/peer-capture/capture/session.js';
import type { ReplayResult } from '../src/modules/peer-capture/capture/replay.js';

const context: CapturedRequest = {
  url: 'https://provider.example/api/context?cursor=1',
  method: 'GET',
  headers: { Authorization: 'Bearer secret' },
  body: '',
  statusCode: 200,
  timestamp: 1,
  contextKind: 'fallback',
};

function result(status = 200, text = '[{"id":"payment-1"}]'): ReplayResult {
  return {
    status,
    text,
    json: JSON.parse(text),
    headers: { 'content-type': 'application/json' },
  };
}

describe('resolveMetadataPayload', () => {
  it('uses fallback as auth context and replays metadataUrl in the provider tab', async () => {
    const template = parseProviderTemplate({
      ...venmoTemplate,
      url: 'https://provider.example/api/metadata',
      metadata: {
        ...venmoTemplate.metadata,
        platform: 'example',
        metadataUrl: 'https://provider.example/api/metadata',
        metadataUrlMethod: 'GET',
        metadataUrlBody: '',
        shouldReplayRequestInPage: true,
      },
    });
    const calls: unknown[] = [];
    const payload = await resolveMetadataPayload({
      context,
      template,
      authTabId: 17,
    }, async (request, options) => {
      calls.push({ request, options });
      return result();
    });

    expect(calls).toEqual([{
      request: {
        ...context,
        url: 'https://provider.example/api/metadata',
        method: 'GET',
        body: '',
      },
      options: { inPage: true, tabId: 17 },
    }]);
    expect(payload.parsed.json).toEqual([{ id: 'payment-1' }]);
  });

  it('replays the selected request when metadataUrl is absent', async () => {
    const template = parseProviderTemplate({
      ...venmoTemplate,
      authLink: 'https://provider.example/login',
      url: context.url,
      metadata: {
        ...venmoTemplate.metadata,
        platform: 'example',
        urlRegex: '^https://provider\\.example/api/context',
      },
    });
    const calls: CapturedRequest[] = [];
    await resolveMetadataPayload({
      context,
      template,
      authTabId: 17,
    }, async (request) => {
      calls.push(request);
      return result();
    });
    expect(calls).toEqual([context]);
  });

  it('rejects a non-successful replay before extraction', async () => {
    const template = parseProviderTemplate({
      ...venmoTemplate,
      authLink: 'https://provider.example/login',
      url: context.url,
      metadata: {
        ...venmoTemplate.metadata,
        platform: 'example',
      },
    });
    expect(resolveMetadataPayload({
      context,
      template,
      authTabId: 17,
    }, async () => result(401))).rejects.toThrow('Replay failed (HTTP 401)');
  });
});

