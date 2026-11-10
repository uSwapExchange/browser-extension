import { afterEach, beforeEach, expect, it } from 'bun:test';
import { runBuyerCapture, setBuyerDeliver } from '../src/modules/peer-capture/flows/buyer.js';
import { putSession, getSession, type CaptureSession } from '../src/modules/peer-capture/capture/session.js';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';
import cashIdentity from './fixtures/register_cashapp.json';
import venmoIdentity from './fixtures/register_venmo.json';
import monzoIdentity from './fixtures/register_monzo.json';
import wise from './fixtures/wise_transfer_wise.json';

let oldChrome: typeof chrome;
let oldFetch: typeof fetch;
let stored: Record<string, unknown>;
let removed: number[];
let activated: number[];
let delivered: any[];
let encryptedInput: any;
let status: number;
let history: Record<string, unknown>[] = [{primaryAmount:'50.00',resource:{id:999000001},title:'Example recipient',ownedByProfile:123456,currency:'CAD'}];
beforeEach(() => {
  history = [{primaryAmount:'50.00',resource:{id:999000001},title:'Example recipient',ownedByProfile:123456,currency:'CAD'}];
  oldChrome=globalThis.chrome;oldFetch=globalThis.fetch;stored={};removed=[];activated=[];delivered=[];status=200;encryptedInput=null;
  globalThis.fetch=(async()=>new Response(JSON.stringify(history),{status})) as unknown as typeof fetch;
  globalThis.chrome={
    runtime:{getURL:(p:string)=>`chrome-extension://test/${p}`,getContexts:async()=>[{}],sendMessage:async(req:any)=>{encryptedInput=req.payload;return{target:'offscreen-result',id:req.id,ok:true,result:{encryptedSessionMaterial:'synthetic-ciphertext'}}}},
    storage:{session:{get:async(key:string)=>({[key]:stored[key]}),set:async(values:any)=>{Object.assign(stored,structuredClone(values))},remove:async(key:string)=>{delete stored[key]}}},
    tabs:{update:async(id:number)=>{activated.push(id)},remove:async(id:number)=>{removed.push(id)}},
    declarativeNetRequest:{updateSessionRules:async()=>{}},
    scripting:{executeScript:async()=>[{result:{ok:true,status,text:JSON.stringify(history),headers:{}}}]},
  } as unknown as typeof chrome;
  setBuyerDeliver((_session,message)=>{delivered.push(message)});
});
afterEach(()=>{globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;setBuyerDeliver(()=>{})});
async function start(keepOpen=false){
 const session:CaptureSession={requestId:crypto.randomUUID(),connectionKey:'test-connection',origin:'https://app.uswap.net',platform:'wise',actionType:'transfer_wise',attestationActionType:'transfer_wise',captureMode:'buyerTee',attestationServiceUrl:'https://attestation-service.zkp2p.xyz',template:parseProviderTemplate(wise),inline:false,firstParty:true,sourceTabId:1,authTabId:2,status:'captured',captured:{url:'https://wise.com/gateway/v1/profiles/123456/activities/list',method:'POST',headers:{Cookie:'selectedProfile=123456; session=private-session-token'},body:'{}'},createdAt:Date.now(),expiresAt:Date.now()+60_000};
 if(keepOpen)session.template.metadata.shouldSkipCloseTab=true;
 await putSession(session);await runBuyerCapture(session.requestId);return session;
}
it('delivers Wise proof IDs after cookie overlap, encrypts credentials and closes the temporary tab',async()=>{
 const session=await start();
 expect(delivered).toHaveLength(1);
 expect(delivered[0]).toMatchObject({buyerTeeCapture:{encryptedSessionMaterial:'synthetic-ciphertext',params:{PROFILE_ID:'123456',TRANSACTION_ID:'999000001'}}});
 expect(JSON.stringify(delivered)).not.toContain('private-session-token');
 expect(encryptedInput.sessionMaterial.Cookie).toContain('private-session-token');
 expect(activated).toEqual([1]);expect(removed).toEqual([2]);expect(await getSession(session.requestId)).toBeNull();
});
it('returns to the app and closes the temporary tab after both Wise metadata attempts fail',async()=>{
 status=500;const session=await start();
 expect(delivered[0]).toMatchObject({metadata:[],error:'Replay failed (HTTP 500)'});
 expect(encryptedInput).toBeNull();expect(activated).toEqual([1]);expect(removed).toEqual([2]);expect(await getSession(session.requestId)).toBeNull();
});
it('respects a provider request to leave its tab open after a failed capture',async()=>{
 status=500;await start(true);expect(delivered).toHaveLength(1);expect(activated).toEqual([1]);expect(removed).toHaveLength(0);
});

