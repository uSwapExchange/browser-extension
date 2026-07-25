import { describe, expect, it } from 'bun:test';
import revolutTemplateJson from './fixtures/revolut_transfer_revolut.json';
import {
  selectCompletedProviderContext,
  type ProviderRequestRecord,
} from '../src/modules/peer-capture/capture/provider-request.js';
import { resolveMetadataPayload } from '../src/modules/peer-capture/capture/metadata-engine.js';
import { extractJsonRows } from '../src/modules/peer-capture/capture/extract.js';
import { buildParams } from '../src/modules/peer-capture/capture/selectors.js';
import {
  normalizePlatformTemplate,
  REVOLUT_ALL_POCKETS_AUTH_LINK,
  REVOLUT_SEE_ALL_TRANSACTIONS_XPATH,
} from '../src/modules/peer-capture/templates/fetch.js';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';

const template = normalizePlatformTemplate(
  'revolut',
  parseProviderTemplate(revolutTemplateJson),
);

function request(
  url: string,
  overrides: Partial<ProviderRequestRecord> = {},
): ProviderRequestRecord {
  return {
    requestId: 'request-1',
    tabId: 7,
    url,
    method: 'GET',
    type: 'xmlhttprequest',
    initiator: 'https://app.revolut.com',
    requestBody: '',
    requestHeaders: {
      Cookie: 'revolut-session=secret',
      'User-Agent': 'Chrome',
    },
    responseHeaders: { 'content-type': 'application/json' },
    statusCode: 200,
    timestamp: 1,
    ...overrides,
  };
}

const transactions = [
  {
    recipient: { username: 'someone-else' },
    amount: -10,
    completedDate: 1760000000000,
    id: 'payment-older',
    currency: 'USD',
    state: 'COMPLETED',
    type: 'CARD_TO_CARD',
  },
  {
    recipient: { username: 'beefwhistle' },
    amount: -60,
    completedDate: 1760000001000,
    id: 'payment-customer',
    currency: 'USD',
    state: 'COMPLETED',
    type: 'CARD_TO_CARD',
  },
];

describe('live Revolut provider-template contract', () => {
  it('retains the hosted capture contract and adds only the all-pockets guide wrapper', () => {
    expect(template.authLink).toBe(REVOLUT_ALL_POCKETS_AUTH_LINK);
    const { userInput, ...captureMetadata } = template.metadata;
    expect(captureMetadata).toEqual(revolutTemplateJson.metadata);
    expect(userInput).toEqual({
      promptText:
        'Open Transactions using “See all,” or refresh this Transactions page if it is already open.',
      transactionXpath: REVOLUT_SEE_ALL_TRANSACTIONS_XPATH,
      waitForXpathMs: 20_000,
      pollIntervalMs: 250,
    });
    expect(template.metadata.shouldReplayRequestInPage).toBe(true);
    expect(template.metadata.proofMetadataSelectors).toHaveLength(6);
    expect(template.mobile).toEqual(revolutTemplateJson.mobile);
  });

  it('uses exact primary first and the configured URL fallback second', () => {
    const fallback = request(
      'https://app.revolut.com/api/retail/user/current/transactions/last?count=50',
      { requestId: 'fallback', timestamp: 1 },
    );
    const primary = request(
      'https://app.revolut.com/api/retail/user/current/transactions/last?count=20',
      { requestId: 'primary', timestamp: 2 },
    );
    expect(selectCompletedProviderContext([fallback, primary], template)).toEqual({
      kind: 'primary',
      request: primary,
    });
    expect(selectCompletedProviderContext([fallback], template)).toEqual({
      kind: 'fallback',
      request: fallback,
    });
  });

  it('replays the configured metadata URL in-page from fallback auth context', async () => {
    const fallback = request(
      'https://app.revolut.com/api/retail/user/current/transactions/last?count=50',
    );
    const selected = selectCompletedProviderContext([fallback], template);
    expect(selected?.kind).toBe('fallback');
    if (!selected) throw new Error('fallback context missing');

    const calls: unknown[] = [];
    const payload = await resolveMetadataPayload({
      context: {
        url: selected.request.url,
        method: selected.request.method,
        headers: selected.request.requestHeaders ?? {},
        body: '',
        statusCode: selected.request.statusCode,
        timestamp: selected.request.timestamp,
        contextKind: selected.kind,
      },
      template,
      authTabId: 7,
    }, async (replayRequest, options) => {
      calls.push({ replayRequest, options });
      return {
        status: 200,
        text: JSON.stringify(transactions),
        json: transactions,
        headers: { 'content-type': 'application/json' },
      };
    });

    expect(calls).toEqual([{
      replayRequest: expect.objectContaining({
        url: revolutTemplateJson.metadata.metadataUrl,
        method: 'GET',
        contextKind: 'fallback',
      }),
      options: { inPage: true, tabId: 7 },
    }]);
    expect(payload.parsed.json).toEqual(transactions);
  });

  it('extracts the root transaction array and preserves the proof index', async () => {
    const rows = extractJsonRows(template, transactions);
    expect(rows[1]).toEqual({
      originalIndex: 1,
      recipient: 'beefwhistle',
      amount: -60,
      date: 1760000001000,
      paymentId: 'payment-customer',
      currency: 'USD',
      state: 'COMPLETED',
      type: 'CARD_TO_CARD',
      hidden: false,
    });
    expect((await buildParams(template, rows[1]!.originalIndex, {
      responseJson: transactions,
      responseText: JSON.stringify(transactions),
      requestBody: '',
      requestHeaders: {},
      responseHeaders: {},
      url: revolutTemplateJson.metadata.metadataUrl,
    })).params).toEqual({});
    expect(rows[1]!.originalIndex).toBe(1);
  });
});
