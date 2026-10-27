import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthenticator} from '../src/auth.mjs';
const build=fetcher=>createAuthenticator({domain:'test.myshopify.com',storefrontToken:'synthetic',fetcher});
for(const [name,body] of Object.entries({throttled:{errors:[{extensions:{code:'THROTTLED'}}]}, partial:{data:{customer:null},errors:[{message:'Unavailable'}]},missing:{data:{}},malformed:{data:{customer:{}}}})) {
 test(`${name} identity response is retryable, not a forced login`,async()=>{
  await assert.rejects(build(async()=>Response.json(body))('Bearer customer-token'),{status:503,code:'identity_unavailable'});
 });
}
for(const name of ['offline','timeout','html','http503']) {
 test(`${name} identity failure preserves the authentication distinction`,async()=>{
  const fetcher=async()=>{if(name==='offline'||name==='timeout') throw new Error(name);return new Response('<html>error</html>',{status:name==='http503'?503:200});};
  await assert.rejects(build(fetcher)('Bearer customer-token'),{status:503,code:'identity_unavailable'});
 });
}
test('explicit invalid customer still requires login',async()=>{
 await assert.rejects(build(async()=>Response.json({data:{customer:null}}))('Bearer customer-token'),{status:401,code:'unauthenticated'});
});
test('verified identity comes only from Shopify',async()=>{
 const user=await build(async()=>Response.json({data:{customer:{id:'gid://shopify/Customer/123',phone:'+919311003366'}}}))('Bearer customer-token');
 assert.equal(user.id,'gid://shopify/Customer/123');
});
