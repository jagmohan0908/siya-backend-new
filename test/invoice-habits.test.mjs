import test from 'node:test';
import assert from 'node:assert/strict';
import {MobileService} from '../src/service.mjs';
import {habitDay} from '../src/invoice-habits.mjs';
import {ApiError} from '../src/errors.mjs';
import {createApi} from '../src/server.mjs';

const user={id:'account-a'};
const app='siya-ayurveda';
class Erp {
  docs=new Map();
  add(type,doc) { this.docs.set(`${type}/${doc.name}`,structuredClone(doc)); }
  async maybe(type,name) { return structuredClone(this.docs.get(`${type}/${name}`) || null); }
  async get(type,name) {
    const doc=await this.maybe(type,name);
    if(!doc) throw new ApiError(404,'not_found','Not found');
    return doc;
  }
  async create(type,doc) { const result={...doc,name:doc.record_key}; this.add(type,result); return result; }
  async update(type,name,fields) { const result={...await this.get(type,name),...fields}; this.add(type,result); return result; }
  async list(type,filters,fields,{offset=0,limit=50,orFilters,order=''}={}) {
    const match=(doc,key,op,value)=> op==='in' ? value.includes(doc[key]) : op==='<' ? doc[key]<value : doc[key]===value;
    return [...this.docs.entries()].filter(([key])=>key.startsWith(`${type}/`)).map(([,doc])=>doc)
      .filter(doc=>Object.entries(filters).every(([key,value])=>Array.isArray(value)?match(doc,key,...value):doc[key]===value))
      .filter(doc=>!orFilters || orFilters.some(([key,op,value])=>match(doc,key,op,value)))
      .sort((a,b)=>{
        for(const part of order.split(',')) {
          const [field,direction]=part.trim().split(/\s+/);
          const result=String(a[field] || '').localeCompare(String(b[field] || ''));
          if(result) return direction==='desc'?-result:result;
        }
        return 0;
      }).slice(offset,offset+limit).map(doc=>structuredClone(doc));
  }
}
function setup() {
  const erp=new Erp();
  const service=new MobileService({erp,productImage:async item=>`https://images.test/${item.item_code}.jpg`});
  service.patient=async u=>({name:u.id==='account-a'?'PAT-A':'PAT-B',patient_name:'Test Patient'});
  service.identity=async u=>({erpUser:u.id,customers:['SHARED-CUSTOMER']});
  erp.add('Mobile App User',{name:user.id,custom_habit_trackers:[],profiles:[{patient_id:'PAT-A'}]});
  erp.add('Item',{name:'CREAM',custom_mobile_habit_frequency:'twiceDaily',custom_mobile_habit_id:'vitiligo_cream'});
  erp.add('Item',{name:'WASH'});
  const invoice={name:'INV/1',patient:'PAT-A',customer:'SHARED-CUSTOMER',docstatus:1,is_return:0,
    posting_date:'2026-10-08',status:'Unpaid',items:[{item_code:'CREAM',item_name:'Single cream',qty:2,uom:'Nos'},
      {item_code:'WASH',item_name:'Single wash',qty:1,uom:'Nos'}]};
  erp.add('Sales Invoice',invoice);
  return {erp,service,invoice};
}

test('invoice kit title comes from its template and items from the submitted invoice',async()=>{
  const {erp,service,invoice}=setup();
  erp.add('Item Group Template',{name:'IGT-1',template_name:'Real kit name',items:[{item_code:'NOT-PURCHASED'}]});
  erp.add('Sales Invoice',{...invoice,item_group_template:'IGT-1'});
  erp.add('Sales Invoice',{...invoice,name:'DRAFT',docstatus:0});
  const result=await service.erpHabitTracker(user,app);
  assert.equal(result.orders.length,1);assert.equal(result.orders[0].kit.name,'Real kit name');
  assert.equal(result.orders[0].paymentStatus,'Unpaid');
  assert.deepEqual(result.orders[0].items.map(i=>i.code),['CREAM','WASH']);
  assert.equal(result.data.habits.length,2);
  assert.equal(result.orders[0].items[0].frequency,'twiceDaily');
  assert.equal(result.orders[0].items[1].instructions,'Follow your prescription or product instructions');
  const detail=await service.invoice(user,'INV/1');
  assert.equal(detail.kit.name,'Real kit name');
  assert.deepEqual(detail.items.map(i=>i.code),['CREAM','WASH']);
});

