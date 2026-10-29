import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {MobileService} from '../src/service.mjs';
import {createApi} from '../src/server.mjs';
import {ApiError} from '../src/errors.mjs';

const now = Date.parse('2026-10-26T10:00:00Z');
const user={id:'gid://shopify/Customer/100',phone:'+919310220650'};
const other={id:'gid://shopify/Customer/200',phone:'+919873090386'};
const config={domain:'example.myshopify.com',secret:'test-signing-secret',enabled:true,now:()=>now};

class Erp {
  constructor(){ this.docs=new Map(); this.failGrant=false; }
  async maybe(type,name) { return structuredClone(this.docs.get(`${type}/${name}`) ?? null); }
  async get(type,name) { const value=await this.maybe(type,name); if(!value) throw new ApiError(404,'not_found','Not found'); return value; }
  async create(type,doc) {
    const name=doc.record_key || doc.name;
    if (this.failGrant && doc.kind==='order-owner') throw new ApiError(502,'erp_request_failed','Test outage');
    if(this.docs.has(`${type}/${name}`)) throw new ApiError(409,'revision_conflict','Duplicate');
    this.docs.set(`${type}/${name}`,{...structuredClone(doc),name}); return this.get(type,name);
  }
  async update(type,name,doc) { this.docs.set(`${type}/${name}`,{...await this.get(type,name),...structuredClone(doc)}); }
  async list(type,filters={},fields=[],{offset=0,limit=50,orFilters=[]}={}) {
    const match=(doc,key,operator,value)=>operator==='in' ? value.includes(doc[key]) : operator==='<' ? doc[key]<value : doc[key]===value;
    return [...this.docs.entries()].filter(([key])=>key.startsWith(`${type}/`)).map(([,doc])=>structuredClone(doc))
      .filter(doc=>Object.entries(filters).every(([key,value])=>Array.isArray(value) ? match(doc,key,...value) : doc[key]===value))
      .filter(doc=>!orFilters.length || orFilters.some(([key,operator,value])=>match(doc,key,operator,value)))
      .sort((a,b)=>String(b.posting_date || '').localeCompare(String(a.posting_date || '')) || b.name.localeCompare(a.name))
      .slice(offset,offset+limit);
  }
}
function setup(appId='siya-ayurveda',erp=new Erp()) {
  const service=new MobileService({erp,appId,checkoutTracking:config});
  service.identity=async account=>({patient:account.id===other.id?'PAT-B':null,customers:[]});
  service.invoiceShipment=async()=>null;
  return {service,erp,tracking:service.checkoutTracking};
}
async function begin(tracking,account=user){ return (await tracking.begin(account,{items:[{variantId:'123',quantity:2}]})).attributes; }
function delivery(attributes,changes={},headers={}) {
  const order={id:20834,created_at:new Date(now+1000).toISOString(),
    phone:other.phone,customer:{id:200},note_attributes:Object.entries(attributes).map(([name,value])=>({name,value})),
    line_items:[{variant_id:123,quantity:2,properties:[]}],...changes};
  const raw=Buffer.from(JSON.stringify(order));
  return [raw,{'x-shopify-hmac-sha256':createHmac('sha256',config.secret).update(raw).digest('base64'),
    'x-shopify-shop-domain':config.domain,'x-shopify-topic':'orders/create',...headers}];
}
test('different checkout phone is attributed only to the original authenticated account',async()=>{
  const {tracking}=setup(); const attributes=await begin(tracking);
  assert.deepEqual(await tracking.receive(...delivery(attributes)),{ok:true,tracked:true});
  assert.deepEqual(await tracking.ids(user),['20834']); assert.deepEqual(await tracking.ids(other),[]);
  assert.equal(await tracking.owns(user,{shopify_order_id:'20834'}),true);
  assert.equal(await tracking.owns(other,{shopify_order_id:'20834'}),false);
});
test('raw body signature, shop and topic are all required',async()=>{
  const {tracking}=setup(); const attributes=await begin(tracking);
  const [raw,headers]=delivery(attributes);
  await assert.rejects(tracking.receive(Buffer.concat([raw,Buffer.from(' ')]),headers),{code:'invalid_webhook'});
  for (const override of [{'x-shopify-hmac-sha256':'fake'},{'x-shopify-shop-domain':'another.myshopify.com'},{'x-shopify-topic':'orders/updated'}]) {
    await assert.rejects(tracking.receive(...delivery(attributes,{},override)),{code:'invalid_webhook'});
  }
  assert.deepEqual(await tracking.ids(user),[]);
});
test('repeated deliveries are idempotent and a reference cannot claim another order',async()=>{
  const {tracking}=setup(); const attributes=await begin(tracking);
  await tracking.receive(...delivery(attributes)); await tracking.receive(...delivery(attributes));
  await assert.rejects(tracking.receive(...delivery(attributes,{id:20835})),{code:'checkout_already_used'});
  assert.deepEqual(await tracking.ids(user),['20834']);
});
test('another account cannot replace an existing order owner with its own reference',async()=>{
  const {tracking}=setup(); await tracking.receive(...delivery(await begin(tracking)));
  await assert.rejects(tracking.receive(...delivery(await begin(tracking,other))),{code:'order_already_claimed'});
  assert.deepEqual(await tracking.ids(other),[]);
});
test('an ERP failure after claiming an order is recoverable on delivery retry',async()=>{
  const {tracking,erp}=setup(); const attributes=await begin(tracking);
  erp.failGrant=true; await assert.rejects(tracking.receive(...delivery(attributes)),{code:'erp_request_failed'});
  assert.deepEqual(await tracking.ids(user),[]);
  erp.failGrant=false; await tracking.receive(...delivery(attributes));
  assert.deepEqual(await tracking.ids(user),['20834']);
});
test('missing, unknown, expired and cart-mismatched references do not grant orders',async()=>{
  const {tracking}=setup(); const attributes=await begin(tracking);
  assert.deepEqual(await tracking.receive(...delivery({})),{ok:true,tracked:false});
  await assert.rejects(tracking.receive(...delivery({_mobile_checkout_reference:'a'.repeat(64)})),{code:'invalid_checkout_reference'});
  await assert.rejects(tracking.receive(...delivery(attributes,{created_at:new Date(now+86401000).toISOString()})),{code:'invalid_checkout_reference'});
  await assert.rejects(tracking.receive(...delivery(attributes,{line_items:[{variant_id:123,quantity:1}]})),{code:'checkout_cart_mismatch'});
  assert.deepEqual(await tracking.ids(user),[]);
});
test('Seedfit grants and references cannot cross into Siya even with the same customer ID',async()=>{
  const {tracking,erp}=setup(); const seed=setup('seedfit',erp).tracking;
  const attributes=await begin(tracking);
  await assert.rejects(seed.receive(...delivery(attributes)),{code:'invalid_checkout_reference'});
  await tracking.receive(...delivery(attributes));
  assert.deepEqual(await seed.ids(user),[]);
  assert.equal(await tracking.owns(user,{shopify_order_id:'20834',custom_app_brand:'Seedfit'}),false);
});
test('purchase grants allow invoice details but never create a patient association',async()=>{
  const {service,tracking,erp}=setup();
  await tracking.receive(...delivery(await begin(tracking)));
  await erp.create('Sales Invoice',{sr_si_patient_department:'Siya Ayurveda',name:'INV-1',docstatus:1,shopify_order_id:'20834',patient:'PAT-B',posting_date:'2026-10-26',items:[]});
  await erp.create('Sales Invoice',{sr_si_patient_department:'Siya Ayurveda',name:'INV-2',docstatus:1,shopify_order_id:'999',patient:'PAT-B',posting_date:'2026-10-26',items:[]});
  assert.equal((await service.ownedInvoice(user,'INV-1')).patient,null);
  await assert.rejects(service.ownedInvoice(user,'INV-2'),{status:404});
  await assert.rejects(service.patient(user),{code:'patient_link_required'});
  const result=await service.orders(user);
  assert.deepEqual(result.items.map(item=>item.id),['INV-1']);
});
test('rollout disabled preserves existing checkout and never issues a reference',async()=>{
  const {tracking}=setup(); tracking.enabled=false;
  assert.deepEqual(await tracking.begin(user,{}),{enabled:false});
});
test('tracked and patient invoices merge without duplicate entries across pages',async()=>{
  const {service,tracking,erp}=setup();
  service.identity=async()=>({patient:'PAT-A',customers:[]});
  await erp.create('Patient',{name:'PAT-A'});
  for(let i=0;i<25;i++) {
    const id=String(20834+i);
    await tracking.receive(...delivery(await begin(tracking),{id:Number(id)}));
    await erp.create('Sales Invoice',{sr_si_patient_department:'Siya Ayurveda',name:`INV-${id}`,shopify_order_id:id,patient:i%2?'PAT-A':'PAT-B',
      docstatus:1,posting_date:'2026-10-26',items:[]});
  }
  const first=await service.orders(user),second=await service.orders(user,first.nextCursor);
  assert.equal(first.items.length,20); assert.equal(second.items.length,5); assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,25);
});
test('HTTP webhook authenticates Shopify instead of requiring a customer token',async t=>{
  const {service,tracking}=setup();
  const server=createApi({service,authenticate:async auth=>{if(auth!=='Bearer test') throw new ApiError(401,'unauthenticated','Login required');return user;}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const attributes=await begin(tracking); const [raw,headers]=delivery(attributes);
  const response=await fetch(`${base}/v1/shopify-order-created`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:raw});
  assert.equal(response.status,200); assert.equal((await response.json()).tracked,true);
  const denied=await fetch(`${base}/v1/checkout-intents`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(denied.status,401);
});
