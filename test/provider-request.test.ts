import { describe, expect, it } from 'bun:test';
import venmoTemplate from './fixtures/venmo_transfer_venmo.json';
import {
  configuredRequestPatterns,
  isRelevantProviderRequest,
  matchesConfiguredRequest,
  matchesRequestCriteria,
  ProviderRequestCache,
  selectCompletedProviderContext,
  selectProviderContext,
  type ProviderRequestRecord,
} from '../src/modules/peer-capture/capture/provider-request.js';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';

function request(overrides: Partial<ProviderRequestRecord> = {}): ProviderRequestRecord {
  return {
    requestId: 'browser-request-1',
    tabId: 2,
    url: 'https://provider.example/primary',
    method: 'GET',
    type: 'xmlhttprequest',
    initiator: 'https://provider.example',
    requestBody: '',
    requestHeaders: {},
    responseHeaders: {},
    statusCode: 200,
    timestamp: 1,
    ...overrides,
  };
}

function template() {
  return parseProviderTemplate({
    ...venmoTemplate,
    method: 'GET',
    metadata: {
      ...venmoTemplate.metadata,
      method: 'GET',
      urlRegex: '^https://provider\\.example/primary$',
      fallbackMethod: 'POST',
      fallbackUrlRegex: '^https://provider\\.example/fallback$',
      fallbackBodyRegex: '"operation":"history"',
      metadataUrl: 'https://provider.example/metadata/{{ACCOUNT_ID}}',
    },
  });
}

describe('ProviderRequestCache', () => {
  it('joins request lifecycle fields by browser request id', () => {
    const cache = new ProviderRequestCache();
    cache.merge('capture-1', 'browser-1', {
      tabId: 2,
      url: 'https://provider.example/primary',
      method: 'GET',
      type: 'xmlhttprequest',
      initiator: 'https://provider.example',
      requestBody: '',
    });
    cache.merge('capture-1', 'browser-1', {
      requestHeaders: { Authorization: 'Bearer secret' },
    });
    cache.merge('capture-1', 'browser-1', {
      statusCode: 200,
      responseHeaders: { 'content-type': 'application/json' },
      timestamp: 123,
    });

    expect(cache.list('capture-1')).toEqual([expect.objectContaining({
      requestId: 'browser-1',
      statusCode: 200,
      requestBody: '',
      requestHeaders: { Authorization: 'Bearer secret' },
      responseHeaders: { 'content-type': 'application/json' },
    })]);
    cache.clear('capture-1');
    expect(cache.list('capture-1')).toEqual([]);
  });
});

describe('provider request matching', () => {
  it('requires method, URL, and configured request body', () => {
    const candidate = request({
      url: 'https://provider.example/fallback',
      method: 'POST',
      requestBody: '{"operation":"history"}',
    });
    expect(matchesRequestCriteria(
      candidate,
      'POST',
      '^https://provider\\.example/fallback$',
      '"operation":"history"',
    )).toBe(true);
    expect(matchesRequestCriteria(
      { ...candidate, requestBody: '{"operation":"other"}' },
      'POST',
      '^https://provider\\.example/fallback$',
      '"operation":"history"',
    )).toBe(false);
  });

  it('selects primary before fallback regardless of observation order', () => {
    const fallback = request({
      requestId: 'fallback',
      url: 'https://provider.example/fallback',
      method: 'POST',
      requestBody: '{"operation":"history"}',
      timestamp: 1,
    });
    const primary = request({
      requestId: 'primary',
      url: 'https://provider.example/primary',
      timestamp: 2,
    });

    expect(selectProviderContext([fallback, primary], template())).toEqual({
      kind: 'primary',
      request: primary,
    });
    expect(selectProviderContext([fallback], template())).toEqual({
      kind: 'fallback',
      request: fallback,
    });
  });

  it('does not select context until the provider request completed successfully', () => {
    const pending = request({
      statusCode: undefined,
      timestamp: undefined,
    });
    const rejected = request({
      requestId: 'rejected',
      statusCode: 401,
      timestamp: 2,
    });
    const completed = request({
      requestId: 'completed',
      statusCode: 200,
      timestamp: 3,
    });

    expect(selectCompletedProviderContext([pending, rejected], template())).toBeNull();
    expect(selectCompletedProviderContext([pending, rejected, completed], template())).toEqual({
      kind: 'primary',
      request: completed,
    });
  });

  it('builds the same primary, fallback, and metadata pattern set as Peer', () => {
    const patterns = configuredRequestPatterns(template());
    expect(patterns).toHaveLength(3);
    expect(matchesConfiguredRequest(template(), 'https://provider.example/primary')).toBe(true);
    expect(matchesConfiguredRequest(template(), 'https://provider.example/fallback')).toBe(true);
    expect(matchesConfiguredRequest(template(), 'https://provider.example/metadata/account-1'))
      .toBe(true);
    expect(matchesConfiguredRequest(template(), 'https://other.example/primary')).toBe(false);
  });

  it('ignores replay, extension, HEAD/OPTIONS, and non-network-resource requests', () => {
    const base = {
      type: 'xmlhttprequest' as const,
      method: 'GET',
      url: 'https://provider.example/primary',
      initiator: 'https://provider.example',
      extensionId: 'extension-id',
    };
    expect(isRelevantProviderRequest(base)).toBe(true);
    expect(isRelevantProviderRequest({ ...base, method: 'HEAD' })).toBe(false);
    expect(isRelevantProviderRequest({ ...base, method: 'OPTIONS' })).toBe(false);
    expect(isRelevantProviderRequest({ ...base, type: 'image' })).toBe(false);
    expect(isRelevantProviderRequest({
      ...base,
      initiator: 'chrome-extension://extension-id',
    })).toBe(false);
    expect(isRelevantProviderRequest({
      ...base,
      url: 'https://provider.example/primary?replay_request=1',
    })).toBe(false);
  });
});
