import {Erp} from '../src/erp.mjs';
import {setupAssessmentSchema} from './assessment-schema.mjs';
const erp = new Erp({url: process.env.ERP_URL, token: process.env.ERP_TOKEN});
// Additive schema only. Does not edit existing ERP apps or existing patient records.
const name = 'Siya Mobile Record';
if (!await erp.maybe('DocType', name)) {
  await erp.create('DocType', {
    name, module: 'Custom', custom: 1, autoname: 'field:record_key', track_changes: 1,
    fields: [
      {fieldname: 'record_key', label: 'Record Key', fieldtype: 'Data', reqd: 1, unique: 1},
      {fieldname: 'account', label: 'Verified Shopify Customer', fieldtype: 'Data', reqd: 1, search_index: 1},
      {fieldname: 'kind', label: 'Record Type', fieldtype: 'Data', reqd: 1, search_index: 1},
      {fieldname: 'payload', label: 'Data', fieldtype: 'JSON', reqd: 1},
      {fieldname: 'revision', label: 'Revision', fieldtype: 'Int', reqd: 1},
    ],
    permissions: [{role: 'System Manager', read: 1, write: 1, create: 1, delete: 1}],
  });
  console.log('Created Siya Mobile Record');
} else console.log('Siya Mobile Record already exists');
console.log(await setupAssessmentSchema(erp) ? 'Created Mobile App Assessment' : 'Mobile App Assessment already exists');
