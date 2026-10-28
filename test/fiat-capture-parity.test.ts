import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types';
import { extractJsonRows } from '../src/modules/peer-capture/capture/extract';
import { buildParams } from '../src/modules/peer-capture/capture/selectors';
import { captureTarget } from '../src/modules/peer-capture/templates/target';

function fixture(name: string) {
  return parseProviderTemplate(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')));
}

test('Monobank detail capture supplies the transaction ID while keeping the client ID encrypted', async () => {
  const template = fixture('monobank_transfer_monobank');
  const response = { result: { id: 'payment-123', contragentIban: 'UA000000000000000000000000000', amount: 100, date: '2026-10-28', currency: 'UAH', status: 'approved', type: 'outgoing', category: 'transfer' } };
  const rows = extractJsonRows(template, response);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.paymentId).toBe('payment-123');
  const built = await buildParams(template, 0, { responseJson: response, responseText: JSON.stringify(response), requestBody: '{"clientId":"private-client"}', requestHeaders: {}, responseHeaders: {}, url: template.url });
  expect(built.params).toEqual({ TRANSACTION_ID: 'payment-123' });
  expect(built.privateValues).toContain('private-client');
  expect(JSON.stringify(rows)).not.toContain('private-client');
});

test('UPI selection preserves the selected transaction detail URL', async () => {
  const template = fixture('upi_transfer_upi_amazonpay');
  const response = { data: { GetTransactionHistory: { transactions: [
    { transactionDetailPageURL: '/first' }, { transactionDetailPageURL: '/second' },
  ] } } };
  const built = await buildParams(template, 1, { responseJson: response, responseText: JSON.stringify(response), requestBody: '{}', requestHeaders: {}, responseHeaders: {}, url: template.url });
  expect(built.params.TRANSACTION_URL).toBe('/second');
  expect(captureTarget('upi', template.actionType!).platform).toBe('upi');
});

test('Business identity capture uses its own action without accepting cross-platform actions', () => {
  const template = fixture('paypal_register_business_paypal');
  expect(captureTarget('paypal', template.actionType!).actionType).toBe('register_business_paypal');
  expect(extractJsonRows(template, { businessHandle: 'example-business' })[0]?.paypalUsername).toBe('example-business');
  expect(() => captureTarget('wise', template.actionType!)).toThrow();
});

test('Business payment proof selects the chosen activity transaction rather than the first row', async () => {
  const template = fixture('paypal_transfer_business_paypal');
  const response = { transactions: [{ id: 'older-payment' }, { id: 'selected-payment' }] };
  const built = await buildParams(template, 1, { responseJson: response, responseText: JSON.stringify(response), requestBody: '{}', requestHeaders: {}, responseHeaders: {}, url: 'https://www.paypal.com/unifiedtransactions/v1/transactions' });
  expect(built.params).toEqual({ PAYMENT_ID: 'selected-payment' });
  expect(captureTarget('paypal', template.actionType!).actionType).toBe('transfer_business_paypal');
});

test('Wise ownership proof extracts the profile from the observed request URL', async () => {
  const template = fixture('wise_register_wise');
  const response = { nickname: 'example123' };
  const built = await buildParams(template, 0, { responseJson: response, responseText: JSON.stringify(response), requestBody: '', requestHeaders: {}, responseHeaders: {}, url: 'https://wise.com/gateway/v1/profiles/12345/identifiers/profile-link' });
  expect(built.params).toEqual({ PROFILE_ID: '12345' });
  expect(extractJsonRows(template, response)[0]?.wiseTag).toBe('example123');
});
