import assert from 'node:assert/strict';
import {Erp} from '../src/erp.mjs';
import {MobileService} from '../src/service.mjs';
import {AppSessions} from '../src/app-sessions.mjs';
import {recordName} from '../src/store.mjs';
import {createApi} from '../src/server.mjs';
const base=process.env.PURCHASE_SIMULATION_URL || 'http://127.0.0.1:4913';
const user={id:'test-account'};
const record=(kind,key,data)=>{const name=recordName(user.id,kind,key);return {name,record_key:name,account:user.id,kind,payload:JSON.stringify(data),revision:1};};
const identity=record('identity','self',{erpUser:'APP-USER',patient:'PAT-A'});
const grant=record('order-owner','123',{orderId:'123',appId:'siya-ayurveda',shopDomain:'test.myshopify.com'});
const docs={
 'Mobile App User':{'APP-USER':{name:'APP-USER',external_id:user.id,is_active:1,profiles:[{patient_id:'PAT-A'}]}},
 'Patient':{'PAT-A':{name:'PAT-A'}},
 'Patient Encounter':{},'Item Group Template':{},'DocType':{},
 'Item':{'CREAM':{name:'CREAM'}},
 'Diet Chart':{'DIET':{name:'DIET',custom_items:[{item_code:'CREAM'}],custom_diet_chart_pdf:'/files/diet.pdf'}},
 'Sales Invoice':{'INV':{name:'INV',patient:'PAT-B',docstatus:1,is_return:0,shopify_order_id:'123',posting_date:'2026-10-28',items:[{item_code:'CREAM',qty:1}]}},
 'Siya Mobile Record':{[identity.name]:identity,[grant.name]:grant},
};
const seed=()=>fetch(base+'/erp/test/seed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(docs)});
await seed();
const erp=new Erp({url:base+'/erp',token:'synthetic-only'});
const service=new MobileService({erp,productImage:async()=>'',checkoutTracking:{domain:'test.myshopify.com'}});
const sessions=new AppSessions({records:service.records,queue:service.queue,appId:'siya-ayurveda'});
let issued=await sessions.issue(user,'APP-USER');
const api=createApi({service,sessions});await new Promise(r=>api.listen(0,'127.0.0.1',r));
const call=path=>fetch(`http://127.0.0.1:${api.address().port}`+path,{headers:{Authorization:'Bearer '+issued.token}});
try {
 for(const route of ['/v1/orders','/v1/diets','/v1/habit-orders']){
  const r=await call(route);assert.equal(r.status,200,route);const d=await r.json();assert.equal(d.items.length,1,route);console.log('PASS '+route+' recognizes tracked purchase');
 }
 const pdf=await call('/v1/diets/DIET/pdf');assert.equal(pdf.status,200);assert.match(await pdf.text(),/^%PDF-/);console.log('PASS purchase diet PDF');
 const habits=await call('/v1/habit-tracker');assert.equal(habits.status,200);assert.equal((await habits.json()).data.habits.length,1);console.log('PASS habit tracker product');
 delete docs['Siya Mobile Record'][grant.name];await seed();issued=await sessions.issue(user,'APP-USER');
 for(const route of ['/v1/diets','/v1/habit-orders']) {const r=await call(route);assert.equal(r.status,200);assert.equal((await r.json()).items.length,0);}
 assert.equal((await call('/v1/diets/DIET/pdf')).status,404);console.log('PASS revocation removes diet, habits and PDF eligibility');
} finally {await new Promise(r=>api.close(r));}
