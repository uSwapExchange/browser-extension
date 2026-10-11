import { describe, expect, it } from 'bun:test';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';
import { extractJsonRows } from '../src/modules/peer-capture/capture/extract.js';
import { buildParams } from '../src/modules/peer-capture/capture/selectors.js';
import { prepareBuyerRows, unusableRowsMessage } from '../src/modules/peer-capture/capture/buyer-rows.js';
import { captureTarget, isPlatformUrl, validateAttestationUrl } from '../src/modules/peer-capture/templates/target.js';
import { assertNoPrivateLeak, assertBuyerMetadataPrivacy } from '../src/modules/peer-capture/capture/redact.js';
import { captureErrorMessage } from '../src/modules/peer-capture/capture/error.js';
import wise from './fixtures/wise_transfer_wise.json';

const wiseHistory = [{
  primaryAmount: '50.00', resource: { id: 999000001 }, title: 'Example recipient',
  ownedByProfile: 123456, currency: 'CAD',
}];

async function wiseRows(response: unknown) {
  const template = parseProviderTemplate(wise);
  const rows = extractJsonRows(template, response);
  const params = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    params.set(row.originalIndex, (await buildParams(template, row.originalIndex, {
      responseJson: response, responseText: JSON.stringify(response),
      requestBody: '', requestHeaders: {}, responseHeaders: {}, url: 'https://wise.com/',
    })).params);
  }
  return prepareBuyerRows('wise', rows, params, { template, inline: false });
}

describe('usable payment selection', () => {
  it('offers an identifiable Wise transfer when only its display date is absent', async () => {
    const rows = await wiseRows(wiseHistory);
    expect(rows[0]).toMatchObject({ hidden: false, amount: '50.00', currency: 'CAD',
      params: { TRANSACTION_ID: '999000001', PROFILE_ID: '123456' } });
    expect(rows[0]?.date).toBeUndefined();
  });
  it('does not relax amount, recipient, or transfer/profile identification', async () => {
    for (const field of ['primaryAmount', 'title', 'ownedByProfile', 'resource']) {
      const item: Record<string, unknown> = { ...wiseHistory[0] };
      delete item[field];
      expect((await wiseRows([item]))[0]?.hidden).toBe(true);
    }
  });
  it('selects an ID-backed Wise activity without currency or date and never supplies guessed values', async () => {
    const rows = await wiseRows([{ ...wiseHistory[0], currency: undefined }]);
    expect(rows[0]?.hidden).toBe(false);
    expect(rows[0]?.currency).toBeUndefined();
    expect(rows[0]?.date).toBeUndefined();
    const params = new Map([[0, rows[0]!.params as Record<string, unknown>]]);
    const template = parseProviderTemplate(wise);
    expect(prepareBuyerRows('wise', [{ ...rows[0]!, hidden: true }], params, { template, inline: true })[0]?.hidden).toBe(true);
    expect(prepareBuyerRows('wise', [{ ...rows[0]!, hidden: true }], params, { template: { ...template, url: 'https://wise.com/other' }, inline: false })[0]?.hidden).toBe(true);
    expect(prepareBuyerRows('wise', rows, new Map([[0, { PROFILE_ID: '123456', TRANSACTION_ID: '999000002' }]]), { template, inline: false })[0]?.hidden).toBe(true);
  });
  it('distinguishes an empty account from returned but incomplete payment details', async () => {
    expect(unusableRowsMessage('wise', [])).toContain('No wise transactions were returned');
    const rows = await wiseRows([{ ...wiseHistory[0], primaryAmount: undefined, currency: undefined }]);
    expect(rows[0]?.hidden).toBe(true);
    const message = unusableRowsMessage('wise', rows);
    expect(message).toContain('1 history item(s)');
    expect(message).toContain('currency');
    expect(message).not.toContain('Example recipient');
  });
});

