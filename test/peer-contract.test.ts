import { describe, expect, it } from 'bun:test';
import venmoTemplate from './fixtures/venmo_transfer_venmo.json';
import { matchesTemplate } from '../src/modules/peer-capture/capture/interceptor.js';
import type { CaptureSession } from '../src/modules/peer-capture/capture/session.js';
import { prepareSellerPayload } from '../src/modules/peer-capture/flows/seller.js';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';

function session(overrides: Partial<CaptureSession> = {}): CaptureSession {
  return {
    requestId: 'req-1',
    connectionKey: 'tab:1:frame:0',
    origin: 'https://app.uswap.net',
    platform: 'venmo',
    actionType: 'transfer_venmo',
    attestationActionType: 'transfer_venmo',
    captureMode: 'buyerTee',
    attestationServiceUrl: 'https://attestation-service.zkp2p.xyz',
    template: parseProviderTemplate(venmoTemplate),
    inline: false,
    sourceTabId: 1,
    authTabId: 2,
    status: 'awaiting_request',
    captured: null,
    createdAt: 1,
    expiresAt: 2,
    ...overrides,
  };
}

describe('template request matching', () => {
  it('honors primary bodyRegex and does not match headers before the body is known', () => {
    const base = session();
    const withBodyFilter = session({
      template: parseProviderTemplate({
        ...venmoTemplate,
        metadata: {
          ...venmoTemplate.metadata,
          method: 'POST',
          urlRegex: 'https://provider.example/graphql',
          bodyRegex: '"operationName":"PaymentDetails"',
        },
      }),
    });
    expect(matchesTemplate(
      withBodyFilter,
      'https://provider.example/graphql',
      'POST',
    )).toBe(false);
    expect(matchesTemplate(
      withBodyFilter,
      'https://provider.example/graphql',
      'POST',
      '{"operationName":"Other"}',
    )).toBe(false);
    expect(matchesTemplate(
      withBodyFilter,
      'https://provider.example/graphql',
      'POST',
      '{"operationName":"PaymentDetails"}',
    )).toBe(true);
    expect(matchesTemplate(
      base,
      'https://account.venmo.com/api/stories?feedType=me&externalId=123',
      'GET',
      '',
    )).toBe(true);
  });

  it('honors fallback method and bodyRegex', () => {
    const capture = session({
      template: parseProviderTemplate({
        ...venmoTemplate,
        metadata: {
          ...venmoTemplate.metadata,
          urlRegex: '^https://never.example',
          fallbackMethod: 'POST',
          fallbackUrlRegex: '^https://provider.example/fallback$',
          fallbackBodyRegex: 'payment=true',
        },
      }),
    });
    expect(matchesTemplate(
      capture,
      'https://provider.example/fallback',
      'GET',
      'payment=true',
    )).toBe(false);
    expect(matchesTemplate(
      capture,
      'https://provider.example/fallback',
      'POST',
      'payment=true',
    )).toBe(true);
  });
});

describe('Seller Autopilot capture boundary', () => {
  it('builds a Venmo seller payload while keeping credentials inside the extension', () => {
    const capture = session({
      captureMode: 'sellerCredential',
      captured: {
        url: 'https://account.venmo.com/api/stories?feedType=me&externalId=123',
        method: 'GET',
        headers: { Cookie: 'venmo-session=secret' },
        body: '',
      },
    });
    const payload = prepareSellerPayload(capture, {
      stories: [{
        title: {
          sender: { id: '123', username: 'seller-name' },
          receiver: { id: '999', username: 'other' },
        },
      }],
    });
    expect(payload.payeeId).toBe('123');
    expect(payload.offchainId).toBe('seller-name');
    expect(payload.sessionMaterial).toMatchObject({
      accountId: '123',
      recipientUsername: 'seller-name',
      sessionCookie: 'venmo-session=secret',
    });
  });

  it('builds a Cash App seller payload from one stable account identity', () => {
    const capture = session({
      platform: 'cashapp',
      captureMode: 'sellerCredential',
      captured: {
        url: 'https://cash.app/cash-app/activity/v1.0/page',
        method: 'POST',
        headers: { cookie: 'cash-session=secret' },
        body: '{"activity_scope":"MY_ACTIVITY_WEB_V2"}',
      },
    });
    const payload = prepareSellerPayload(capture, {
      activity_rows: [{
        activity_item_global_id: {
          primary_activity_token: { token: 'customer-123' },
        },
        payment_history_inputs_row: {
          sender: { id: 'customer-123', cashtag: '$seller' },
        },
      }],
    });
    expect(payload.payeeId).toBe('seller');
    expect(payload.offchainId).toBe('seller');
    expect(payload.sessionMaterial).toMatchObject({
      customerId: 'customer-123',
      recipientCashtag: 'seller',
      requestPayload: '{"activity_scope":"MY_ACTIVITY_WEB_V2"}',
      sessionCookie: 'cash-session=secret',
    });
  });
});
