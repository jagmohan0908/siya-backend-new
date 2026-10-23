import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {Erp} from '../src/erp.mjs';
import {withErpReadScope} from '../src/request-reads.mjs';
import {createApi} from '../src/server.mjs';
import {SerialQueue} from '../src/store.mjs';
import {SupportTickets} from '../src/support-tickets.mjs';
import {MobileService} from '../src/service.mjs';

test('one request coalesces parallel and repeated reads without sharing mutable documents',async()=>{
  let calls=0;
  const erp=new Erp({url:'https://erp.test',token:'test',fetcher:async()=>{
    calls++;await delay(1);return Response.json({data:{profiles:[{patient_id:'patient'}]}});
  }});
  await withErpReadScope(async()=>{
    const [a,b]=await Promise.all([erp.get('Mobile App User','user'),erp.get('Mobile App User','user')]);
    a.profiles[0].patient_id='changed';
    assert.equal(b.profiles[0].patient_id,'patient');
    assert.equal((await erp.get('Mobile App User','user')).profiles[0].patient_id,'patient');
  });
  assert.equal(calls,1);
  await withErpReadScope(()=>erp.get('Mobile App User','user'));
  assert.equal(calls,2,'next request must recheck the live record');
});

test('concurrent request scopes and different ERP credentials never share data',async()=>{
  let calls=0;
  const make=token=>new Erp({url:'https://erp.test',token,fetcher:async(_,o)=>{
    calls++;await delay(1);return Response.json({data:{identity:o.headers.Authorization}});
  }});
  const a=make('a'),b=make('b');
  const results=await Promise.all([a,b,a].map(erp=>withErpReadScope(()=>erp.get('Patient','same-id'))));
  assert.deepEqual(results.map(x=>x.identity),['token a','token b','token a']);
  await withErpReadScope(async()=>{
    assert.notDeepEqual(await a.get('Patient','same-id'),await b.get('Patient','same-id'));
  });
  assert.equal(calls,5);
});

test('writes invalidate both prior reads and reads started during the write',async()=>{
  let version=0,reads=0,finishWrite;
  const gate=new Promise(resolve=>{finishWrite=resolve;});
  const erp=new Erp({url:'https://erp.test',token:'test',fetcher:async(_,o)=>{
    if(o.method!=='GET'){await gate;version++;return Response.json({data:{version}});}
    reads++;return Response.json({data:{version}});
  }});
  await withErpReadScope(async()=>{
    assert.equal((await erp.get('Patient','id')).version,0);
    const write=erp.update('Patient','id',{});
    assert.equal((await erp.get('Patient','id')).version,0);
    finishWrite();await write;
    assert.equal((await erp.get('Patient','id')).version,1);
    assert.equal(reads,3);
  });
});

test('failed reads and failed writes do not retain stale results',async()=>{
  let fail=true,calls=0;
  const erp=new Erp({url:'https://erp.test',token:'test',fetcher:async(_,o)=>{
    calls++;
    if(fail||o.method!=='GET')return Response.json({exc_type:'PermissionError'},{status:403});
    return Response.json({data:{calls}});
  }});
  await withErpReadScope(async()=>{
    await assert.rejects(erp.get('Patient','id'));
    fail=false;assert.equal((await erp.get('Patient','id')).calls,2);
    await assert.rejects(erp.update('Patient','id',{}));
    assert.equal((await erp.get('Patient','id')).calls,4);
  });
});

test('binary streams and ERP methods are always fetched independently',async()=>{
  let calls=0;
  const erp=new Erp({url:'https://erp.test',token:'test',fetcher:async()=>{
    calls++;return Response.json({data:{calls}});
  }});
  await withErpReadScope(async()=>{
    for(let i=0;i<2;i++)await erp.method('example.method');
    for(let i=0;i<2;i++)await (await erp.request('/api/resource/File/id',{raw:true})).text();
  });
  assert.equal(calls,4);
});

test('GET method side effects invalidate previously read documents',async()=>{
  let version=0;
  const erp=new Erp({url:'https://erp.test',token:'test',fetcher:async url=>{
    if(url.includes('/api/method/'))version++;
    return Response.json({data:{version}});
  }});
  await withErpReadScope(async()=>{
    assert.equal((await erp.get('Patient','id')).version,0);
    await erp.method('example.update');
    assert.equal((await erp.get('Patient','id')).version,1);
  });
});

test('HTTP handler establishes a fresh ERP read scope for every customer request',async t=>{
  let calls=0;
  const erp=new Erp({url:'https://erp.test',token:'test',fetcher:async()=>Response.json({data:{version:++calls}})});
  const service={queue:new SerialQueue(),profile:async user=>{
    const first=await erp.get('Mobile App User',user.id);
    const second=await erp.get('Mobile App User',user.id);
    assert.deepEqual(first,second);return second;
  }};
  const server=createApi({service,authenticate:async()=>({id:'user'})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}/v1/profile`;
  assert.equal((await (await fetch(url)).json()).version,1);
  assert.equal((await (await fetch(url)).json()).version,2);
  assert.equal(calls,2);
});

for(const app of ['seedfit','siya-ayurveda'])test(`${app} support loads at most four details at once and retains ordering/ownership`,async()=>{
  let active=0,peak=0,wrongOwner=false;
  const user={id:'customer'};
  const erp={list:async()=>Array.from({length:9},(_,n)=>({name:String(n)})),get:async(_,id)=>{
    peak=Math.max(peak,++active);await delay(10-Number(id));active--;
    return {name:id,user_id:wrongOwner?'stranger':app==='seedfit'?'seedfit:customer':'customer',
      custom_mobile_app:app==='seedfit'?'Seedfit':'Siya Ayurveda',creation:'2026-10-23 10:00:00'};
  }};
  const support=new SupportTickets({erp});
  const result=await support.list(user,app);
  assert.equal(peak,4);assert.deepEqual(result.items.map(x=>x.id),Array.from({length:9},(_,n)=>String(n)));
  wrongOwner=true;await assert.rejects(support.list(user,app),{status:404});
});

for(const app of ['seedfit','siya-ayurveda'])test(`${app} profile saves one ERP round trip and sees patient unlinking on the next request`,async()=>{
  const user={id:'fixture',name:'Fixture'};
  const account=app==='seedfit'?`${app}:${user.id}`:user.id;
  let service,calls=0,linked=true;
  const erp=new Erp({url:'https://erp.test',token:'test',fetcher:async url=>{
    calls++;
    const name=decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    let data;
    if(name===service.records.key(user.id,'identity','self')) {
      data={account,kind:'identity',payload:JSON.stringify({erpUser:'parent',patient:'patient'})};
    } else if(name===service.records.key(user.id,'profile','self')) {
      data={account,kind:'profile',payload:'{}'};
    } else if(name==='parent') {
      data={name,external_id:account,profiles:linked?[{patient_id:'patient'}]:[]};
    } else throw new Error('Unexpected fixture request');
    return Response.json({data});
  }});
  service=new MobileService({erp,appId:app});
  const baseline=await service.profile(user);
  assert.equal(calls,4);
  calls=0;
  assert.deepEqual(await withErpReadScope(()=>service.profile(user)),baseline);
  assert.equal(calls,3);
  linked=false;
  assert.equal((await withErpReadScope(()=>service.profile(user))).data.patientLinked,false);
  assert.equal(calls,6);
});