describe('payment capture trust boundary', () => {
  it('removes credential values from browser/SDK exceptions relayed to the page', () => {
    const message = captureErrorMessage(new Error('Rejected header: session=secret-cookie; token secret-auth'), {
      url: 'https://wise.com/', method: 'POST', body: '',
      headers: { Cookie: 'session=secret-cookie', Authorization: 'Bearer secret-auth' },
    });
    expect(message).not.toContain('secret-cookie');
    expect(message).not.toContain('secret-auth');
    expect(message).toContain('Rejected header');
  });
  it('keeps bank permission selection while resolving all legacy Zelle names', () => {
    for (const bank of ['citi', 'chase', 'bofa']) {
      const target = captureTarget(`zelle-${bank}`, `transfer_${bank}`);
      expect(target.platform).toBe('zelle');
      expect(target.actionType).toBe(`transfer_zelle_${bank}`);
      expect(target.permissionPlatform).toBe(`zelle-${bank}`);
    }
    expect(() => captureTarget('zelle-citi', 'transfer_chase')).toThrow();
    expect(() => captureTarget('wise', '../../evil')).toThrow();
  });
  it('rejects lookalike provider domains and cross-provider capture URLs', () => {
    expect(isPlatformUrl('wise', 'https://wise.com.evil.example/session')).toBe(false);
    expect(isPlatformUrl('wise', 'https://evil.example/?next=wise.com')).toBe(false);
    expect(isPlatformUrl('wise', 'https://cash.app/account/activity')).toBe(false);
    expect(isPlatformUrl('wise', 'https://wise.com/all-transactions')).toBe(true);
  });
  it('cannot encrypt credentials to a caller-owned key service', () => {
    expect(() => validateAttestationUrl('https://evil.example', 'https://app.uswap.net')).toThrow();
    expect(() => validateAttestationUrl('https://uswap.net.evil.example', 'https://app.uswap.net')).toThrow();
    expect(() => validateAttestationUrl('http://localhost:9999', 'https://app.uswap.net')).toThrow();
    expect(validateAttestationUrl('http://localhost:9999', 'http://localhost:5173')).toBe('http://localhost:9999');
    expect(validateAttestationUrl('https://attestation-service.zkp2p.xyz/', 'https://app.uswap.net')).toBe('https://attestation-service.zkp2p.xyz');
  });
  it('rejects credentials copied into nested per-row proof params', () => {
    expect(() => assertNoPrivateLeak([{ originalIndex: 0, params: { credential: 'private-account-session' } }],
      ['private-account-session'])).toThrow();
  });
});


it("restricts X Money account access to the requested x.com host", () => {
  expect(isPlatformUrl("xmoney", "https://x.com/i/money/transactions")).toBe(true);
  expect(isPlatformUrl("xmoney", "https://subdomain.x.com/i/money/transactions")).toBe(false);
  expect(isPlatformUrl("xmoney", "https://x.com.evil.test/i/money/transactions")).toBe(false);
  expect(isPlatformUrl("xmoney", "https://xmoney.com/")).toBe(false);
});


it('allows hosted Wise response IDs that also occur in context cookies while withholding credentials everywhere else', async () => {
  const rows = await wiseRows(wiseHistory);
  const input = { rows, platform:'wise', inline:false, headers:{Cookie:'selectedProfile=123456; session=private-session-token'}, privateValues:[] };
  expect(() => assertNoPrivateLeak(rows,['123456'])).toThrow(); // reproduces 0.6.10's actual guard failure
  expect(() => assertBuyerMetadataPrivacy(input)).not.toThrow();
  expect(() => assertBuyerMetadataPrivacy({...input, inline:true})).toThrow();
  expect(() => assertBuyerMetadataPrivacy({...input,headers:{...input.headers,Authorization:'Bearer 123456'}})).toThrow();
  expect(() => assertBuyerMetadataPrivacy({...input,privateValues:['123456']})).toThrow();
  expect(() => assertBuyerMetadataPrivacy({...input,rows:[{...rows[0]!,params:{PROFILE_ID:'123456',credential:'private-session-token'}}]})).toThrow();
  expect(() => assertBuyerMetadataPrivacy({...input,rows:[{...rows[0]!,params:{PROFILE_ID:'private-session-token'}}]})).toThrow();
  expect(() => assertBuyerMetadataPrivacy({...input,rows:[{...rows[0]!,params:{PROFILE_ID:'123456',credential:'123456'}}]})).toThrow();
  expect(() => assertBuyerMetadataPrivacy({...input,rows:[{...rows[0]!,params:{credential:input.headers.Cookie}}]})).toThrow();
});
