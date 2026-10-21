import test from 'node:test';
import assert from 'node:assert/strict';
import {MobileService} from '../src/service.mjs';

const user = {id:'gid://shopify/Customer/123'};
function setup(externalId = user.id, cachedPatient = null, customers) {
  const parent = {name:'verified-user',external_id:externalId,profiles:[]};
  const service = new MobileService({erp:{
    maybe:async()=>({account:user.id,kind:'identity',payload:JSON.stringify({erpUser:parent.name,patient:cachedPatient,customers})}),
    get:async(type,name)=>{
      assert.equal(type,'Mobile App User');assert.equal(name,parent.name);
      return structuredClone(parent);
    },
  }});
  return {service,parent};
}

for (const externalId of [user.id,'123']) {
  test(`Siya refreshes approved patient links for ${externalId}`,async()=>{
    const {service,parent}=setup(externalId);
    assert.equal((await service.identity(user)).patient,null);
    parent.profiles=[{patient_id:'patient-A'}];
    assert.equal((await service.identity(user)).patient,'patient-A');
    parent.profiles=[{patient_id:'patient-B'}];
    assert.equal((await service.identity(user)).patient,'patient-B');
  });
}

test('unlinking or ambiguous profiles cannot retain cached Siya patient access',async()=>{
  const {service,parent}=setup(user.id,'patient-A');
  assert.equal((await service.identity(user)).patient,null);
  await assert.rejects(service.patient(user),{code:'patient_link_required'});
  parent.profiles=[{patient_id:'patient-A'},{patient_id:'patient-A'}];
  assert.equal((await service.identity(user)).patient,'patient-A');
  parent.profiles.push({patient_id:'patient-B'});
  await assert.rejects(service.patient(user),{code:'patient_link_required'});
});

test('cached Siya identity cannot authorize a different Shopify customer or app',async()=>{
  for (const externalId of ['gid://shopify/Customer/456',`seedfit:${user.id}`]) {
    const {service,parent}=setup(externalId,'patient-A');
    parent.profiles=[{patient_id:'patient-A'}];
    await assert.rejects(service.identity(user),{code:'identity_link_required'});
  }
});

test('reviewed billing access survives only while the same patient remains linked',async()=>{
  const {service,parent}=setup(user.id,'patient-A',['customer-A']);
  parent.profiles=[{patient_id:'patient-A'}];
  assert.deepEqual((await service.identity(user)).customers,['customer-A']);
  parent.profiles=[{patient_id:'patient-B'}];
  assert.equal((await service.identity(user)).customers,undefined);
  parent.profiles=[];
  assert.equal((await service.identity(user)).customers,undefined);
});