test('only the latest purchase supplies habits while invoice pagination stays available',async()=>{
  const {erp,service,invoice}=setup();
  for(let i=2;i<=25;i++) erp.add('Sales Invoice',{...invoice,name:`INV/${i}`});
  erp.add('Sales Invoice',{...invoice,name:'LATEST',posting_date:'2026-10-09',items:[invoice.items[1]]});
  const first=await service.habitOrders(user,app,0);
  assert.equal(first.items.length,20);assert.equal(first.nextCursor,20);
  const tracker=await service.erpHabitTracker(user,app);
  assert.equal(tracker.orders.length,1);assert.equal(tracker.orders[0].id,'LATEST');
  assert.equal(tracker.orders[0].kit,null);
  assert.deepEqual(tracker.data.habits.map(h=>h.id),['erp:WASH']);
  await assert.rejects(service.saveErpHabitTracker(user,{date:tracker.today,revision:0,
    data:changes(tracker.data)},app),{status:400});
  await assert.rejects(service.habitOrders(user,app,-1),{status:400});
});

test('same-day purchases use creation time and retain past check-ins',async()=>{
  const {erp,service,invoice}=setup();
  erp.add('Sales Invoice',{...invoice,name:'ZZ-OLD',creation:'2026-10-08 09:00:00'});
  erp.add('Sales Invoice',{...invoice,name:'AA-NEW',creation:'2026-10-08 11:00:00',items:[invoice.items[1]]});
  await service.records.write(user.id,'habits','self',{
    dailyCompliance:{'2020-01-01':{completedHabits:{vitiligo_cream:true}}}},0);
  const tracker=await service.erpHabitTracker(user,app);
  assert.equal(tracker.orders[0].id,'AA-NEW');
  assert.equal(tracker.data.dailyCompliance['2020-01-01'].completedHabits.vitiligo_cream,true);
});

test('latest authorized purchase is found beyond another patient shared-customer invoices',async()=>{
  const {erp,service,invoice}=setup();
  for(let i=0;i<23;i++) erp.add('Sales Invoice',{...invoice,name:`OTHER/${i}`,patient:'PAT-B',posting_date:'2026-10-09'});
  const tracker=await service.erpHabitTracker(user,app);
  assert.deepEqual(tracker.orders.map(o=>o.id),['INV/1']);
});

const changes=(data,done=true)=>({...data,dailyCompliance:{...data.dailyCompliance,
  [habitDay()]:{completedHabits:{'vitiligo_cream':done},completedHabitTimes:{vitiligo_cream_morning:done,vitiligo_cream_evening:done}}}});

test('check-ins persist on the verified Mobile App User child row and preserve other tabs and app records',async()=>{
  const {erp,service}=setup();
  const initial=await service.erpHabitTracker(user,app);
  const saved=await service.saveErpHabitTracker(user,{date:initial.today,revision:0,data:changes(initial.data)},app);
  assert.equal(saved.revision,1);
  const parent=await erp.get('Mobile App User',user.id);
  assert.equal(parent.custom_habit_trackers.length,1);assert.equal(parent.custom_habit_trackers[0].app,'Siya Ayurveda');
  assert.deepEqual(parent.profiles,[{patient_id:'PAT-A'}]);
  assert.equal(JSON.parse(parent.custom_habit_trackers[0].payload).dailyCompliance[initial.today].completedHabits.vitiligo_cream,true);
  assert.equal((await service.erpHabitTracker(user,'seedfit')).revision,0);
  const seed=await service.erpHabitTracker(user,'seedfit');
  await service.saveErpHabitTracker(user,{date:seed.today,revision:0,data:changes(seed.data,false)},'seedfit');
  assert.equal((await erp.get('Mobile App User',user.id)).custom_habit_trackers.length,2);
  const read=await service.erpHabitTracker(user,app);
  assert.equal(read.data.dailyCompliance[initial.today].completedHabits.vitiligo_cream,true);
  await assert.rejects(service.saveErpHabitTracker(user,{date:initial.today,revision:0,data:changes(initial.data)},app),{code:'revision_conflict'});
  await assert.rejects(service.saveErpHabitTracker(user,{date:'2020-01-01',revision:1,data:changes(initial.data)},app),{code:'day_changed'});
  await service.saveErpHabitTracker(user,{date:initial.today,revision:1,data:changes(read.data,false)},app);
  assert.equal((await service.erpHabitTracker(user,'seedfit')).revision,1);
});

