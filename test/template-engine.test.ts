import { describe, expect, it } from 'bun:test';
import venmoTemplate from './fixtures/venmo_transfer_venmo.json';
import cashappTemplate from './fixtures/cashapp_transfer_cashapp.json';
import revolutTemplate from './fixtures/revolut_transfer_revolut.json';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';
import {
  normalizePlatformTemplate,
  REVOLUT_ALL_POCKETS_AUTH_LINK,
} from '../src/modules/peer-capture/templates/fetch.js';
import { extractJsonRows, jsonPathWithIndex } from '../src/modules/peer-capture/capture/extract.js';
import { buildParams } from '../src/modules/peer-capture/capture/selectors.js';
import {
  parseReplayPayload,
} from '../src/modules/peer-capture/capture/extract.js';
import { resolveReplayRequest } from '../src/modules/peer-capture/capture/replay.js';
import { assertNoPrivateLeak, PrivateMaterialLeak } from '../src/modules/peer-capture/capture/redact.js';

const VENMO_RESPONSE = {
  stories: [
    {
      paymentId: 'pid-aaa',
      amount: '- $25.00',
      currency: 'USD',
      date: '2026-06-01T12:00:00Z',
      title: { receiver: { username: 'maker-one' }, sender: { id: 'sender-123' } },
    },
    {
      paymentId: 'pid-bbb',
      amount: '- $40.00',
      currency: 'USD',
      date: '2026-06-02T12:00:00Z',
      title: { receiver: { username: 'maker-two' }, sender: { id: 'sender-123' } },
    },
  ],
};

function captureSources(
  responseJson: unknown,
  overrides: Partial<Parameters<typeof buildParams>[2]> = {},
): Parameters<typeof buildParams>[2] {
  return {
    responseJson,
    responseText: JSON.stringify(responseJson),
    requestBody: '',
    requestHeaders: {},
    responseHeaders: {},
    url: 'https://account.venmo.com/api/stories',
    ...overrides,
  };
}

describe('provider template parsing', () => {
  it('parses the real venmo template', () => {
    const template = parseProviderTemplate(venmoTemplate);
    expect(template.metadata.platform).toBe('venmo');
    expect(template.authLink).toContain('venmo.com');
    expect(template.paramNames).toEqual(['SENDER_ID']);
  });

  it('parses the real cashapp template', () => {
    const template = parseProviderTemplate(cashappTemplate);
    expect(template.metadata.platform).toBe('cashapp');
    expect(template.metadata.transactionsExtraction?.transactionJsonPathListSelector).toBe('$.activity_rows');
  });

  it('rejects a template missing required fields', () => {
    expect(() => parseProviderTemplate({ authLink: 'not-a-url' })).toThrow();
  });

  it('opens Revolut on the all-currency account view', () => {
    const template = parseProviderTemplate({
      ...venmoTemplate,
      platform: 'revolut',
      metadata: {
        ...venmoTemplate.metadata,
        platform: 'revolut',
        shouldReplayRequestInPage: true,
      },
      authLink: 'https://app.revolut.com/home',
    });
    const normalized = normalizePlatformTemplate('revolut', template);
    expect(normalized.authLink).toBe(REVOLUT_ALL_POCKETS_AUTH_LINK);
    expect(normalized.metadata).toEqual(template.metadata);
    expect(template.metadata.shouldReplayRequestInPage).toBe(true);
  });

  it('preserves the complete live Revolut template outside the auth-link wrapper', () => {
    const template = parseProviderTemplate(revolutTemplate);
    const normalized = normalizePlatformTemplate('revolut', template);
    expect(normalized.authLink).toBe(REVOLUT_ALL_POCKETS_AUTH_LINK);
    expect(normalized.metadata).toEqual(template.metadata);
    expect(normalized.paramNames).toEqual([]);
    expect(normalized.paramSelectors).toEqual([]);
    expect(normalized.metadata.proofMetadataSelectors).toHaveLength(6);
    expect(normalized.mobile).toEqual(revolutTemplate.mobile);
  });
});

describe('extractJsonRows', () => {
  it('extracts venmo rows preserving originalIndex', () => {
    const template = parseProviderTemplate(venmoTemplate);
    const rows = extractJsonRows(template, VENMO_RESPONSE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ originalIndex: 0, recipient: 'maker-one', paymentId: 'pid-aaa', amount: '- $25.00' });
    expect(rows[1]!.originalIndex).toBe(1);
  });

  it('returns empty when the list selector misses', () => {
    const template = parseProviderTemplate(venmoTemplate);
    expect(extractJsonRows(template, { stories: 'not-an-array' })).toEqual([]);
    expect(extractJsonRows(template, {})).toEqual([]);
  });
});

describe('jsonPathWithIndex', () => {
  it('binds {{INDEX}} before evaluating', () => {
    expect(jsonPathWithIndex(VENMO_RESPONSE, '$.stories[{{INDEX}}].paymentId', 1)).toBe('pid-bbb');
    expect(jsonPathWithIndex(VENMO_RESPONSE, '$.stories[{{INDEX}}].title.sender.id', 0)).toBe('sender-123');
  });
});

