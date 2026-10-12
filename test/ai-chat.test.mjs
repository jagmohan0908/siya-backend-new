import test from 'node:test';
import assert from 'node:assert/strict';
import {AiChat} from '../src/ai-chat.mjs';
import {createApi} from '../src/server.mjs';
import {SerialQueue} from '../src/store.mjs';
import {ApiError} from '../src/errors.mjs';

const user={id:'verified-customer'}, app='siya-ayurveda';
function setup() {
  const calls=[];
  const service={identity:async u=>({erpUser:'erp-'+u.id}),queue:new SerialQueue(),erp:{method:async(name,args,write)=>{
    calls.push({name,args,write});return {success:true,data:{conversation_id:args.conversation || '1',message_id:'2'}};
  }}};
  service.aiChat=new AiChat(service);return {service,calls,chat:service.aiChat};
}
test('AI sessions derive identity from login and retain explicit app scope',async()=>{
 const {chat,calls}=setup();
 await chat.call(user,app,'open_session',{external_id:'attacker',app_id:'seedfit'});
 assert.deepEqual(calls[0],{name:'sriaas_clinic.api.mobile_app_ai.open_session',args:{external_id:'erp-verified-customer',app_id:app},write:true});
 await assert.rejects(chat.call(user,'unknown','open_session'),{code:'invalid_app'});
});
test('message retries retain IDs, with separate namespaces for each owner/app/conversation',async()=>{
 const {chat,calls}=setup();const body={conversation:'1',message:' Hello ',client_message_id:'retry-id'};
 await chat.call(user,app,'send_message',body);await chat.call(user,app,'send_message',body);
 assert.equal(calls[0].args.client_message_id,calls[1].args.client_message_id);
 for(const [u,a,c] of [[{id:'other'},app,'1'],[user,'seedfit','1'],[user,app,'2']]) await chat.call(u,a,'send_message',{...body,conversation:c});
 assert.equal(new Set(calls.map(c=>c.args.client_message_id)).size,4);
 assert.equal(calls[0].args.message,'Hello');
 await assert.rejects(chat.call(user,app,'send_message',{...body,message:' '}),{status:400});
 await assert.rejects(chat.call(user,app,'send_message',{...body,message:'a'.repeat(4001)}),{status:400});
});
test('polling and escalation use scoped ERP methods; failures are not reported as sent',async()=>{
 const {service,chat,calls}=setup();
 await chat.call(user,app,'get_messages',{conversation:'1',after:'2',limit:999});
 assert.equal(calls[0].write,false);assert.equal(calls[0].args.after,'2');assert.equal(calls[0].args.limit,100);
 await chat.call(user,app,'escalate',{conversation:'1'});assert.equal(calls[1].write,true);
 service.erp.method=async()=>({success:false});
 await assert.rejects(chat.call(user,app,'open_session'),{status:502});
 service.erp.method=async()=>({success:true,data:{conversation_id:'foreign'}});
 await assert.rejects(chat.call(user,app,'get_messages',{conversation:'1'}),{status:502});
 service.erp.method=async()=>{throw new ApiError(503,'erp_unavailable','ERP unavailable');};
 await assert.rejects(chat.call(user,app,'open_session'),{status:503});
});
test('all four HTTP AI routes require authentication',async()=>{
 const {service,calls}=setup();
 const server=createApi({service,authenticate:async token=>{if(token!=='Bearer test')throw new ApiError(401,'unauthenticated','Login required');return user;}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try {
  for(const [method,path,body] of [['POST','session',{}],['GET','messages?conversation=1',null],['POST','messages',{conversation:'1',message:'Hello',client_message_id:'id'}],['POST','escalate',{conversation:'1'}]]) {
   const options={method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})};
   assert.equal((await fetch(`${base}/v1/ai-chat/${path}`,options)).status,401);
   options.headers.Authorization='Bearer test';
   assert.equal((await fetch(`${base}/v1/ai-chat/${path}`,options)).status,200);
  }
  assert.equal(calls.length,4);
 } finally {await new Promise(resolve=>server.close(resolve));}
});
