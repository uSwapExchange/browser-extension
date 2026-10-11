import { afterEach, beforeEach, expect, it } from 'bun:test';
import { runBuyerCapture, setBuyerDeliver } from '../src/modules/peer-capture/flows/buyer.js';
import { putSession, getSession, type CaptureSession } from '../src/modules/peer-capture/capture/session.js';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';
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
