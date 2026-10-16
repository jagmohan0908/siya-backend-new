import test from 'node:test';
import assert from 'node:assert/strict';
import {SupportTickets} from '../src/support-tickets.mjs';
import {createApi} from '../src/server.mjs';
import {SerialQueue} from '../src/store.mjs';
import {ApiError} from '../src/errors.mjs';
class Erp {
  docs=new Map();counter=0;
  async get(type,id) { const d=this.docs.get(type+'/'+id);if(!d) throw new ApiError(404,'not_found','Not found');return structuredClone(d); }
  async create(type,body) { const d={creation:'2026-10-12 13:00:00',modified:'2026-10-12 13:00:00',...body,name:body.name || 'TEST-'+(++this.counter)};this.docs.set(type+'/'+d.name,d);return structuredClone(d); }
  async update(type,id,body) { return this.create(type,{...await this.get(type,id),...body,name:id}); }
  async list(type,filters,fields,{offset=0,limit=50,order=''}={}) {
    return [...this.docs.entries()].filter(([k])=>k.startsWith(type+'/')).map(([,v])=>v)
      .filter(d=>Object.entries(filters).every(([k,v])=>Array.isArray(v)?v[0]==='in'?v[1].includes(d[k]):v[0]==='>='&&d[k]>=v[1]:d[k]===v))
      .sort((a,b)=>{for(const part of order.split(',')){const [k,dir]=part.trim().split(/\s+/);const c=String(a[k]||'').localeCompare(String(b[k]||''));if(c)return dir==='desc'?-c:c;}return 0;})
      .slice(offset,offset+limit).map(d=>structuredClone(d));
  }
}
async function setup() {
 const erp=new Erp();await erp.create('Mobile App User',{name:'ACCOUNT-A',email:'test@example.com'});
 const support=new SupportTickets({erp,identity:async()=>({erpUser:'ACCOUNT-A'})});
 return {erp,support};
}
const user={id:'gid://shopify/Customer/1'},app='siya-ayurveda';
const body={subject:'Delivery help',description:'Line one\n<unsafe>',priority:'medium',user_name:'Test customer'};
test('Seedfit ticket owner matches Frappe user identity while legacy tickets remain readable',async()=>{
 const {erp,support}=await setup();
 const owner=`seedfit:${user.id}`;
 await erp.create('Mobile App User',{name:owner,external_id:owner});
 support.service.identity=async()=>({erpUser:owner});
 const {ticket}=await support.create(user,'seedfit',body);
 const saved=await erp.get('Support Ticket',ticket.id);
 assert.equal(saved.user_id,owner);assert.equal(saved.custom_mobile_app_user,owner);
 assert.equal((await support.messages(user,'seedfit',ticket.id)).ticket.id,ticket.id);
 await erp.create('Support Ticket',{user_id:user.id,custom_mobile_app:'Seedfit',custom_mobile_app_user:owner});
 assert.equal((await support.list(user,'seedfit')).items.length,2);
 assert.equal((await support.list(user,'siya-ayurveda')).items.length,0);
 await assert.rejects(support.messages({id:'other'},'seedfit',ticket.id),{status:404});
});
test('ticket creation derives owner and app, persists on Support Ticket and escapes rich text',async()=>{
 const {erp,support}=await setup();
 const {ticket}=await support.create(user,app,{...body,user_id:'other',status:'Closed',custom_mobile_app:'Seedfit'});
 assert.equal(ticket.user_id,user.id);assert.equal(ticket.status,'open');assert.equal(ticket.description,body.description);
 const stored=await erp.get('Support Ticket',ticket.id);
 assert.equal(stored.custom_mobile_app,'Siya Ayurveda');assert.equal(stored.custom_mobile_app_user,'ACCOUNT-A');
 assert.equal(stored.description,'Line one<br>&lt;unsafe&gt;');
 assert.equal((await support.list(user,app)).items.length,1);
 assert.equal((await support.list(user,'seedfit')).items.length,0);
 assert.equal((await support.list({id:'other'},app)).items.length,0);
});
test('every detail, message, read and status operation verifies both account and app',async()=>{
 const {support}=await setup();const {ticket}=await support.create(user,app,body);
 for(const [u,a] of [[{id:'other'},app],[user,'seedfit']]) {
  for(const op of [()=>support.messages(u,a,ticket.id),()=>support.send(u,a,ticket.id,{message:'test'}),
    ()=>support.read(u,a,ticket.id,{message_ids:[]}),()=>support.close(u,a,ticket.id,{status:'closed'})]) await assert.rejects(op,{status:404});
 }
 await assert.rejects(support.list(user,'unknown'),{code:'invalid_app'});
 await assert.rejects(support.close(user,app,ticket.id,{status:'resolved'}),{status:400});
});
test('staff replies, waiting status, India timestamps, pagination and scoped read receipts',async()=>{
 const {support,erp}=await setup();const {ticket}=await support.create(user,app,body);
 const {message}=await support.send(user,app,ticket.id,{message:'Hello',sender_type:'Agent',sender_id:'other'});
 assert.equal(message.sender_type,'user');assert.equal(message.sender_id,user.id);
 const reply=await erp.create('Support Ticket Message',{ticket:ticket.id,sender_type:'Agent',sender_name:'Clinic',message:'<p>We can help</p>',timestamp:'2026-10-12 13:01:00',is_read:0});
 await erp.update('Support Ticket',ticket.id,{status:'Waiting for Customer'});
 const result=await support.messages(user,app,ticket.id);
 assert.equal(result.ticket.status,'waiting_for_customer');
 assert.equal(result.messages.find(m=>m.id===reply.name).message,'We can help');
 assert.equal(result.messages.find(m=>m.id===reply.name).created_at,'2026-10-12T13:01:00+05:30');
 const since=await support.messages(user,app,ticket.id,{since:'2026-10-12T07:31:00Z'});
 assert.ok(since.messages.some(m=>m.id===reply.name));
 assert.equal((await support.messages(user,app,ticket.id,{limit:1})).messages.length,1);
 const foreign=await erp.create('Support Ticket Message',{ticket:'OTHER',sender_type:'Agent'});
 await assert.rejects(support.read(user,app,ticket.id,{message_ids:[reply.name,foreign.name]}),{status:404});
 assert.equal((await erp.get('Support Ticket Message',reply.name)).is_read,0);
 await support.read(user,app,ticket.id,{message_ids:[reply.name,message.id]});
 assert.equal((await erp.get('Support Ticket Message',reply.name)).is_read,1);
 assert.equal((await erp.get('Support Ticket Message',message.id)).is_read,0);
 await support.close(user,app,ticket.id,{status:'closed'});
 await assert.rejects(support.send(user,app,ticket.id,{message:'After close'}),{status:409});
});
test('invalid inputs and ERP outages surface instead of empty success',async()=>{
 const {support}=await setup();
 await assert.rejects(support.create(user,app,{...body,subject:''}),{status:400});
 await assert.rejects(support.list(user,app,{page:-1}),{status:400});
 await assert.rejects(support.list(user,app,{status:'invalid'}),{status:400});
 support.erp.list=async()=>{throw new ApiError(503,'erp_unavailable','ERP unavailable');};
 await assert.rejects(support.list(user,app),{status:503});
});
test('HTTP support routes require authentication and ignore supplied customer IDs',async()=>{
 const {support}=await setup();
 const service={support,queue:new SerialQueue()};
 const server=createApi({service,authenticate:async token=>{if(token!=='Bearer test')throw new ApiError(401,'unauthenticated','Login required');return user;}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try {
  assert.equal((await fetch(base+'/v1/support-tickets')).status,401);
  const response=await fetch(base+'/v1/support-tickets?app=siya-ayurveda',{method:'POST',headers:{Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify({...body,user_id:'other'})});
  assert.equal(response.status,200);const {ticket}=await response.json();assert.equal(ticket.user_id,user.id);
  const read=await fetch(base+'/v1/support-tickets/'+ticket.id+'?app=seedfit',{headers:{Authorization:'Bearer test'}});
  assert.equal(read.status,404);
 } finally {await new Promise(resolve=>server.close(resolve));}
});