test('the approved-plan reward still requires 30 real days and is issued only once',async()=>{
  const {erp,service}=setup();
  const dailyCompliance={};
  const cursor=new Date(`${habitDay()}T12:00:00Z`);
  for(let i=0;i<29;i++) {
    cursor.setUTCDate(cursor.getUTCDate()-1);
    dailyCompliance[cursor.toISOString().slice(0,10)]={completedHabits:{'erp:WASH':true},
      completedHabitTimes:{vitiligo_cream_morning:true,vitiligo_cream_evening:true}};
  }
  await service.records.write(user.id,'habits','self',{dailyCompliance,rewards:[]},0);
  await service.records.write(user.id,'habit_plan','self',{habitIds:['vitiligo_cream','erp:WASH']},0);
  let issued=0;service.rewardIssuer=async()=>{issued++;};
  const initial=await service.erpHabitTracker(user,app);
  const data=changes(initial.data);data.dailyCompliance[initial.today].completedHabits['erp:WASH']=true;
  const saved=await service.saveErpHabitTracker(user,{date:initial.today,revision:0,data},app);
  assert.equal(saved.data.currentStreak,30);assert.equal(saved.data.rewards.length,1);assert.equal(issued,1);
  await service.saveErpHabitTracker(user,{date:initial.today,revision:saved.revision,data},app);
  assert.equal(issued,1);
  assert.equal((await erp.get('Mobile App User',user.id)).custom_habit_trackers.length,1);
});

test('tampered habits, rewards, history, streak and unknown products cannot overwrite ERP truth',async()=>{
  const {service}=setup();
  await service.records.write(user.id,'habits','self',{dailyCompliance:{'2020-01-01':{completedHabits:{old:true}}},rewards:[]},0);
  const initial=await service.erpHabitTracker(user,app);
  const data=changes(initial.data);
  data.currentStreak=999;data.rewards=[{couponCode:'FAKE'}];data.habits=[{id:'FAKE'}];
  data.dailyCompliance['2020-01-01']={completedHabits:{old:false}};
  const saved=await service.saveErpHabitTracker(user,{date:initial.today,revision:0,data},app);
  assert.equal(saved.data.currentStreak,0);assert.deepEqual(saved.data.rewards,[]);
  assert.equal(saved.data.habits.length,2);
  assert.equal(saved.data.dailyCompliance['2020-01-01'].completedHabits.old,true);
  data.dailyCompliance[initial.today].completedHabits.FAKE=true;
  await assert.rejects(service.saveErpHabitTracker(user,{date:initial.today,revision:1,data},app),{status:400});
});

test('other patients, cancelled invoices and fully returned products never grant tracking eligibility',async()=>{
  const {erp,service,invoice}=setup();
  erp.add('Sales Invoice',{...invoice,name:'OTHER',patient:'PAT-B'});
  erp.add('Sales Invoice',{...invoice,name:'CANCELLED',docstatus:2});
  erp.add('Sales Invoice',{...invoice,name:'CREDIT',is_return:1,return_against:'INV/1',items:[{item_code:'WASH',qty:-1}]});
  const result=await service.erpHabitTracker(user,app);
  assert.equal(result.orders.length,1);assert.equal(result.data.habits.length,1);
  assert.equal(result.orders[0].items[1].canTrack,false);
  const data=changes(result.data);data.dailyCompliance[result.today].completedHabits['erp:WASH']=true;
  await assert.rejects(service.saveErpHabitTracker(user,{date:result.today,revision:0,data},app),{status:400});
  await assert.rejects(service.erpHabitTracker(user,'unknown'),{code:'invalid_app'});
});

test('returns use stock quantities when invoice and credit-note units differ',async()=>{
  const {erp,service,invoice}=setup();
  erp.add('Sales Invoice',{...invoice,items:[{item_code:'CREAM',qty:1,stock_qty:12,uom:'Box'},
    {item_code:'CREAM',qty:6,stock_qty:6,uom:'Nos'}]});
  erp.add('Sales Invoice',{...invoice,name:'CREDIT',is_return:1,return_against:'INV/1',items:[{item_code:'CREAM',qty:-18,stock_qty:-18}]});
  const result=await service.erpHabitTracker(user,app);
  assert.equal(result.data.habits.length,0);assert.equal(result.orders[0].items.length,1);
});

test('only real encounter prescriptions appear; appointments, other patients and cancelled encounters stay hidden',async()=>{
  const {erp,service}=setup();
  erp.add('Patient Encounter',{name:'EMPTY',patient:'PAT-A',docstatus:0,drug_prescription:[]});
  erp.add('Patient Encounter',{name:'OTHER',patient:'PAT-B',docstatus:0,drug_prescription:[{drug_name:'Private'}]});
  erp.add('Patient Encounter',{name:'CANCELLED',patient:'PAT-A',docstatus:2,drug_prescription:[{drug_name:'Cancelled'}]});
  assert.deepEqual((await service.habitPrescriptions(user,app)).items,[]);
  erp.add('SR Instruction',{name:'INS',sr_description:'Recorded clinic instruction'});
  erp.add('Patient Encounter',{name:'RX',patient:'PAT-A',docstatus:0,encounter_date:'2026-10-08',
    sr_ayurvedic_practitioner_name:'Actual Doctor',
    drug_prescription:[{drug_code:'CREAM',drug_name:'Prescribed Cream',sr_drug_instruction:'INS',dosage:'Clinic dosage'}]});
  const {items}=await service.habitPrescriptions(user,app);
  assert.equal(items.length,1);assert.equal(items[0].groups[0].practitioner,'Actual Doctor');
  assert.equal(items[0].groups[0].items[0].instructions,'Recorded clinic instruction');
  assert.equal(items[0].diagnosis,'');
});

