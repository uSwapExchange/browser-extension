import { afterEach, beforeEach, expect, it } from 'bun:test';
import { captureRequest, getSession, isLiveSession, putSession, updateLiveSession, wipeSession, type CaptureSession } from '../src/modules/peer-capture/capture/session.js';
import { openPrompt, resolvePrompt } from '../src/core/consent/prompt.js';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types.js';
import venmo from './fixtures/venmo_transfer_venmo.json';

let original: typeof chrome;
let state: Record<string, unknown>;
let grants: Record<string, unknown>;
let closed: Set<(id: number) => void>;
let createWindow: (options: {url: string}) => Promise<{id: number}>;
const session = (): CaptureSession => ({requestId:crypto.randomUUID(),connectionKey:'doc:example',origin:'https://app.uswap.net',platform:'venmo',actionType:'transfer_venmo',attestationActionType:'transfer_venmo',captureMode:'buyerTee',attestationServiceUrl:'https://attestation-service.zkp2p.xyz',template:parseProviderTemplate(venmo),inline:false,firstParty:false,sourceTabId:1,authTabId:2,status:'awaiting_request',captured:null,createdAt:Date.now(),expiresAt:Date.now()+60_000});
beforeEach(() => {
  original=globalThis.chrome;state={};grants={'https://app.uswap.net':{grantedAt:Date.now()}};closed=new Set();
  createWindow=async()=>({id:9});
  globalThis.chrome={
    runtime:{getURL:(path:string)=>`chrome-extension://test/${path}`},
    storage:{session:{get:async(key:string|null)=>key?{[key]:state[key]}:{...state},set:async(values:Record<string,unknown>)=>{Object.assign(state,structuredClone(values))},remove:async(key:string|string[])=>{for(const item of Array.isArray(key)?key:[key])delete state[item]}},local:{get:async()=>({connections:grants})}},
    windows:{create:(options:{url:string})=>createWindow(options),remove:async()=>{},onRemoved:{addListener:(fn:(id:number)=>void)=>closed.add(fn),removeListener:(fn:(id:number)=>void)=>closed.delete(fn)}},
  } as unknown as typeof chrome;
});
afterEach(()=>{globalThis.chrome=original});
it('a cancelled capture cannot be resurrected by a late status change or HTTP completion', async()=>{
  const current=session();await putSession(current);
  await wipeSession(current.requestId);
  expect(await updateLiveSession(current,'extracting')).toBe(false);
  expect(await captureRequest(current,{url:'https://account.venmo.com/api/stories',method:'GET',headers:{},body:''})).toBeNull();
  expect(await getSession(current.requestId)).toBeNull();
});
it('a result loses permission when the origin grant is revoked', async()=>{
  const current=session();await putSession(current);expect(await isLiveSession(current)).toBe(true);
  grants={};expect(await isLiveSession(current)).toBe(false);
});
it('an approval arriving before windows.create resolves still settles the requesting call', async()=>{
  createWindow=async({url})=>{
    const promptId=new URLSearchParams(new URL(url).hash.split('?')[1]).get('promptId')!;
    await resolvePrompt(promptId,true);return {id:9};
  };
  expect(await openPrompt({kind:'connect',origin:'https://app.uswap.net'})).toBe(true);
  expect(closed.size).toBe(0);
  expect(Object.keys(state)).toHaveLength(0);
});
it('closing an unanswered consent popup denies and cleans its pending state',async()=>{
  const result=openPrompt({kind:'connect',origin:'https://app.uswap.net'});
  await Bun.sleep(1);
  for(const listener of closed)listener(9);
  expect(await result).toBe(false);
  expect(closed.size).toBe(0);
  expect(Object.keys(state)).toHaveLength(0);
});
