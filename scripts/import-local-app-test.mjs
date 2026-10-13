// Import the explicitly scoped local fixture into the user's fresh test ERP.
// No sessions, integration credentials, notifications, or fabricated prescriptions.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {Erp} from '../src/erp.mjs';
import {Records} from '../src/store.mjs';

const input=process.argv[2];
assert.ok(input,'Pass the private export JSON path (outside Git)');
const pack=JSON.parse(await readFile(input,'utf8'));
assert.equal(pack.source,'localhost');
const erp=new Erp({url:process.env.ERP_URL,token:process.env.ERP_TOKEN,fetcher:async(url,options)=>{
  const response=await fetch(url,options);
  if(!response.ok && response.status!==404) {
    const error=await response.clone().json().catch(()=>({}));
    const messages=JSON.parse(error._server_messages || '[]').map(v=>{try{return JSON.parse(v).message}catch{return ''}});
    console.error(JSON.stringify({path:new URL(url).pathname,validation:error.exc_type,exception:String(error.exception || '').slice(0,300),messages:messages.map(m=>String(m).replace(/<[^>]*>/g,'').slice(0,600))}));
  }
  return response;
}});
assert.equal(new URL(erp.url).hostname,'srdevportal.tech','This importer is restricted to the approved fresh test ERP');
const receiptPath=input+'.srdevportal-receipt.json';
const receipt=JSON.parse(await readFile(receiptPath,'utf8').catch(()=>'{"records":{},"files":{}}'));
const sourceField='custom_local_test_source';
const key=(dt,name)=>`${dt}:${name}`;
const marker=(dt,name)=>`localhost:${dt}:${name}`;
const source=(dt,name)=>pack.documents.find(d=>d.doctype===dt && (!name || d.name===name));
const mapped=(dt,name)=>receipt.records[key(dt,name)] || name;
const save=()=>writeFile(receiptPath,JSON.stringify(receipt,null,2));
const metaCache=new Map();
async function meta(dt) {
  if(!metaCache.has(dt)) {
    const d=await erp.get('DocType',dt);
    const custom=await erp.list('Custom Field',{dt},['fieldname','fieldtype','options','reqd'],{limit:500});
    metaCache.set(dt,{...d,fields:[...d.fields,...custom.filter(c=>!d.fields.some(f=>f.fieldname===c.fieldname))]});
  }
  return metaCache.get(dt);
}
async function field(dt,f) {
  const m=await meta(dt);
  if(!m.fields.some(v=>v.fieldname===f.fieldname)) {
    await erp.create('Custom Field',{dt,...f});metaCache.delete(dt);
    console.log(`FIELD ${dt}.${f.fieldname}`);
  }
}
const skipped=new Set(['name','owner','creation','modified','modified_by','docstatus','idx','parent','parentfield','parenttype','amended_from']);
async function clean(dt,doc) {
  const out={};
  for(const f of (await meta(dt)).fields) {
    const v=doc[f.fieldname];
    if(skipped.has(f.fieldname) || v===undefined || v===null || v==='' || f.fieldtype==='Password')continue;
    if(['Table','Table MultiSelect'].includes(f.fieldtype))out[f.fieldname]=await Promise.all(v.map(r=>clean(f.options,r)));
    else if(f.fieldtype==='Link') {
      if(f.options==='User' && !f.reqd)continue; // Do not impersonate local operators.
      const target=mapped(f.options,v);
      if(await erp.maybe(f.options,target))out[f.fieldname]=target;
      else if(f.reqd)throw Error(`Missing required link ${dt}.${f.fieldname}: ${f.options}`);
    } else if(!['Section Break','Column Break','Tab Break','HTML','Button'].includes(f.fieldtype))out[f.fieldname]=v;
  }
  return out;
}
async function remember(dt,old,doc) {
  receipt.records[key(dt,old)]=doc.name;await save();return doc;
}
async function insert(dt,old,data,{stable=false,tagged=false}={}) {
  if(receipt.records[key(dt,old)])return erp.get(dt,mapped(dt,old));
  if(stable) {const existing=await erp.maybe(dt,old);if(existing)return remember(dt,old,existing);}
  if(tagged) {
    await field(dt,{fieldname:sourceField,label:'Local Test Source',fieldtype:'Data',unique:1,read_only:1,no_copy:1});
    const rows=await erp.list(dt,{[sourceField]:marker(dt,old)},['name'],{limit:2});
    assert.ok(rows.length<=1,'Duplicate migration source');
    if(rows.length)return remember(dt,old,await erp.get(dt,rows[0].name));
  }
  const doc=await erp.create(dt,{...await clean(dt,data),...(tagged?{[sourceField]:marker(dt,old)}:{})});
  await remember(dt,old,doc);console.log(`COPIED ${dt} ${old} -> ${doc.name}`);return doc;
}

