import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverPatientLink,indianMobile} from '../src/patient-link.mjs';
import {MobileService} from '../src/service.mjs';

function fixture(appId = 'siya-ayurveda') {
  const user = {id:'gid://shopify/Customer/123',phone:'+919876543210',name:'Shop account'};
  const parent = {name:'app-user',external_id:appId === 'seedfit' ? `seedfit:${user.id}` : user.id,
    phone:'9876543210',modified:'version-1',profiles:[]};
  const patient = {name:'patient-1',mobile:'9876543210',patient_name:'Patient name'};
  const state = {parent,patients:[patient],accounts:[parent],updates:[],identity:null};
  const erp = {
    maybe:async()=>state.identity && {account:appId === 'seedfit' ? `seedfit:${user.id}` : user.id,
      kind:'identity',payload:JSON.stringify(state.identity),revision:1},
    get:async(type,name)=>structuredClone(type === 'Patient' ? state.patients.find(p=>p.name===name)
      : state.accounts.find(p=>p.name===name)),
    list:async(type,filters)=>structuredClone((type === 'Patient' ? state.patients : state.accounts).filter(row=>
      Object.entries(filters).every(([key,value])=>Array.isArray(value)?value[1].includes(row[key]):row[key]===value))),
    update:async(type,name,fields)=>{
      state.updates.push({type,name,fields});
      if(type === 'Siya Mobile Record') { state.identity=JSON.parse(fields.payload);return fields; }
      assert.equal(fields.modified,state.parent.modified);
      Object.assign(state.parent,structuredClone(fields));return structuredClone(state.parent);
    },
    create:async(type,fields)=>{assert.equal(type,'Siya Mobile Record');state.identity=JSON.parse(fields.payload);return fields;},
  };
  const recover=()=>recoverPatientLink(erp,user,structuredClone(state.parent),state.identity,appId);
  return {user,parent,patient,state,erp,recover};
}

for(const appId of ['siya-ayurveda','seedfit']) {
  test(`${appId}: general identity flow recovers a unique patient and subsequent reads do not duplicate profiles`,async()=>{
    const f=fixture(appId);const service=new MobileService({erp:f.erp,appId});
    assert.equal((await service.identity(f.user)).patient,'patient-1');
    assert.equal((await service.patient(f.user)).name,'patient-1');
    assert.equal(f.parent.profiles.length,1);
    assert.equal(f.state.updates.filter(x=>x.type==='Mobile App User').length,1);
    f.parent.profiles=[];
    await assert.rejects(service.patient(f.user),{code:'patient_link_required'});
    assert.equal(f.parent.profiles.length,0,'a clinic unlink remains revoked');
  });
}

test('cached unlinked identities recover too, without inheriting billing grants',async()=>{
  const f=fixture();f.state.identity={erpUser:f.parent.name,patient:null,customers:['stale-customer']};
  const service=new MobileService({erp:f.erp});
  assert.equal((await service.identity(f.user)).patient,'patient-1');
  assert.equal(f.state.identity.customers,undefined);
});

test('new patient appearing after booking is recovered on the next request',async()=>{
  const f=fixture();f.state.patients=[];const service=new MobileService({erp:f.erp});
  await assert.rejects(service.patient(f.user),{code:'patient_link_required'});
  assert.equal(f.parent.profiles.length,0);
  f.state.patients=[f.patient];
  assert.equal((await service.patient(f.user)).name,'patient-1');
});

for(const [name,change] of [
  ['duplicate phone',f=>f.state.patients.push({...f.patient,name:'patient-2'})],
  ['no phone; synthetic email cannot authorize care',f=>{f.user.phone='';f.user.email='9876543210@fastrr.com';}],
  ['changed account phone',f=>f.parent.phone='9876543211'],
  ['disabled patient',f=>f.patient.disabled=1],
  ['existing different patient',f=>f.parent.profiles=[{patient_id:'already-approved'}]],
  ['previously removed link',f=>f.state.identity={patient:'patient-1'}],
  ['ambiguous empty profiles',f=>f.parent.profiles=[{phone:f.user.phone},{phone:f.user.phone}]],
  ['unrelated empty profile',f=>f.parent.profiles=[{phone:'9876543211'}]],
  ['patient belongs to another same-brand account',f=>f.state.accounts.push({name:'other',phone:f.parent.phone,
    external_id:'gid://shopify/Customer/456',profiles:[{patient_id:f.patient.name}]})],
  ['multiple unlinked accounts share a phone',f=>f.state.accounts.push({name:'other',phone:f.parent.phone,
    external_id:'gid://shopify/Customer/456',profiles:[]})],
]) test(`${name}: no automatic link`,async()=>{
  const f=fixture();change(f);await f.recover();assert.equal(f.state.updates.length,0);
});

test('matching existing profile is enriched without removing unrelated profile data',async()=>{
  const f=fixture();f.parent.profiles=[{name:'row-1',phone:f.user.phone,profile_name:'Existing',height:170}];
  const result=await f.recover();assert.equal(result.profiles.length,1);
  assert.equal(result.profiles[0].height,170);assert.equal(result.profiles[0].patient_id,'patient-1');
});

test('concurrent ERP link is respected',async()=>{
  const f=fixture();f.erp.fresh=async()=>({...f.parent,profiles:[{patient_id:'clinic-selected'}]});
  assert.equal((await f.recover()).profiles[0].patient_id,'clinic-selected');
  assert.equal(f.state.updates.length,0);
});

test('store identities stay separate when the same person uses both apps',async()=>{
  const f=fixture('seedfit');f.state.accounts.push({name:'siya-user',external_id:f.user.id,phone:f.parent.phone,
    profiles:[{patient_id:f.patient.name}]});
  await f.recover();assert.equal(f.state.updates[0].name,'app-user');
  assert.equal(f.state.accounts[1].profiles.length,1);
});

test('lookup failures do not create or grant a patient link',async()=>{
  const f=fixture();f.erp.list=async()=>{throw new Error('ERP unavailable');};
  await assert.rejects(f.recover(),/ERP unavailable/);assert.equal(f.state.updates.length,0);
});

test('phone normalization is strict and does not accept arbitrary international suffixes',()=>{
  for(const value of ['9876543210','+91 9876543210','91-9876543210']) assert.equal(indianMobile(value),'9876543210');
  for(const value of ['+449876543210','9876543210ext','123','']) assert.equal(indianMobile(value),null);
});
