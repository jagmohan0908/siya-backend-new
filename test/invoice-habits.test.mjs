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
  async list(type,filters,fields,{offset=0,limit=50,orFilters}={}) {
    const match=(doc,key,op,value)=> op==='in' ? value.includes(doc[key]) : op==='<' ? doc[key]<value : doc[key]===value;
    return [...this.docs.entries()].filter(([key])=>key.startsWith(`${type}/`)).map(([,doc])=>doc)
      .filter(doc=>Object.entries(filters).every(([key,value])=>Array.isArray(value)?match(doc,key,...value):doc[key]===value))
      .filter(doc=>!orFilters || orFilters.some(([key,op,value])=>match(doc,key,op,value)))
      .slice(offset,offset+limit).map(doc=>structuredClone(doc));
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

test('all orders are loaded, including single items, while repeated products share one checklist entry',async()=>{
  const {erp,service,invoice}=setup();
  for(let i=2;i<=25;i++) erp.add('Sales Invoice',{...invoice,name:`INV/${i}`});
  const first=await service.habitOrders(user,app,0);
  assert.equal(first.items.length,20);assert.equal(first.nextCursor,20);
  const tracker=await service.erpHabitTracker(user,app);
  assert.equal(tracker.orders.length,25);assert.equal(tracker.data.habits.length,2);
  await assert.rejects(service.habitOrders(user,app,-1),{status:400});
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
