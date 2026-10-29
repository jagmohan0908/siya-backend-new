import test from 'node:test';
import assert from 'node:assert/strict';
import {MobileService} from '../src/service.mjs';
import {invoiceDepartments, invoiceMatchesDepartment} from '../src/invoice-departments.mjs';

const user={id:'synthetic-account'};
function setup(appId, docs) {
  const calls=[];
  const erp={
    async get(type,id) {
      if(type==='Patient') return {name:id};
      assert.equal(type,'Sales Invoice');
      return structuredClone(docs.find(d=>d.name===id));
    },
    async list(type,filters,fields,{limit,orFilters=[]}={}) {
      calls.push({type,filters});
      assert.equal(type,'Sales Invoice');
      const match=(d,k,v)=>Array.isArray(v)?v[1].includes(d[k]):d[k]===v;
      return docs.filter(d=>Object.entries(filters).every(([k,v])=>match(d,k,v)))
        .filter(d=>!orFilters.length||orFilters.some(([k,op,v])=>match(d,k,op==='in'?['in',v]:v)))
        .sort((a,b)=>b.posting_date.localeCompare(a.posting_date)||b.name.localeCompare(a.name))
        .slice(0,limit).map(d=>Object.fromEntries(fields.map(k=>[k,d[k]])));
    },
    async request() {calls.push({type:'PDF'});return new Response('%PDF-synthetic');},
  };
  const service=new MobileService({erp,appId});
  service.identity=async()=>({patient:'PAT-SHARED',customers:[]});
  service.checkoutTracking.ids=async()=>[];
  service.invoiceShipment=async()=>null;
  return {service,calls};
}
const invoice=(name,department,fields={})=>({name,sr_si_patient_department:department,
  patient:'PAT-SHARED',docstatus:1,posting_date:'2026-10-29',items:[],...fields});

test('all nine configured departments belong to exactly one app; blank and unknown belong to neither',()=>{
  const expected={seedfit:['Varicocele','EDPME','Dr health','Seed.fit'],
    'siya-ayurveda':['Skin/Fertility/Liver/IBS','Siya OPD','Arthritis','Siya Essentials','Siya Ayurveda']};
  for(const [app,departments] of Object.entries(expected)) {
    assert.deepEqual(invoiceDepartments(app),departments);
    for(const department of [...expected.seedfit,...expected['siya-ayurveda'],'',null,undefined,'Unknown']) {
      assert.equal(invoiceMatchesDepartment(app,invoice('TEST',department)),departments.includes(department));
    }
  }
  assert.equal(invoiceMatchesDepartment('unknown',invoice('TEST','Seed.fit')),false);
});

test('shared patient orders are filtered before pagination in both apps',async()=>{
  const docs=[];
  for(let i=0;i<45;i++) for(const [prefix,department] of [['SEED','Seed.fit'],['SIYA','Siya Ayurveda'],['BLANK','']])
    docs.push(invoice(`${prefix}-${String(i).padStart(3,'0')}`,department));
  for(const [app,prefix] of [['seedfit','SEED'],['siya-ayurveda','SIYA']]) {
    const {service}=setup(app,docs), found=[];
    let cursor=0;
    do {const page=await service.orders(user,cursor);found.push(...page.items.map(i=>i.id));cursor=page.nextCursor;} while(cursor!==null);
    assert.equal(found.length,45);assert.equal(new Set(found).size,45);
    assert.ok(found.every(id=>id.startsWith(prefix)));
  }
});

test('department applies to direct details, PDF and tracking even when patient or legacy customer matches',async()=>{
  const docs=[invoice('SEED','Seed.fit'),invoice('SIYA','Siya Ayurveda'),invoice('BLANK',''),
    invoice('OTHER','Seed.fit',{patient:'OTHER-PAT'}),invoice('DRAFT','Seed.fit',{docstatus:0})];
  for(const app of ['seedfit','siya-ayurveda']) {
    const {service,calls}=setup(app,docs);
    const allowed=app==='seedfit'?'SEED':'SIYA';
    assert.equal((await service.invoice(user,allowed)).id,allowed);
    assert.match(await (await service.invoice(user,allowed,true)).text(),/^%PDF-/);
    const before=calls.filter(c=>c.type==='PDF').length;
    for(const id of [app==='seedfit'?'SIYA':'SEED','BLANK','DRAFT',...(app==='seedfit'?['OTHER']:[])]) {
      await assert.rejects(service.invoice(user,id),{status:404});
      await assert.rejects(service.invoice(user,id,true),{status:404});
      await assert.rejects(service.refreshInvoiceTracking(user,id),{status:404});
    }
    service.identity=async()=>({patient:'PAT-SHARED',customers:['SHARED-CUSTOMER']});
    docs.find(d=>d.name==='BLANK').customer='SHARED-CUSTOMER';
    await assert.rejects(service.invoice(user,'BLANK'),{status:404});
    assert.equal(calls.filter(c=>c.type==='PDF').length,before);
  }
});

test('tracked purchase cannot bypass department and matching department cannot bypass ownership',async()=>{
  const docs=[invoice('SEED','Seed.fit',{patient:'OTHER',shopify_order_id:'1'}),
    invoice('SIYA','Siya Ayurveda',{patient:'OTHER',shopify_order_id:'2'}),invoice('UNOWNED','Seed.fit',{patient:'OTHER'})];
  const {service}=setup('seedfit',docs);
  service.checkoutTracking.ids=async()=>['1','2'];
  service.checkoutTracking.owns=async(_,doc)=>['1','2'].includes(doc.shopify_order_id);
  assert.deepEqual((await service.orders(user)).items.map(i=>i.id),['SEED']);
  assert.equal((await service.invoice(user,'SEED')).id,'SEED');
  await assert.rejects(service.invoice(user,'SIYA'),{status:404});
  await assert.rejects(service.invoice(user,'UNOWNED'),{status:404});
});