it('delivers the actual Wise transfer IDs when the activity omits currency, without inventing payment terms',async()=>{
 delete history[0]!.currency;
 const session=await start();
 expect(delivered).toHaveLength(1);
 expect(delivered[0].error).toBeUndefined();
 expect(delivered[0].metadata[0]).toMatchObject({hidden:false,amount:'50.00',paymentId:999000001,recipient:'Example recipient'});
 expect(delivered[0].metadata[0].currency).toBeUndefined();
 expect(delivered[0].metadata[0].date).toBeUndefined();
 expect(delivered[0].buyerTeeCapture).toMatchObject({encryptedSessionMaterial:'synthetic-ciphertext',params:{PROFILE_ID:'123456',TRANSACTION_ID:'999000001'}});
 expect(activated).toEqual([1]);expect(removed).toEqual([2]);expect(await getSession(session.requestId)).toBeNull();
});

async function identitySession(platform: string, template: unknown, body: string, response: unknown, url: string, captureParams?: Record<string, string>) {
  globalThis.fetch = (async () => new Response(JSON.stringify(response), {status: 200})) as unknown as typeof fetch;
  const session: CaptureSession = {requestId:crypto.randomUUID(),connectionKey:'identity-test',origin:'https://app.uswap.net',platform,
    actionType:`register_${platform}`,attestationActionType:`register_${platform}`,captureMode:'buyerTee',
    attestationServiceUrl:'https://attestation-service.zkp2p.xyz',template:parseProviderTemplate(template),inline:false,firstParty:true,
    sourceTabId:1,authTabId:2,status:'captured',captured:{url,method:platform === 'cashapp'?'POST':'GET',headers:{Cookie:'session=private-session-token'},body},
    createdAt:Date.now(),expiresAt:Date.now()+60_000,captureParams};
  await putSession(session); await runBuyerCapture(session.requestId);
  return session;
}
it('registers a Cash App account with zero payments and encrypts the exact activity request separately from payment data', async () => {
  const body=JSON.stringify({activity_token:{activity_token_type:'CUSTOMER_TOKEN',token:'private-customer-token'},activity_scope:'MY_ACTIVITY_WEB_V2',request_context:{}});
  await identitySession('cashapp',cashIdentity,body,{activity_rows:[]},'https://cash.app/cash-app/activity/v1.0/page');
  expect(delivered[0].error).toBeUndefined();
  expect(delivered[0].buyerTeeCapture.params).toEqual({});
  expect(encryptedInput.sessionMaterial).toEqual({sessionCookie:'session=private-session-token',requestPayload:body,requestHeaders:{Cookie:'session=private-session-token'}});
  expect(JSON.stringify(delivered)).not.toContain('private-');
  expect(delivered[0].metadata[0].amount).toBeUndefined();
});
it('returns the captured Venmo sender ID even when the account has no stories', async () => {
  await identitySession('venmo',venmoIdentity,'',{stories:[]},'https://account.venmo.com/api/stories?feedType=me&externalId=123456789');
  expect(delivered[0].buyerTeeCapture.params).toEqual({SENDER_ID:'123456789'});
  expect(encryptedInput.sessionMaterial.Cookie).toBe('session=private-session-token');
});
it('binds Monzo registration to the supplied handle without fabricating a transaction', async () => {
  await identitySession('monzo',monzoIdentity,'',{transactions:[]},'https://internal-api.monzo.com/minimal-banking/transactions?account_id=acc_test&limit=50',{MONZO_ME_HANDLE:'alice-test'});
  expect(delivered[0].buyerTeeCapture.params).toEqual({MONZO_ME_HANDLE:'alice-test'});
  expect(delivered[0].metadata[0].paymentId).toBeUndefined();
});
it('rejects Monzo account capture without a handle', async () => {
  await identitySession('monzo',monzoIdentity,'',{transactions:[]},'https://internal-api.monzo.com/minimal-banking/transactions?account_id=acc_test&limit=50');
  expect(delivered[0].error).toContain('Monzo.me handle'); expect(encryptedInput).toBeNull();
});
it('never converts an empty payment history into a successful account capture', async () => {
  history=[]; await start(); expect(delivered[0].error).toContain('No wise transactions'); expect(encryptedInput).toBeNull();
});
it('preserves the original indices and per-payment proof IDs for multiple Wise transfers', async () => {
  history=[{primaryAmount:'25.00',resource:{id:111111111},title:'First recipient',ownedByProfile:123456,currency:'USD'},
    {primaryAmount:'70.00',resource:{id:222222222},title:'Second recipient',ownedByProfile:123456,currency:'EUR'}];
  await start();
  expect(delivered[0].metadata.map((r:any)=>({index:r.originalIndex,id:r.params.TRANSACTION_ID,currency:r.currency,recipient:r.recipient})))
    .toEqual([{index:0,id:'111111111',currency:'USD',recipient:'First recipient'},{index:1,id:'222222222',currency:'EUR',recipient:'Second recipient'}]);
});