test('HTTP tracker routes enforce authentication and carry app-scoped revisions',async()=>{
  const {service}=setup();
  const server=createApi({service,authenticate:async token=>{
    if(token!=='Bearer verified') throw new ApiError(401,'unauthenticated','Sign in');
    return user;
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/v1/habit-tracker`)).status,401);
    const options={headers:{Authorization:'Bearer verified','Content-Type':'application/json'}};
    const route=`${url}/v1/habit-tracker?app=seedfit`;
    const response=await fetch(route,options);assert.equal(response.status,200);
    const state=await response.json();
    const save=await fetch(route,{...options,method:'PUT',body:JSON.stringify({date:state.today,revision:0,data:changes(state.data)})});
    assert.equal(save.status,200);assert.equal((await save.json()).revision,1);
    assert.equal((await fetch(`${url}/v1/habit-prescriptions`,options)).status,200);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});


test('single-product habit purchases carry the matched Shopify reorder product ID',async()=>{
  const {erp,service,invoice}=setup();
  erp.add('Sales Invoice',{...invoice,items:[invoice.items[0]]});
  service.productCatalog=async item=>{
    assert.equal(item.item_code,'CREAM');
    return {imageUrl:'https://cdn.shopify.com/cream.jpg',shopifyProductId:'gid://shopify/Product/123'};
  };
  const tracker=await service.erpHabitTracker(user,app);
  assert.equal(tracker.orders[0].kit,null);
  assert.equal(tracker.orders[0].items[0].shopifyProductId,'gid://shopify/Product/123');
  assert.equal(tracker.orders[0].items[0].imageUrl,'https://cdn.shopify.com/cream.jpg');
});

async function trackPurchase(service, account, orderId, appId=service.appId) {
  service.checkoutTracking.domain='test.myshopify.com';
  await service.records.write(account.id,'order-owner',orderId,{orderId,appId,shopDomain:'test.myshopify.com'},0);
}

test('tracked purchase supplies diet, PDF and habit products despite different invoice Patient',async()=>{
  const {erp,service,invoice}=setup();
  service.identity=async()=>({erpUser:user.id,patient:'PAT-A'});
  erp.add('Patient',{name:'PAT-A'});
  erp.add('Sales Invoice',{...invoice,patient:'PAT-B',shopify_order_id:'123',custom_app_brand:'Siya Ayurveda'});
  erp.add('Diet Chart',{name:'DIET',custom_items:[{item_code:'CREAM'}],custom_diet_chart_pdf:'/files/diet.pdf'});
  erp.url='https://erp.test';erp.request=async()=>new Response('%PDF-synthetic');
  await trackPurchase(service,user,'123');
  assert.deepEqual((await service.diets(user)).items.map(d=>d.id),['DIET']);
  assert.equal(await (await service.dietPdf(user,'DIET')).text(),'%PDF-synthetic');
  assert.deepEqual((await service.habitOrders(user,app)).items.map(i=>i.id),['INV/1']);
  assert.equal((await service.erpHabitTracker(user,app)).data.habits.length,2);
  assert.deepEqual((await service.habitPrescriptions(user,app)).items,[]);
  // Revocation is effective on the next read, including PDF downloads.
  erp.docs.delete(`Siya Mobile Record/${service.records.key(user.id,'order-owner','123')}`);
  assert.deepEqual((await service.diets(user)).items,[]);
  await assert.rejects(service.dietPdf(user,'DIET'),{status:404});
  assert.deepEqual((await service.habitOrders(user,app)).items,[]);
});

test('purchase charts work without a Patient link; other brands and accounts get no grant',async()=>{
  const {erp,service,invoice}=setup();
  service.identity=async()=>({erpUser:user.id,patient:null});
  service.patient=async()=>{throw new ApiError(409,'patient_link_required','Link required');};
  erp.add('Sales Invoice',{...invoice,patient:'PAT-B',shopify_order_id:'123',custom_app_brand:'Siya Ayurveda'});
  erp.add('Diet Chart',{name:'DIET',custom_items:[{item_code:'CREAM'}]});
  await trackPurchase(service,user,'123');
  assert.equal((await service.diets(user)).items.length,1);
  assert.equal((await service.habitOrders(user,app)).items.length,1);
  await assert.rejects(service.diets({id:'other-account'}),{code:'patient_link_required'});
  erp.add('Sales Invoice',{...invoice,patient:'PAT-B',shopify_order_id:'123',custom_app_brand:'Seedfit'});
  await assert.rejects(service.diets(user),{code:'patient_link_required'});
});

test('returns revoke purchase chart and tracking even when credit note has another Patient',async()=>{
  const {erp,service,invoice}=setup();
  service.identity=async()=>({erpUser:user.id,patient:'PAT-A'});erp.add('Patient',{name:'PAT-A'});
  erp.add('Sales Invoice',{...invoice,patient:'PAT-B',shopify_order_id:'123'});
  erp.add('Diet Chart',{name:'DIET',custom_items:[{item_code:'CREAM'}]});
  await trackPurchase(service,user,'123');
  erp.add('Sales Invoice',{...invoice,name:'RETURN',patient:'PAT-C',is_return:1,return_against:invoice.name,
    items:[{item_code:'CREAM',qty:-2},{item_code:'WASH',qty:-1}]});
  assert.deepEqual((await service.diets(user)).items,[]);
  assert.ok((await service.habitOrders(user,app)).items[0].items.every(i=>!i.canTrack));
});

test('tracked and patient invoice overlap is counted once for diet returns and habit pages',async()=>{
  const {erp,service,invoice}=setup();
  service.identity=async()=>({erpUser:user.id,patient:'PAT-A'});erp.add('Patient',{name:'PAT-A'});
  erp.add('Sales Invoice',{...invoice,shopify_order_id:'123'});
  erp.add('Diet Chart',{name:'DIET',custom_items:[{item_code:'CREAM'}]});
  await trackPurchase(service,user,'123');
  erp.add('Sales Invoice',{...invoice,name:'RETURN',is_return:1,return_against:invoice.name,items:[{item_code:'CREAM',qty:-2}]});
  assert.deepEqual((await service.diets(user)).items,[]);
  assert.deepEqual((await service.habitOrders(user,app)).items.map(i=>i.id),['INV/1']);
});

test('Seedfit purchase grants stay in Seedfit and use its own store and brand',async()=>{
  const {erp,invoice}=setup();
  const seed=new MobileService({erp,appId:'seedfit',productImage:async()=>'',checkoutTracking:{domain:'seed.myshopify.com'}});
  seed.identity=async()=>({erpUser:'seed-user',patient:'PAT-A'});
  seed.patient=async()=>({name:'PAT-A'});
  erp.add('Patient',{name:'PAT-A'});
  erp.add('Sales Invoice',{...invoice,patient:'PAT-B',shopify_order_id:'456',custom_app_brand:'Seedfit'});
  erp.add('Diet Chart',{name:'DIET',custom_items:[{item_code:'CREAM'}]});
  await seed.records.write(user.id,'order-owner','456',{orderId:'456',appId:'seedfit',shopDomain:'seed.myshopify.com'},0);
  assert.equal((await seed.diets(user)).items.length,1);
  assert.equal((await seed.habitOrders(user,'seedfit')).items.length,1);
  const siya=new MobileService({erp,productImage:async()=>'',checkoutTracking:{domain:'test.myshopify.com'}});
  siya.identity=seed.identity;
  assert.deepEqual((await siya.diets(user)).items,[]);
  seed.checkoutTracking.domain='wrong.myshopify.com';
  assert.deepEqual((await seed.diets(user)).items,[]);
});

test('mixed tracked and patient purchases paginate without repeating overlapping invoices',async()=>{
  const {erp,service,invoice}=setup();
  for(let i=2;i<=25;i++) erp.add('Sales Invoice',{...invoice,name:`INV/${String(i).padStart(2,'0')}`});
  erp.add('Sales Invoice',{...invoice,shopify_order_id:'123'});
  erp.add('Sales Invoice',{...invoice,name:'TRACKED',patient:'PAT-B',shopify_order_id:'124',posting_date:'2026-10-10'});
  await trackPurchase(service,user,'123');await trackPurchase(service,user,'124');
  const first=await service.habitOrders(user,app,0),second=await service.habitOrders(user,app,first.nextCursor);
  assert.equal(first.items[0].id,'TRACKED');assert.equal(first.items.length,20);
  assert.equal(second.items.length,6);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,26);
});
