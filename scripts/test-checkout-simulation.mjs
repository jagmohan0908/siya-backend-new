import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Erp} from '../src/erp.mjs';
import {MobileService} from '../src/service.mjs';
import {createApi} from '../src/server.mjs';
const base=process.env.SIMULATION_ERP_URL || 'http://127.0.0.1:4918/erp';
await fetch(`${base}/test/reset`,{method:'POST'});
const service=new MobileService({erp:new Erp({url:base,token:'simulation-only'}),
  checkoutTracking:{domain:'test.myshopify.com',secret:'simulation-only',enabled:true}});
const user={id:'gid://shopify/Customer/1'};
const api=createApi({service,authenticate:async()=>user});
await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
const apiUrl=`http://127.0.0.1:${api.address().port}`;
try {
  const prepared=await fetch(`${apiUrl}/v1/checkout-intents`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({items:[{variantId:'123',quantity:1}]})});
  assert.equal(prepared.status,200);
  const {attributes}=await prepared.json();
  const body=JSON.stringify({id:20834,created_at:new Date().toISOString(),phone:'+919873090386',
    note_attributes:Object.entries(attributes).map(([name,value])=>({name,value})),line_items:[{variant_id:123,quantity:1}]});
  const headers={'content-type':'application/json','x-shopify-shop-domain':'test.myshopify.com','x-shopify-topic':'orders/create',
    'x-shopify-hmac-sha256':createHmac('sha256','simulation-only').update(body).digest('base64')};
  await fetch(`${base}/test/fail-grant?enabled=true`,{method:'POST'});
  const first=await fetch(`${apiUrl}/v1/shopify-order-created`,{method:'POST',headers,body});
  assert.equal(first.status,502);
  assert.deepEqual(await service.checkoutTracking.ids(user),[]);
  await fetch(`${base}/test/fail-grant?enabled=false`,{method:'POST'});
  for(let i=0;i<2;i++) {
    const retry=await fetch(`${apiUrl}/v1/shopify-order-created`,{method:'POST',headers,body});
    assert.equal(retry.status,200);
  }
  assert.deepEqual(await service.checkoutTracking.ids(user),['20834']);
  assert.deepEqual(await service.checkoutTracking.ids({id:'other-account'}),[]);
  console.log('PASS: real HTTP API + ERP client; failed grant retried, replay deduplicated, other account excluded.');
} finally {await new Promise(resolve=>api.close(resolve));}
