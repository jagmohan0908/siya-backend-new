import assert from 'node:assert/strict';
import {Erp} from '../src/erp.mjs';
import {Records,SerialQueue} from '../src/store.mjs';
import {AppSessions} from '../src/app-sessions.mjs';
import {createAuthenticator} from '../src/auth.mjs';
import {createApi} from '../src/server.mjs';

const base=process.env.APP_SESSION_SIMULATION_URL || 'http://127.0.0.1:4912';
await fetch(base+'/erp/test/reset',{method:'POST'});
let calls=0,providerMode='valid';
const authenticate=createAuthenticator({domain:'test.myshopify.com',storefrontToken:'synthetic-only',
  fetcher:(url,options)=>{
    calls++;
    const body=JSON.parse(options.body);body.variables.token='synthetic-'+providerMode;
    return fetch(base+'/shopify'+new URL(url).pathname,{...options,body:JSON.stringify(body)});
  }});
const queue=new SerialQueue(),records=new Records(new Erp({url:base+'/erp',token:'synthetic-only'}));
const sessions=new AppSessions({records,queue,appId:'siya-ayurveda'});
const api=createApi({sessions,authenticate,service:{queue}});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const apiUrl=`http://127.0.0.1:${api.address().port}`;
const call=(path,token,method='GET')=>fetch(apiUrl+path,{method,
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
try {
  const response=await call('/v1/session','synthetic-valid','POST');assert.equal(response.status,200);
  const issued=await response.json();assert.match(issued.token,/^ma1\./);assert.equal(calls,1);
  console.log('PASS: initial identity exchange writes a hashed app session over Frappe HTTP');
  for (const mode of ['expired','unavailable']) {
    providerMode=mode;
    assert.equal((await call('/v1/session',issued.token)).status,200);
    assert.equal(calls,1);
    console.log(`PASS: ${mode} Shopify session does not affect the established app session`);
  }
  assert.equal((await call('/v1/session/logout',issued.token,'POST')).status,200);
  assert.equal((await call('/v1/session',issued.token)).status,401);
  assert.equal(calls,1);
  console.log('PASS: logout persists revocation over Frappe HTTP; no Shopify fallback');
  providerMode='expired';assert.equal((await call('/v1/session','synthetic-expired','POST')).status,401);
  console.log('PASS: invalid initial identity cannot obtain a session');
} finally {await new Promise(r=>api.close(r));}
