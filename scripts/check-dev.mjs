import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Erp} from '../src/erp.mjs';
import {Records,recordName} from '../src/store.mjs';

const erp = new Erp({url:process.env.ERP_URL,token:process.env.ERP_TOKEN});
assert.equal(new URL(erp.url).hostname,'dev-sr.butest.tech','This smoke test is restricted to dev');
await erp.method('frappe.auth.get_logged_user');
console.log('PASS ERP authentication');
const doctors = await erp.method('mobile_app.api.practitioners.list_doctors');
assert.ok(doctors.doctors.length > 0); console.log('PASS ERP doctor listing');
const date = new Date(Date.now()+86400000).toISOString().slice(0,10);
const slots = await erp.method('mobile_app.api.practitioners.availability',{practitioner_id:doctors.doctors[0].id,date});
assert.ok(Array.isArray(slots.slots));console.log('PASS ERP availability');
await erp.get('DocType','Siya Mobile Record');console.log('PASS additive mobile record schema');
if (process.env.DEV_TEST_WRITES === '1') {
  const records = new Records(erp);const account=`integration-test:${randomUUID()}`;
  const name=recordName(account,'smoke','self');
  try {
    await records.write(account,'smoke','self',{synthetic:true,value:1},0);
    assert.equal((await records.read(account,'smoke','self')).data.value,1);
    await records.write(account,'smoke','self',{synthetic:true,value:2},1);
    await assert.rejects(records.write(account,'smoke','self',{value:3},1),{status:409});
    assert.equal(await records.read('other-test-account','smoke','self'),null);
    console.log('PASS ERP create/read/update, stale-write rejection and account isolation');
    const concurrent=await Promise.allSettled([
      records.write(account,'smoke','self',{synthetic:true,value:4},2),
      records.write(account,'smoke','self',{synthetic:true,value:5},2),
    ]);
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1,'Exactly one concurrent update must succeed');
    assert.equal(concurrent.find(r=>r.status==='rejected').reason.status,409);
    console.log('PASS ERP rejects a simultaneous stale update atomically');
  } finally {
    if (await erp.maybe('Siya Mobile Record',name)) await erp.method('frappe.client.delete',{doctype:'Siya Mobile Record',name},true);
    console.log('PASS synthetic record cleanup');
  }
}
