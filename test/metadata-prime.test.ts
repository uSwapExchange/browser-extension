import { describe, expect, it } from 'bun:test';
import revolutTemplateJson from './fixtures/revolut_transfer_revolut.json';
import {
  clearMetadataPrimeState,
  primeMetadataRequest,
} from '../src/modules/peer-capture/capture/prime.js';
import type { ReplayResult } from '../src/modules/peer-capture/capture/replay.js';
import type {
  CapturedRequest,
  CaptureSession,
} from '../src/modules/peer-capture/capture/session.js';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';

function session(): CaptureSession {
  return {
    requestId: 'capture-1',
    connectionKey: 'connection-1',
    origin: 'https://app.uswap.net',
    platform: 'revolut',
    actionType: 'transfer_revolut',
    attestationActionType: 'transfer_revolut',
    captureMode: 'buyerTee',
    attestationServiceUrl: 'https://attestation-service.zkp2p.xyz',
    template: parseProviderTemplate(revolutTemplateJson),
    inline: false,
    sourceTabId: 1,
    authTabId: 7,
    status: 'awaiting_request',
    captured: null,
    createdAt: 1,
    expiresAt: 2,
  };
}

function response(status: number): ReplayResult {
  return { status, text: '[]', json: [], headers: {} };
}

describe('metadata request priming', () => {
  it('replays the exact template URL in the authenticated tab', async () => {
    const calls: unknown[] = [];
    const capture = session();
    await primeMetadataRequest(capture, undefined, async (request, options) => {
      calls.push({ request, options });
      return response(200);
    });

    expect(calls).toEqual([{
      request: expect.objectContaining({
        url: revolutTemplateJson.metadata.metadataUrl,
        method: 'GET',
      }),
      options: { inPage: true, tabId: 7 },
    }]);
    expect((calls[0] as { request: CapturedRequest }).request.url)
      .not.toContain('replay_request');
    clearMetadataPrimeState(capture.requestId);
  });

  it('deduplicates one auth context but retries after credentials change', async () => {
    const capture = session();
    const first: CapturedRequest = {
      url: 'https://app.revolut.com/api/retail/user/current',
      method: 'GET',
      headers: { Authorization: 'Bearer old' },
      body: '',
    };
    const refreshed: CapturedRequest = {
      ...first,
      headers: { Authorization: 'Bearer new' },
    };
    let calls = 0;
    const replay = async () => {
      calls += 1;
      return response(401);
    };

    await primeMetadataRequest(capture, first, replay);
    await primeMetadataRequest(capture, first, replay);
    await primeMetadataRequest(capture, refreshed, replay);

    expect(calls).toBe(2);
    clearMetadataPrimeState(capture.requestId);
  });

  it('allows a transient script failure to retry the same context', async () => {
    const capture = session();
    const context: CapturedRequest = {
      url: 'https://app.revolut.com/api/retail/user/current',
      method: 'GET',
      headers: {},
      body: '',
    };
    let calls = 0;
    const replay = async () => {
      calls += 1;
      if (calls === 1) throw new Error('tab navigated');
      return response(200);
    };

    await expect(primeMetadataRequest(capture, context, replay))
      .rejects.toThrow('tab navigated');
    await primeMetadataRequest(capture, context, replay);
    expect(calls).toBe(2);
    clearMetadataPrimeState(capture.requestId);
  });
});
