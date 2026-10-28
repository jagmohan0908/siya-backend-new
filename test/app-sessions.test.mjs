import test from 'node:test';
import assert from 'node:assert/strict';
import {AppSessions} from '../src/app-sessions.mjs';
import {Records,SerialQueue} from '../src/store.mjs';
import {createApi} from '../src/server.mjs';
import {ApiError} from '../src/errors.mjs';

function fixture() {
  let now=Date.now(); const docs=new Map();
  const erp={maybe:async(_,id)=>docs.get(id) || null,
    get:async(type,id)=>structuredClone(docs.get(type+'/'+id)),
    create:async(_,doc)=>{docs.set(doc.record_key,structuredClone(doc));return doc;},
    update:async(_,id,doc)=>{docs.set(id,structuredClone(doc));return doc;}};
  const make=appId=>new AppSessions({records:new Records(erp,appId==='seedfit'?'seedfit':''),
    queue:new SerialQueue(),appId,now:()=>now});
  return {docs,make,advance:days=>now+=days*86400000};
}
const user={id:'gid://shopify/Customer/123',phone:'+919084553059',name:'Test'};

test('opaque sessions survive backend restart without storing the bearer token',async()=>{
  const f=fixture();const issued=await f.make('siya-ayurveda').issue(user);
  assert.match(issued.token,/^ma1\.[a-f0-9]{64}$/);
  assert.equal(JSON.stringify([...f.docs.values()]).includes(issued.token),false);
  assert.equal((await f.make('siya-ayurveda').use('Bearer '+issued.token)).id,user.id);
});
test('a session never crosses brands, including identical customer IDs',async()=>{
  const f=fixture(),siya=f.make('siya-ayurveda'),seed=f.make('seedfit');
  const issued=await siya.issue(user);
  await assert.rejects(seed.use('Bearer '+issued.token),{status:401});
  await assert.rejects(siya.use('Bearer '+issued.token+'0'),{status:401});
});
test('disabling or transferring the ERP app account blocks an established session',async()=>{
  const f=fixture(),sessions=f.make('siya-ayurveda');
  const parent={external_id:user.id,is_active:1};
  f.docs.set('Mobile App User/app-user',parent);
  const issued=await sessions.issue(user,'app-user');
  assert.equal((await sessions.use('Bearer '+issued.token)).id,user.id);
  parent.is_active=0;
  await assert.rejects(sessions.use('Bearer '+issued.token),{status:403,code:'account_unavailable'});
  parent.is_active=1;parent.external_id='another-account';
  await assert.rejects(sessions.use('Bearer '+issued.token),{status:403});
  await sessions.use('Bearer '+issued.token,true);
  await assert.rejects(sessions.use('Bearer '+issued.token),{status:401});
});
test('logout revokes only this device; idle and absolute expiry cannot be extended by replay',async()=>{
  const f=fixture(),sessions=f.make('siya-ayurveda');
  const a=await sessions.issue(user),b=await sessions.issue(user);
  await sessions.use('Bearer '+a.token,true);
  await assert.rejects(sessions.use('Bearer '+a.token),{status:401});
  f.advance(20);await sessions.use('Bearer '+b.token);
  f.advance(20);await sessions.use('Bearer '+b.token);
  f.advance(31);await assert.rejects(sessions.use('Bearer '+b.token),{status:401});
  const c=await sessions.issue(user);
  for(let i=0;i<8;i++){f.advance(20);await sessions.use('Bearer '+c.token);}
  f.advance(20);await assert.rejects(sessions.use('Bearer '+c.token),{status:401});
});
test('HTTP: login once, revoke Shopify token, then orders and profile still use the original app identity',async()=>{
  const f=fixture(),sessions=f.make('siya-ayurveda');
  let providerCalls=0,valid=true;const seen=[];
  const server=createApi({sessions,authenticate:async()=>{
    providerCalls++;if(!valid)throw new ApiError(401,'unauthenticated','Please sign in again');return user;
  },service:{queue:new SerialQueue(),orders:async identity=>{seen.push(identity.id);return {items:[{id:'owned-order'}]};},
    profile:async identity=>({data:{id:identity.id}})}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(path,token,method='GET')=>fetch(base+path,{method,
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
  try {
    const issued=await (await call('/v1/session','valid-storefront','POST')).json();
    valid=false;
    assert.equal((await call('/v1/orders',issued.token)).status,200);
    assert.equal((await call('/v1/profile',issued.token)).status,200);
    assert.equal((await (await call('/v1/session',issued.token)).json()).accountId,user.id);
    assert.deepEqual(seen,[user.id]);assert.equal(providerCalls,1);
    assert.equal((await call('/v1/session',issued.token,'POST')).status,400);
    assert.equal((await call('/v1/session/logout',issued.token,'POST')).status,200);
    assert.equal((await call('/v1/orders',issued.token)).status,401);
    assert.equal(providerCalls,1,'revoked app sessions never fall back to Shopify');
    assert.equal((await call('/v1/session','invalid-storefront','POST')).status,401);
    assert.equal((await call('/v1/orders','invalid-storefront')).status,401);
  } finally {await new Promise(r=>server.close(r));}
});
test('ERP outage is not a revoked session and cannot issue a fabricated session',async()=>{
  const sessions=new AppSessions({appId:'siya-ayurveda',queue:new SerialQueue(),records:{
    read:async()=>{throw new Error('ERP offline');},write:async()=>{throw new Error('ERP offline');}}});
  await assert.rejects(sessions.issue(user),/ERP offline/);
  await assert.rejects(sessions.use('Bearer ma1.'+'a'.repeat(64)),/ERP offline/);
});
