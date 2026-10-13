// Read-only migration checks. No patient details, credentials or ERP traces are logged.
import assert from 'node:assert/strict';
import {Erp} from '../src/erp.mjs';
import {MobileService} from '../src/service.mjs';

const erp = new Erp({url:process.env.ERP_URL,token:process.env.ERP_TOKEN});
assert.ok(['dev-sr.butest.tech','srdevportal.tech'].includes(new URL(erp.url).hostname),'Use an approved test ERP');
const service = new MobileService({erp});
const results=[];
async function check(name,run) {
  try { await run(); results.push({name,status:'PASS'}); }
  catch(error) { results.push({name,status:'BLOCKED',reason:error.message}); }
}
await check('ERP authentication',()=>erp.method('frappe.auth.get_logged_user'));
await check('ERP invoice numbering configuration',async()=>{
  const config=await erp.method('sriaas_clinic.api.sales_invoice.get_sales_invoice_series_config');
  assert.ok(config.sales_invoice_series,'ERP administrator must configure sales_invoice_series in site config');
});
for(const account of ['Siya Ayurveda Patient App','Seedfit Patient App'])await check(`${account} configuration`,async()=>{
  const channel=await erp.get('Chat Channel Account',account);
  assert.ok(channel.channel_type==='Mobile App' && channel.is_active,'An active Mobile App channel is required');
  assert.ok(channel.ai_policy_bundle,'Assign an existing active ERP AI policy to this channel');
});
for(const app of ['siya-ayurveda','seedfit']) await check(`${app} doctors`,async()=>{
  assert.ok((await service.doctors(app)).doctors.length,'No doctors are tagged for this app');
});
for(const type of ['Siya Mobile Record','Mobile App Assessment','Mobile App Habit Tracker Item','Item Group Template']) {
  await check(`${type} schema`,()=>erp.get('DocType',type));
}
for(const [dt,fieldname] of [['Support Ticket','custom_mobile_app'],['Support Ticket','custom_mobile_app_user'],
  ['Mobile App User','custom_habit_trackers'],['Sales Invoice','item_group_template'],
  ['Chat Conversation','custom_mobile_previous_chat']]) {
  await check(`${dt}.${fieldname}`,async()=>{
    const doc=await erp.get('DocType',dt);
    assert.ok(doc.fields.some(f=>f.fieldname===fieldname) || await erp.maybe('Custom Field',`${dt}-${fieldname}`),'Missing field');
  });
}
for(const type of ['Patient','Sales Invoice','Patient Encounter','Support Ticket','Diet Chart']) {
  await check(`${type} REST access`,()=>erp.list(type,{},['name'],{limit:1}));
}
for(const type of ['Chat Contact','Chat Conversation','Chat Message']) {
  await check(`${type} REST access`,()=>erp.list(type,{},['name'],{limit:1}));
}
await check('Native mobile account identity schema',async()=>{
  const doc=await erp.get('DocType','Chat Contact');
  for(const field of ['mobile_account_key','mobile_app_user','mobile_channel_account','mobile_profile_id']) {
    assert.ok(doc.fields.some(f=>f.fieldname===field),`Missing ${field}`);
  }
});
console.log(JSON.stringify({erp:erp.url,results,ready:results.every(r=>r.status==='PASS'),
  note:'Passing infrastructure checks does not verify login, payment, patient links, PDF mappings or end-to-end AI replies.'},null,2));
if(results.some(r=>r.status==='BLOCKED')) process.exitCode=1;
