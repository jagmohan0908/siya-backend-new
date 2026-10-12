import test from 'node:test';
import assert from 'node:assert/strict';
import {AiChat,mobileContactKey} from '../src/ai-chat.mjs';
import {SupportTickets} from '../src/support-tickets.mjs';
import {createApi} from '../src/server.mjs';
import {SerialQueue} from '../src/store.mjs';
import {ApiError} from '../src/errors.mjs';

class Erp {
  docs=new Map();counter=0;
  async get(type,id) {const d=this.docs.get(type+'/'+id);if(!d)throw new ApiError(404,'not_found','Not found');return structuredClone(d);}
  async maybe(type,id) {try{return await this.get(type,id)}catch(e){if(e.status===404)return null;throw e}}
  async create(type,body) {
    const name=body.name || (type==='Chat Contact'?'mobile-'+body.mobile_account_key:String(++this.counter));
    if(this.docs.has(type+'/'+name) || [...this.docs.values()].some(d=>
      (body.dedupe_key && d.dedupe_key===body.dedupe_key) ||
      (body.custom_mobile_previous_chat && d.custom_mobile_previous_chat===body.custom_mobile_previous_chat)))throw new ApiError(409,'revision_conflict','Duplicate');
    const d={creation:`2026-10-12 12:00:${String(this.counter).padStart(2,'0')}`,...body,name};
    this.docs.set(type+'/'+name,structuredClone(d));return structuredClone(d);
  }
  async list(type,filters,fields,{limit=50,order=''}={}) {
    return [...this.docs.entries()].filter(([k])=>k.startsWith(type+'/')).map(([,d])=>d)
      .filter(d=>Object.entries(filters).every(([k,v])=>Array.isArray(v)?
        v[0]==='in'?v[1].includes(d[k]):v[0]==='not in'?!v[1].includes(d[k]):v[0]==='>='&&d[k]>=v[1]:String(d[k])===String(v)))
      .sort((a,b)=>{for(const part of order.split(',')){const [k,dir]=part.trim().split(/\s+/);const c=String(a[k]||'').localeCompare(String(b[k]||''),undefined,{numeric:true});if(c)return dir==='desc'?-c:c}return 0})
      .slice(0,limit).map(d=>structuredClone(fields?.length?Object.fromEntries(fields.map(k=>[k,d[k]])):d));
  }
}
const user={id:'customer'},app='siya-ayurveda';
async function setup() {
 const erp=new Erp();
 for(const id of ['customer','other'])await erp.create('Mobile App User',{name:'erp-'+id,is_active:1,profiles:[],full_name:'Test user'});
 for(const name of ['Siya Ayurveda Patient App','Seedfit Patient App'])await erp.create('Chat Channel Account',{name,channel_type:'Mobile App',is_active:1});
 await erp.create('WA Chat Hub Settings',{name:'WA Chat Hub Settings',enable_ai_autopilot:1,autopilot_mode:'Limited Auto Reply',service_user:'erp-ai'});
 const service={erp,identity:async u=>({erpUser:'erp-'+u.id}),queue:new SerialQueue()};
 service.support=new SupportTickets(service);service.aiChat=new AiChat(service);
 const session=await service.aiChat.call(user,app,'open_session');
 return {service,erp,chat:service.aiChat,id:session.data.conversation_id};
}
test('contact identity matches native ERP contract and never uses a phone or marks a patient verified',async()=>{
 assert.equal(mobileContactKey('Siya Ayurveda Patient App','gid://shopify/Customer/8971995087157',''),'eedbd9be0614bcea64eeab35f65dc22e0138efaffea8318a4dbba81db3a58f54');
 const {chat,erp,id}=await setup();
 const session=await chat.call(user,app,'open_session',{external_id:'other',app_id:'seedfit'});
 assert.equal(session.data.conversation_id,id);assert.equal(session.data.identity_status,'Unverified');
 const [contact]=await erp.list('Chat Contact',{},[]);assert.equal(contact.mobile_app_user,'erp-customer');assert.equal(contact.phone_number,undefined);assert.equal(contact.linked_patient,undefined);
 await assert.rejects(chat.call(user,'unknown','open_session'),{code:'invalid_app'});
});
test('each operation rejects another customer or app before reading messages or writing records',async()=>{
 const {chat,id}=await setup();
 for(const [u,a] of [[{id:'other'},app],[user,'seedfit']])for(const action of ['get_messages','new_session','send_message','escalate'])
  await assert.rejects(chat.call(u,a,action,{conversation:id,message:'Hello',client_message_id:'id'}),{status:404});
});
test('ERP-masked contact references are verified through an exact ownership filter',async()=>{
 const {chat,erp,id}=await setup();const get=erp.get.bind(erp);
 erp.get=async(t,n)=>{const d=await get(t,n);if(t==='Chat Conversation')d.contact='[masked]';return d};
 assert.equal((await chat.call(user,app,'get_messages',{conversation:id})).data.conversation_id,id);
 await assert.rejects(chat.call({id:'other'},app,'get_messages',{conversation:id}),{status:404});
});
test('new chat is retry-safe, preserves history, and reopening picks the newest created chat',async()=>{
 const {chat,erp,id}=await setup();await chat.call(user,app,'send_message',{conversation:id,message:'Old message',client_message_id:'old'});
 const fresh=await chat.call(user,app,'new_session',{conversation:id});assert.notEqual(fresh.data.conversation_id,id);assert.deepEqual(fresh.data.messages,[]);
 assert.equal((await chat.call(user,app,'new_session',{conversation:id})).data.conversation_id,fresh.data.conversation_id);
 await erp.create('Chat Message',{conversation:id,direction:'Outbound',sender_type:'AI',body:'Late reply'});
 assert.equal((await chat.call(user,app,'open_session')).data.conversation_id,fresh.data.conversation_id);
 assert.equal((await chat.call(user,app,'get_messages',{conversation:id})).data.messages.length,2);
});
test('retries persist one incoming message; changed payloads cannot reuse its key',async()=>{
 const {chat,erp,id}=await setup();const body={conversation:id,message:' Hello ',client_message_id:'retry'};
 const first=await chat.call(user,app,'send_message',body),second=await chat.call(user,app,'send_message',body);
 assert.equal(first.data.message_id,second.data.message_id);assert.equal(second.data.duplicate,true);
 assert.equal((await erp.list('Chat Message',{},[])).length,1);
 await assert.rejects(chat.call(user,app,'send_message',{...body,message:'Different'}),{status:409});
 await assert.rejects(chat.call(user,app,'send_message',{...body,message:' '}),{status:400});
 await assert.rejects(chat.call(user,app,'send_message',{...body,message:'x'.repeat(4001)}),{status:400});
});
test('history excludes staff notes and rejects foreign and internal-note cursors',async()=>{
 const {chat,erp,id}=await setup();
 const msg=await erp.create('Chat Message',{conversation:id,direction:'Outbound',sender_type:'AI',body:'Visible'});
 const note=await erp.create('Chat Message',{conversation:id,direction:'Internal Note',sender_type:'Agent',body:'Private'});
 const other=await erp.create('Chat Message',{conversation:'foreign',direction:'Inbound',body:'Other user'});
 const messages=(await chat.call(user,app,'get_messages',{conversation:id})).data.messages;
 assert.deepEqual(messages.map(m=>m.message),['Visible']);assert.equal(messages[0].id,String(msg.name));
 for(const row of [note,other])await assert.rejects(chat.call(user,app,'get_messages',{conversation:id,after:row.name}),{status:404});
});
test('care-team requests use existing support tickets and retries do not duplicate them',async()=>{
 const {chat,erp,id}=await setup();const a=await chat.call(user,app,'escalate',{conversation:id}),b=await chat.call(user,app,'escalate',{conversation:id});
 assert.equal(a.data.ticket,b.data.ticket);assert.equal(b.data.created,false);
 const ticket=await erp.get('Support Ticket',a.data.ticket);assert.equal(ticket.user_id,user.id);assert.equal(ticket.custom_mobile_app,'Siya Ayurveda');
});
test('inactive accounts and ambiguous profiles fail closed',async()=>{
 const {chat,erp}=await setup();const parent=erp.docs.get('Mobile App User/erp-customer');parent.is_active=0;
 await assert.rejects(chat.call(user,app,'open_session'),{status:403});parent.is_active=1;parent.profiles=[{name:'a'},{name:'b'}];
 await assert.rejects(chat.call(user,app,'open_session'),{code:'chat_profile_required'});
});
test('all five HTTP routes require login; normal authenticated routes use only ERP records',async()=>{
 const {service,id}=await setup();const server=createApi({service,authenticate:async token=>{if(token!=='Bearer test')throw new ApiError(401,'unauthenticated','Login required');return user}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try {for(const [method,path,body] of [['POST','session',{}],['POST','new-session',{conversation:id}],['GET',`messages?conversation=${id}`,null],['POST','messages',{conversation:id,message:'Hi',client_message_id:'one'}],['POST','escalate',{conversation:id}]]){
  const opts={method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})};
  assert.equal((await fetch(`${base}/v1/ai-chat/${path}`,opts)).status,401);opts.headers.Authorization='Bearer test';
  assert.equal((await fetch(`${base}/v1/ai-chat/${path}`,opts)).status,200);
 }}finally{await new Promise(r=>server.close(r))}
});