// Add only the fields read by the app, retaining every existing field definition.
for(const s of [...pack.schemas].reverse())if(!await erp.maybe('DocType',s.name))await erp.create('DocType',s);
for(const {dt,...f} of pack.custom_fields)await field(dt,f);

// Separate demo books keep copied test invoices out of the existing company's ledger.
const companyName='Siya Ayurveda (Demo)';
let company=await erp.maybe('Company',companyName);
if(!company)company=await erp.create('Company',{company_name:companyName,abbr:'SAD',default_currency:'INR',country:'India',chart_of_accounts:'Standard',enable_perpetual_inventory:0});
for(const d of pack.documents.filter(d=>d.doctype==='Sales Invoice' || d.doctype==='Patient Encounter'))receipt.records[key('Company',d.company)]=company.name;
await save();

for(const dt of ['Medical Department','DPT Disease','SR Practitioner Pathy','SR Encounter Place','SR Sales Type','SR Encounter Status','SR Lead Source'])for(const d of pack.documents.filter(d=>d.doctype===dt))await insert(dt,d.name,d,{stable:true});
const groups=pack.documents.filter(d=>d.doctype==='Item Group').sort((a,b)=>Number(!!a.parent_item_group)-Number(!!b.parent_item_group));
for(const d of groups)await insert('Item Group',d.name,d,{stable:true});
const purchasedCodes=new Set(pack.documents.filter(d=>d.doctype==='Sales Invoice').flatMap(d=>d.items.map(i=>i.item_code)));
for(const d of pack.documents.filter(d=>d.doctype==='Item' && purchasedCodes.has(d.name)))await insert('Item',d.name,{...d,item_defaults:[],taxes:[],supplier_items:[],barcodes:[]},{stable:true});
for(const d of pack.documents.filter(d=>d.doctype==='Item Group Template'))await insert(d.doctype,d.name,{...d,items:d.items.map(r=>({...r,item_tax_template:null}))},{tagged:true});
for(const d of pack.documents.filter(d=>d.doctype==='Practitioner Schedule'))await insert(d.doctype,d.name,d,{stable:true});
for(const d of pack.documents.filter(d=>d.doctype==='Healthcare Practitioner'))await insert(d.doctype,d.name,{...d,image:null,accounts:[],user_id:null,employee:null},{stable:true});

const c=source('Customer');
const customer=await insert('Customer',c.name,{customer_name:c.customer_name,customer_type:c.customer_type || 'Individual',customer_group:c.customer_group,territory:c.territory,default_currency:'INR'},{tagged:true});
const p=source('Patient');
const patient=await insert('Patient',p.name,{first_name:p.first_name,middle_name:p.middle_name,last_name:p.last_name,sex:p.sex,dob:p.dob,mobile:p.mobile,phone:p.phone,email:p.email,customer:customer.name,status:p.status || 'Active',sr_patient_id:p.sr_patient_id,sr_medical_department:p.sr_medical_department,invite_user:0,patient_details:'LOCAL TEST COPY: account owner authorized testing on this ERP. Imported from localhost.'},{tagged:true});

for(const d of pack.documents.filter(d=>d.doctype==='Diet Chart'))await insert(d.doctype,d.name,{...d,custom_items:(d.custom_items || []).filter(r=>purchasedCodes.has(r.item_code)),custom_diet_chart_pdf:null},{stable:true});
const series=await erp.method('sriaas_clinic.api.sales_invoice.get_sales_invoice_series_config');
receipt.blocked=series.sales_invoice_series?[]:['Set sales_invoice_series in the ERP site configuration'];
await field('Sales Invoice',{fieldname:sourceField,label:'Local Test Source',fieldtype:'Data',unique:1,read_only:1,no_copy:1});
const existingInvoices=await erp.list('Sales Invoice',{patient:patient.name,docstatus:['<',2]},['name',sourceField],{limit:100});
if(existingInvoices.some(d=>!String(d[sourceField] || '').startsWith('localhost:Sales Invoice:'))) {
  receipt.blocked.push('Patient has manually created invoices; review those before importing to avoid duplicate purchases');
  console.log('BLOCKED automatic invoice copy: manual invoices need reconciliation');
}
if(!series.sales_invoice_series)console.log('BLOCKED invoice import: ERP sales_invoice_series is unset; continuing independent records');
for(const d of pack.documents.filter(d=>d.doctype==='Sales Invoice' && !receipt.blocked.length).sort((a,b)=>a.posting_date.localeCompare(b.posting_date))) {
  const doc=await insert(d.doctype,d.name,{
    naming_series:series.sales_invoice_series,patient:patient.name,customer:customer.name,company:company.name,
    posting_date:d.posting_date,posting_time:d.posting_time,set_posting_time:1,due_date:d.due_date,
    currency:d.currency,conversion_rate:1,selling_price_list:'Standard Selling',price_list_currency:d.currency,plc_conversion_rate:1,
    debit_to:company.default_receivable_account,cost_center:company.cost_center,update_stock:0,
    item_group_template:d.item_group_template,sr_si_patient_id:p.sr_patient_id,
    items:d.items.map(r=>({item_code:r.item_code,item_name:r.item_name,description:r.description,qty:r.qty,uom:r.uom,stock_uom:r.stock_uom,conversion_factor:r.conversion_factor || 1,rate:r.rate,income_account:company.default_income_account,cost_center:company.cost_center})),
    remarks:`LOCAL TEST COPY of ${d.name}; no live shipment or payment.`,disable_rounded_total:d.disable_rounded_total,
  },{tagged:true});
  assert.equal(Number(doc.grand_total),Number(d.grand_total),'Copied invoice total differs from local');
  if(doc.docstatus===0) {await erp.method('frappe.client.submit',{doc:JSON.stringify(doc)},true);console.log(`SUBMITTED test invoice ${doc.name}`);}
}
for(const d of pack.documents.filter(d=>d.doctype==='Patient Encounter'))await insert(d.doctype,d.name,{
  ...d,encounter_reference:null,appointment:null,
  patient:patient.name,company:company.name,encounter_date:d.encounter_date,encounter_time:d.encounter_time,
  practitioner:d.practitioner || d.pe_practitioner,pe_practitioner:d.pe_practitioner,
  medical_department:p.sr_medical_department,drug_prescription:d.drug_prescription,
  diet_chart:d.diet_chart,sr_pe_instruction:d.sr_pe_instruction,
},{tagged:true});

