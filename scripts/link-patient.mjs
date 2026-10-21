import {Erp} from '../src/erp.mjs';
import {Records} from '../src/store.mjs';
import {requireValue} from '../src/errors.mjs';

// Operator-only migration command; never expose patient linking as a patient API.
const account=process.env.SHOPIFY_CUSTOMER_ID;
const patientId=process.env.ERP_PATIENT_ID;
requireValue(/^gid:\/\/shopify\/Customer\/\d+$/.test(account || '') && patientId,'Set SHOPIFY_CUSTOMER_ID and ERP_PATIENT_ID');
const erp=new Erp({url:process.env.ERP_URL,token:process.env.ERP_TOKEN});
const records=new Records(erp);
const identity=await records.read(account,'identity','self');
requireValue(identity,'The customer must sign in through the mobile API first');
const patient=await erp.get('Patient',patientId);
const parent=await erp.get('Mobile App User',identity.data.erpUser);
requireValue([account,account.split('/').at(-1)].includes(parent.external_id),'ERP user does not belong to this Shopify customer');
const linkedPatients=[...new Set((parent.profiles || []).map(profile=>profile.patient_id).filter(Boolean))];
requireValue(linkedPatients.length === 1 && linkedPatients[0] === patient.name,
  'First link the reviewed Patient in the ERP Mobile App User profiles. Cached mappings cannot grant patient access.');
const data={...identity.data,patient:patient.name};
if (identity.data.patient !== patient.name) delete data.customers;
if (process.env.AUTHORIZE_CUSTOMER_INVOICES === '1') {
  requireValue(patient.customer,'Patient has no Customer link');data.customers=[patient.customer];
}
if (process.env.APPLY_LINK !== '1') console.log('Validated mapping. Dry run only; set APPLY_LINK=1 after verifying ownership.');
else { await records.write(account,'identity','self',data,identity.revision);console.log('Patient mapping saved in ERP'); }
