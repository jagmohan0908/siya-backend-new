// Add only missing definitions exported from the local ERP. Never copy business data.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Erp} from '../src/erp.mjs';

const erp = new Erp({url:process.env.ERP_URL,token:process.env.ERP_TOKEN});
assert.equal(new URL(erp.url).hostname,'dev-sr.butest.tech','Dev schema setup is restricted to the dev ERP');
const schema = JSON.parse(await readFile(new URL('../erp/item-group-template-schema.json',import.meta.url),'utf8'));
for (const doc of schema.doctypes) {
  if (!await erp.maybe('DocType',doc.name)) {
    await erp.create('DocType',doc);
    console.log(`Created ${doc.name}`);
  }
}
for (const field of [...schema.invoice_fields,{
  dt:'Chat Conversation',fieldname:'custom_mobile_previous_chat',label:'Previous Mobile App Chat',
  fieldtype:'Link',options:'Chat Conversation',read_only:1,no_copy:1,unique:1,
}]) {
  const doc = await erp.get('DocType',field.dt);
  if (!doc.fields.some(f=>f.fieldname===field.fieldname) &&
      !await erp.maybe('Custom Field',`${field.dt}-${field.fieldname}`)) {
    await erp.create('Custom Field',field);
    console.log(`Created ${field.dt}.${field.fieldname}`);
  }
}
await import('./setup-erp.mjs');