test('backend catalogue facts reach ERP while app messages retain original text; retry reuses snapshot',async()=>{
 const {chat,service,erp,id}=await setup();let searches=0;
 const card={type:'product',product_id:'gid://shopify/Product/1',title:'Acne Gel',description:'Catalogue facts',price:'699',currency:'INR',available:true,url:'https://siyaayurveda.com/products/acne-gel',image_url:'https://cdn.shopify.com/a.png'};
 service.chatProducts=async()=>{searches++;return [card]};
 const body={conversation:id,message:'Show acne products',client_message_id:'catalogue'};
 const sent=await chat.call(user,app,'send_message',body);await chat.call(user,app,'send_message',body);assert.equal(searches,1);
 const incoming=await erp.get('Chat Message',sent.data.message_id);assert.match(incoming.body,/App catalogue reference/);
 await erp.create('Chat Message',{conversation:id,direction:'Outbound',sender_type:'AI',body:'Here are catalogue options',raw_transport_payload:JSON.stringify({source:'ai_autopilot',reply_to_message:incoming.name})});
 const messages=(await chat.call(user,app,'get_messages',{conversation:id})).data.messages;
 assert.equal(messages[0].message,body.message);assert.deepEqual(messages[1].cards,[card]);
});
test('cards require exact ERP reply binding and reject cross-conversation or cross-app metadata',async()=>{
 const {chat,erp,id}=await setup();
 const card={type:'product',product_id:'gid://shopify/Product/1',title:'Acne Gel',price:'1',currency:'INR',url:'https://siyaayurveda.com/products/acne-gel'};
 const inbound=await erp.create('Chat Message',{conversation:'foreign',direction:'Inbound',sender_type:'Customer',provider_name:'Mobile App',raw_transport_payload:JSON.stringify({source:'siya_backend_catalog_v1',appId:app,cards:[card]})});
 const reply={conversation:id,direction:'Outbound',sender_type:'AI',body:'Reply',raw_transport_payload:JSON.stringify({source:'ai_autopilot',reply_to_message:inbound.name})};
 await erp.create('Chat Message',reply);
 assert.deepEqual((await chat.call(user,app,'get_messages',{conversation:id})).data.messages[0].cards,[]);
 const stored=erp.docs.get('Chat Message/'+inbound.name);stored.conversation=id;stored.raw_transport_payload=JSON.stringify({source:'siya_backend_catalog_v1',appId:'seedfit',cards:[card]});
 assert.deepEqual((await chat.call(user,app,'get_messages',{conversation:id})).data.messages.at(-1).cards,[]);
 reply.raw_transport_payload='{}';await erp.create('Chat Message',reply);
 assert.deepEqual((await chat.call(user,app,'get_messages',{conversation:id})).data.messages.at(-1).cards,[]);
});