function remapJson(value) {
  if(typeof value==='string') {
    for(const [k,v] of Object.entries(receipt.records))if(k.slice(k.indexOf(':')+1)===value)return v;
    return value;
  }
  if(Array.isArray(value))return value.map(remapJson);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remapJson(v)]));
  return value;
}
const u=source('Mobile App User');
await insert('Mobile App User',u.name,{external_id:u.external_id,full_name:u.full_name,phone:u.phone,email:u.email,is_active:1,
  profiles:[{profile_name:p.patient_name,phone:u.phone,patient_id:patient.name,profile_complete:0,force_profile_setup:0}],
},{stable:true});
const appParent=await erp.get('Mobile App User',mapped('Mobile App User',u.name));
if(!appParent.profiles?.length)await erp.update('Mobile App User',appParent.name,{modified:appParent.modified,
  profiles:[{profile_name:p.patient_name,phone:u.phone,patient_id:patient.name,profile_complete:0,force_profile_setup:0}]});
else assert.ok(appParent.profiles.length===1 && appParent.profiles[0].patient_id===patient.name,'Existing app profile belongs to a different Patient');
if(!receipt.blocked.length && u.custom_habit_trackers?.length) {
  const current=await erp.get('Mobile App User',mapped('Mobile App User',u.name));
  if(!current.custom_habit_trackers?.length)await erp.update('Mobile App User',current.name,{modified:current.modified,
    custom_habit_trackers:(u.custom_habit_trackers || []).map(r=>({app:r.app,patient:patient.name,last_updated:r.last_updated,current_streak:r.current_streak,revision:r.revision,payload:JSON.stringify(remapJson(JSON.parse(r.payload)))}))});
}
const records=new Records(erp);
const existingIdentity=await records.read(pack.account,'identity','self');
const identity={erpUser:mapped('Mobile App User',u.name),patient:patient.name};
if(JSON.stringify(existingIdentity?.data)!==JSON.stringify(identity))await records.write(pack.account,'identity','self',identity,existingIdentity?.revision || 0);
for(const d of pack.documents.filter(d=>d.doctype==='Mobile App Assessment'))await insert(d.doctype,d.name,{...d,patient:patient.name,legacy_source:null,payload:JSON.stringify(remapJson(JSON.parse(d.payload)))},{stable:true});
for(const d of pack.documents.filter(d=>d.doctype==='Support Ticket'))await insert(d.doctype,d.name,{...d,description:d.description,custom_mobile_app_user:mapped('Mobile App User',u.name)},{tagged:true});

for(const f of pack.files) {
  const id=`${f.doctype}:${f.name}:${f.field}`;
  if(!receipt.files[id]) {
    const name=mapped(f.doctype,f.name);
    const form=new FormData();
    form.set('file',new Blob([Buffer.from(f.content,'base64')]),f.filename);
    form.set('is_private','1');form.set('doctype',f.doctype);form.set('docname',name);form.set('fieldname',f.field);
    const saved=await erp.request('/api/method/upload_file',{method:'POST',body:form});
    await erp.update(f.doctype,name,{[f.field]:saved.file_url});
    receipt.files[id]=saved.file_url;await save();console.log(`FILE ${f.doctype}.${f.field}`);
  }
}
await save();
console.log(JSON.stringify({complete:!receipt.blocked.length,blocked:receipt.blocked,patient:patient.name,account:pack.account,records:Object.keys(receipt.records).length,files:Object.keys(receipt.files).length}));
