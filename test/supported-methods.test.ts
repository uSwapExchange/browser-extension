import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';
import { extractJsonRows, parseReplayPayload } from '../src/modules/peer-capture/capture/extract.js';
import { buildParams } from '../src/modules/peer-capture/capture/selectors.js';
import { prepareBuyerRows } from '../src/modules/peer-capture/capture/buyer-rows.js';

// Invented account data shaped like Peer's public templates. These are capture
// contract checks, not evidence of successful logged-in bank transactions.
const date = '2026-10-11';
const cases: Array<{file: string; response: unknown; id: string; params: Record<string, string>}> = [
  {file:'xmoney_transfer_xmoney', response:{data:{get_transaction_result_by_id:{id:'xmoney-2',amount_local_micro:'50000000',currency:'USD',transaction_status:'COMPLETED',transaction_type:'PAYMENT',presentation:{timestamp:date,amount_direction:'OUTGOING'},details:{receiver_results:{result:{core:{screen_name:'example_payee'}}}}}}},id:'xmoney-2',params:{TRANSACTION_ID:'xmoney-2'}},
  {file:'paypal_transfer_paypal', response:{data:{data:{activity:{transactions:[{id:'paypal-2',ftsSearchInfo:{email:'payee@example.test',displayAmount:'50.00'},date:{rawDate:{date}},amounts:{currencyCode:'USD'},type:'PAYMENT'}]}}}}, id:'paypal-2',params:{PAYMENT_ID:'paypal-2'}},
  {file:'mercadopago_transfer_mercadopago', response:{exampleNavigation:'/transfer?from=activity',pageState:{mpHome:{result:{sections:{hs_activities:{content:{content:[{id:'mp-2',title:'Example payee',amount:{fraction:'50.00',currency_id:'ARS'},creationDate:date}]}}}}}}},id:'mp-2',params:{PAYMENT_ID:'mp-2',URL_PARAMS_FROM:'activity'}},
  {file:'monzo_transfer_monzo',response:{transactions:[{id:'monzo-2',counterparty:{user_id:'payee-1',name:'Example payee'},amount:-5000,settled:date,currency:'GBP'}]},id:'monzo-2',params:{TX_ID:'monzo-2'}},
  {file:'n26_transfer_n26',response:{data:{transaction:{containers:[{body:[{title:'Example payee',amount:{value:50,money:{currency:{code:'EUR'}}},subtitle:date}]},{body:[{}, {action:{tracking:{property:'n26-2'}}}]}]}}},id:'n26-2',params:{}},
  {file:'chime_transfer_chime',response:{data:{p2p:{p2p_activity:{pay_friend:{receiver_identifier:'payee@example.test',amount:5000,id:'chime-2'},timestamp:date,ux_status:'COMPLETED'}}}},id:'chime-2',params:{}},
  {file:'luxon_transfer_luxon',response:{content:[{receiver:{label:'Example payee',value:{amount:50,currency:'USD'}},createdAt:date,transferId:'luxon-2',status:'COMPLETED'}]},id:'luxon-2',params:{TRANSFER_ID:'luxon-2'}},
  {file:'zelle_transfer_zelle_citi',response:{transactionData:[{transactions:[{amount:50,transactionId:'citi-2',partyToken:'payee-token',initiationDate:date,transactionStatus:'COMPLETED'}]}]},id:'citi-2',params:{}},
  {file:'zelle_transfer_zelle_chase',response:{listItems:[{amount:50,id:'chase-2',recipientName:'Example payee',date,currency:'USD',verboseStatus:'COMPLETED'}]},id:'chase-2',params:{}},
  {file:'zelle_transfer_zelle_bofa',response:{completedTransactions:[{targetAccount:{displayName:'Example payee',aliasToken:'payee-token'},amount:50,transactionDate:date,confirmationNumber:'bofa-2',status:'COMPLETED'}]},id:'bofa-2',params:{}},
];

for (const item of cases) {
  it(`${item.file}: extracts payment identity and keeps private request bodies out of proof params`, async () => {
    const template = parseProviderTemplate(JSON.parse(readFileSync(new URL(`./fixtures/${item.file}.json`, import.meta.url), 'utf8')));
    const jsonText = JSON.stringify(item.response);
    const raw = item.file.startsWith('paypal') ? `<pre>${jsonText}</pre>`
      : item.file.startsWith('mercadopago') ? `<script id="__PRELOADED_STATE__">${jsonText}</script>` : jsonText;
    const parsed = parseReplayPayload(raw, template.metadata.preprocessRegex);
    const extracted = extractJsonRows(template, parsed.json);
    const params = await buildParams(template, 0, {responseJson:parsed.json,responseText:parsed.text,requestBody:'{"operationName":"TestCapture","privateSession":"never-share"}',requestHeaders:{Cookie:'private-session'},responseHeaders:{},url:template.url});
    const rows=prepareBuyerRows(template.metadata.platform, extracted, new Map([[0,params.params]]), { template, inline: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({originalIndex:0,paymentId:item.id,hidden:false,params:item.params});
    if (item.file.startsWith('xmoney')) expect(rows[0]).toMatchObject({ amount: '50000000', recipient: 'example_payee', currency: 'USD' });
    expect(JSON.stringify(rows)).not.toContain('never-share');
  });
}
