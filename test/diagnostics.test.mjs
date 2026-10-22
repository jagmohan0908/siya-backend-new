import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/server.mjs';
import {Erp} from '../src/erp.mjs';
import {ApiError} from '../src/errors.mjs';
import {apiRoute,erpRoute,erpFailureDetails} from '../src/diagnostics.mjs';

test('route templates discard IDs, arbitrary paths and all query parameters',()=>{
  assert.equal(apiRoute('/v1/invoices/PATIENT%2FPRIVATE/pdf?token=SECRET'),'/v1/invoices/:id/pdf');
  assert.equal(apiRoute('/v1/support-tickets/PRIVATE/messages?after=SECRET'),'/v1/support-tickets/:id/messages');
  assert.equal(apiRoute('/PRIVATE/SECRET?token=SECRET'),'unmatched');
  assert.equal(erpRoute('/api/resource/Patient%20Encounter/PRIVATE?token=SECRET'),'/api/resource/Patient Encounter/:name');
  assert.equal(erpRoute('/api/resource/PRIVATE/SECRET'),'/api/resource/:doctype/:name');
  assert.equal(erpRoute('/api/method/PRIVATE?token=SECRET'),'/api/method/:method');
  assert.equal(erpRoute('/api/method/mobile_app.api.practitioners.availability?patient=PRIVATE'),
    '/api/method/mobile_app.api.practitioners.availability');
  assert.equal(erpFailureDetails('/api/resource/Patient','GET',500,'PRIVATE').upstream_exception,'Unknown');
});

async function serving(t, service, authenticate=async()=>({id:'PRIVATE'})) {
  const logs=[];
  const server=createApi({service,authenticate,logError:entry=>logs.push(entry)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {logs,url:'http://127.0.0.1:'+server.address().port};
}

test('ERP failures are correlated without leaking patient data or changing public errors',async t=>{
  const erp=new Erp({url:'https://erp.invalid',token:'ERP_SECRET',fetcher:async()=>Response.json({
    exc_type:'OperationalError',exception:'PRIVATE diagnosis ERP_SECRET',exc:['PRIVATE traceback'],
  },{status:500})});
  const service={queue:{run:(_,fn)=>fn()},invoice:()=>erp.get('Sales Invoice','PRIVATE')};
  const {url,logs}=await serving(t,service);
  const response=await fetch(url+'/v1/invoices/PRIVATE?token=QUERY_SECRET',{
    headers:{Authorization:'Bearer AUTH_SECRET','X-Request-ID':'PRIVATE'},
  });
  assert.equal(response.status,502);
  assert.deepEqual(await response.json(),{error:{code:'erp_request_failed',message:'ERP could not complete the request (500)'}});
  assert.equal(logs.length,1);
  const entry=logs[0];
  assert.equal(entry.route,'/v1/invoices/:id');
  assert.equal(entry.method,'GET');
  assert.equal(entry.erp_route,'/api/resource/Sales Invoice/:name');
  assert.equal(entry.erp_method,'GET');
  assert.equal(entry.upstream_status,500);
  assert.equal(entry.upstream_exception,'OperationalError');
  assert.equal(entry.request_id,response.headers.get('x-request-id'));
  assert.match(entry.request_id,/^[0-9a-f-]{36}$/);
  assert.ok(entry.duration_ms>=0);
  for (const value of ['PRIVATE','SECRET','diagnosis','traceback']) assert.ok(!JSON.stringify(entry).includes(value));
});

test('401 records identify the route without recording credentials or request body',async t=>{
  const {url,logs}=await serving(t,{},async()=>{throw new ApiError(401,'unauthenticated','Please sign in again');});
  const response=await fetch(url+'/v1/profile?email=PRIVATE',{
    method:'PUT',headers:{Authorization:'Bearer SECRET','Content-Type':'application/json'},
    body:JSON.stringify({name:'PRIVATE',medical:'PRIVATE'}),
  });
  assert.equal(response.status,401);
  assert.equal(logs[0].route,'/v1/profile');
  assert.equal(logs[0].method,'PUT');
  assert.equal(logs[0].code,'unauthenticated');
  assert.ok(!('upstream_status' in logs[0]));
  assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
  assert.ok(!JSON.stringify(logs).includes('SECRET'));
});

test('transport timeouts keep the existing 503 response and log only their classification',async t=>{
  const erp=new Erp({url:'https://erp.invalid',token:'SECRET',fetcher:async()=>{throw new DOMException('PRIVATE SECRET','TimeoutError');}});
  const {url,logs}=await serving(t,{doctors:()=>erp.list('Healthcare Practitioner')});
  const response=await fetch(url+'/v1/doctors');
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:{code:'temporarily_unavailable',message:'Service is temporarily unavailable. Please try again.'}});
  assert.equal(logs[0].upstream_failure,'timeout');
  assert.equal(logs[0].erp_route,'/api/resource/Healthcare Practitioner');
  assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
});

test('non-JSON errors and conflicts preserve upstream diagnostics and conflict behaviour',async()=>{
  for(const [type,status,code] of [['TimestampMismatchError',409,'revision_conflict'],['DuplicateEntryError',409,'revision_conflict'],[null,502,'erp_request_failed']]) {
    const erp=new Erp({url:'https://erp.invalid',token:'SECRET',fetcher:async()=> type
      ? Response.json({exc_type:type,exception:'PRIVATE'},{status:500})
      : new Response('<html>PRIVATE</html>',{status:502})});
    await assert.rejects(erp.update('Mobile App User','PRIVATE',{phone:'SECRET'}),e=>{
      assert.equal(e.status,status); assert.equal(e.code,code);
      assert.equal(e.erpDiagnostic.upstream_exception,type||'Unknown');
      assert.equal(e.erpDiagnostic.erp_method,'PUT');
      assert.ok(!JSON.stringify(e).includes('PRIVATE')); assert.ok(!JSON.stringify(e).includes('SECRET'));
      return true;
    });
  }
});

test('successful health checks remain unauthenticated and emit no failure entry',async t=>{
  const {url,logs}=await serving(t,{},async()=>{throw Error('must not authenticate');});
  const response=await fetch(url+'/health');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,version:1});
  assert.equal(logs.length,0);
});