describe('buildParams', () => {
  it('builds public params without adding a platform-specific index', async () => {
    const template = parseProviderTemplate(venmoTemplate);
    const result = await buildParams(template, 1, captureSources(VENMO_RESPONSE, {
      url: 'https://account.venmo.com/api/stories?feedType=me&externalId=sender-123',
    }));
    expect(result.params).toEqual({ SENDER_ID: 'sender-123' });
    expect(result.privateParamNames).toEqual([]);
  });

  it('normalizes numeric provider identifiers to strings', async () => {
    const template = parseProviderTemplate({
      ...venmoTemplate,
      actionType: 'transfer_wise',
      metadata: {
        ...venmoTemplate.metadata,
        platform: 'wise',
        transactionsExtraction: {
          transactionJsonPathListSelector: '$',
          transactionJsonPathSelectors: {
            amount: '$.primaryAmount',
            paymentId: '$.resource.id',
            recipient: '$.title',
            date: '$.visibleOn',
            currency: '$.currency',
          },
        },
      },
      paramNames: ['TRANSACTION_ID', 'PROFILE_ID'],
      paramSelectors: [
        { type: 'jsonPath', value: '$.[{{INDEX}}].resource.id' },
        { type: 'jsonPath', value: '$.[{{INDEX}}].ownedByProfile' },
      ],
    });
    const response = [{
        resource: { id: 2267000001 },
        ownedByProfile: 82590001,
      }];
    const result = await buildParams(template, 0, captureSources(response, {
      url: 'https://wise.com/gateway/v1/profiles/82590001/activities/list',
    }));

    expect(result.params).toEqual({
      TRANSACTION_ID: '2267000001',
      PROFILE_ID: '82590001',
    });
  });

  it('keeps requestBody-sourced params private and out of the page payload', async () => {
    const template = parseProviderTemplate({
      ...venmoTemplate,
      paramNames: ['SECRET'],
      paramSelectors: [{ type: 'regex', value: 'token=(\\w+)', source: 'requestBody' }],
    });
    const result = await buildParams(template, 0, captureSources(VENMO_RESPONSE, {
      requestBody: 'token=supersecret&x=1',
      url: 'https://account.venmo.com/api/stories',
    }));
    expect(result.params.SECRET).toBeUndefined();
    expect(result.privateParamNames).toEqual(['SECRET']);
    expect(result.privateValues).toEqual(['supersecret']);
  });

  it('extracts params from request and response headers', async () => {
    const template = parseProviderTemplate({
      ...venmoTemplate,
      paramNames: ['REQUEST_ID', 'RESPONSE_ID'],
      paramSelectors: [
        { type: 'jsonPath', value: '$.x-request-id', source: 'requestHeaders' },
        { type: 'regex', value: '"x-response-id":"([^"]+)"', source: 'responseHeaders' },
      ],
    });
    const result = await buildParams(template, 0, captureSources(VENMO_RESPONSE, {
      requestHeaders: { 'x-request-id': 'request-123' },
      responseHeaders: { 'x-response-id': 'response-456' },
    }));
    expect(result.params).toEqual({
      REQUEST_ID: 'request-123',
      RESPONSE_ID: 'response-456',
    });
  });
});

describe('replay template semantics', () => {
  it('honors metadataUrl method/body and keeps it on the authenticated host', () => {
    const template = parseProviderTemplate({
      ...venmoTemplate,
      metadata: {
        ...venmoTemplate.metadata,
        metadataUrl: 'https://account.venmo.com/api/metadata',
        metadataUrlMethod: 'POST',
        metadataUrlBody: '{"limit":10}',
      },
    });
    expect(resolveReplayRequest({
      url: 'https://account.venmo.com/api/context',
      method: 'GET',
      headers: { Cookie: 'secret' },
      body: '',
    }, template)).toEqual({
      url: 'https://account.venmo.com/api/metadata',
      method: 'POST',
      headers: { Cookie: 'secret' },
      body: '{"limit":10}',
    });
  });

  it('rejects cross-host metadata replay', () => {
    const template = parseProviderTemplate({
      ...venmoTemplate,
      metadata: {
        ...venmoTemplate.metadata,
        metadataUrl: 'https://evil.example/steal',
      },
    });
    expect(() => resolveReplayRequest({
      url: 'https://account.venmo.com/api/context',
      method: 'GET',
      headers: {},
      body: '',
    }, template)).toThrow('Unsafe metadataUrl');
  });

  it('preprocesses HTML-wrapped JSON and supports root-object extraction', () => {
    const parsed = parseReplayPayload(
      '<html><pre>{"data":{"amount":"60.00","id":"tx-1"}}</pre></html>',
      '<pre[^>]*>([\\s\\S]*?)<\\/pre>',
    );
    expect(parsed.json).toEqual({ data: { amount: '60.00', id: 'tx-1' } });

    const template = parseProviderTemplate({
      ...venmoTemplate,
      metadata: {
        ...venmoTemplate.metadata,
        transactionsExtraction: {
          transactionJsonPathSelectors: {
            amount: '$.data.amount',
            paymentId: '$.data.id',
          },
        },
      },
    });
    expect(extractJsonRows(template, parsed.json)).toEqual([{
      originalIndex: 0,
      amount: '60.00',
      paymentId: 'tx-1',
      hidden: false,
    }]);
  });
});

describe('assertNoPrivateLeak', () => {
  it('passes when no private value appears in metadata', () => {
    const rows = extractJsonRows(parseProviderTemplate(venmoTemplate), VENMO_RESPONSE);
    expect(() => assertNoPrivateLeak(rows, ['supersecret-cookie-value'])).not.toThrow();
  });

  it('throws when a private value leaks into a metadata field', () => {
    const rows = [{ originalIndex: 0, recipient: 'leaked-secret' }];
    expect(() => assertNoPrivateLeak(rows, ['leaked-secret'])).toThrow(PrivateMaterialLeak);
  });

  it('ignores short private values to avoid false positives', () => {
    const rows = [{ originalIndex: 0, currency: 'USD' }];
    expect(() => assertNoPrivateLeak(rows, ['US'])).not.toThrow();
  });
});
