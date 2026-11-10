import { expect, it } from 'bun:test';
import { captureProgram } from '../src/modules/peer-capture/capture/programs';
import { parseProviderTemplate } from '../src/modules/peer-capture/templates/types';
import { selectCompletedProviderContext } from '../src/modules/peer-capture/capture/provider-request';
import { buyerSessionMaterial } from '../src/modules/peer-capture/capture/session-material';
import templateJson from './fixtures/transfer_xmoney.json';
import chimeJson from './fixtures/register_chime.json';

const join = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap(p=>Array.from(p)));
function varint(value: bigint | number): Uint8Array { let n=BigInt(value); const out=[]; do {let b=Number(n&127n);n>>=7n;if(n)b|=128;out.push(b)}while(n);return new Uint8Array(out); }
const uint=(field:number,value:bigint|number)=>join(varint(field*8),varint(value));
const data=(field:number,value:Uint8Array)=>join(varint(field*8+2),varint(value.length),value);
const text=(field:number,value:string)=>data(field,new TextEncoder().encode(value));
function transaction(id:string,direction:number,recipient:string,amount:number) {
 const presentation=join(data(1,uint(1,1794000000)),uint(2,direction),data(4,uint(1,amount)),data(11,data(2,join(uint(1,12345),text(3,recipient)))));
 return data(1,join(text(1,id),uint(7,2),data(34,presentation)));
}
function grpc(body:Uint8Array,status='0') {
 const frame=(flag:number,payload:Uint8Array)=>{const h=new Uint8Array(5);h[0]=flag;new DataView(h.buffer).setUint32(1,payload.length);return join(h,payload)};
 return Buffer.from(join(frame(0,body),frame(128,new TextEncoder().encode(`grpc-status: ${status}\r\n`)))).toString('base64');
}
const template=parseProviderTemplate(templateJson);
const request={method:'POST',url:template.url,body:String.fromCharCode(0,0,0,0,8,26,6,8,1,16,6,24,25)};
it('decodes outgoing X Money payments without renumbering filtered rows or changing amount, currency, recipient or proof ID',()=>{
 const body=grpc(join(transaction('incoming',1,'first',1_000_000),transaction('payment-b',2,'Alice',50_000_000),transaction('payment-c',2,'Bob',70_000_000)));
 const rows=captureProgram(template)!.capture({event:{request,response:{status:200,body,bodyEncoding:'base64'}},params:{}});
 expect(rows).toEqual([
  {originalIndex:1,hidden:false,params:{PAYMENT_ID:'payment-b'},amount:'50000000',currency:'USD',recipient:'alice',paymentId:'payment-b',date:'1794000000000',direction:'Debit',transferStatus:'SETTLED'},
  {originalIndex:2,hidden:false,params:{PAYMENT_ID:'payment-c'},amount:'70000000',currency:'USD',recipient:'bob',paymentId:'payment-c',date:'1794000000000',direction:'Debit',transferStatus:'SETTLED'},
 ]);
 expect(()=>captureProgram(template)!.capture({event:{request,response:{status:200,body:grpc(transaction('a',2,'alice',50_000_000),'7'),bodyEncoding:'base64'}},params:{}})).toThrow('gRPC request did not succeed');
});
it('keeps the exact X Money binary request and URL inside the encrypted session',()=>{
 const material=buyerSessionMaterial({platform:'xmoney',actionType:'transfer_xmoney',captured:{...request,headers:{Cookie:'secret-cookie'}}});
 expect(material).toEqual({Cookie:'secret-cookie',body:request.body,url:request.url});
});
it('waits past unrelated Chime GraphQL requests for the pinned identity query',()=>{
 const template=parseProviderTemplate(chimeJson);
 const base={requestId:'r',tabId:1,url:template.url,method:'POST',type:'xmlhttprequest' as const,initiator:null,statusCode:200,timestamp:1};
 const wrong={...base,requestBody:JSON.stringify({operationName:'OtherQuery'})};
 const good={...base,requestId:'good',requestBody:JSON.stringify({operationName:'UserQuery',variables:{},extensions:{persistedQuery:{version:1,sha256Hash:'md5:f4a5ebcc4103cf23f7e582af45b0edd0'}}})};
 expect(selectCompletedProviderContext([wrong],template)).toBeNull();
 expect(selectCompletedProviderContext([wrong,good],template)?.request.requestId).toBe('good');
});
