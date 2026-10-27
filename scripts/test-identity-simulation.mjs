import assert from 'node:assert/strict';
import {createAuthenticator} from '../src/auth.mjs';
const base=process.env.IDENTITY_SIMULATION_URL||'http://127.0.0.1:4911/shopify';
// Keep production request settings; redirect only the synthetic Shopify host.
const auth=createAuthenticator({domain:'test.myshopify.com',storefrontToken:'synthetic-only',
 fetcher:(url,options)=>fetch(base+new URL(url).pathname,options)});
for(const mode of ['valid','expired','throttled','partial','missing','unavailable','html']){
 const pending=auth('Bearer synthetic-'+mode);
 if(mode==='valid')assert.equal((await pending).id,'gid://shopify/Customer/123');
 else await assert.rejects(pending,{status:mode==='expired'?401:503,code:mode==='expired'?'unauthenticated':'identity_unavailable'});
 console.log('PASS identity HTTP '+mode);
}
