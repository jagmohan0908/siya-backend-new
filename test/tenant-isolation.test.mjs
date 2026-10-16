import {invoiceKit} from '../src/invoice-kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenants} from '../src/tenants.mjs';
import {Records} from '../src/store.mjs';
import {MobileService} from '../src/service.mjs';
import {safeProductCard,createChatProductSearch} from '../src/chat-products.mjs';
import {createApi} from '../src/server.mjs';

const env={SHOPIFY_DOMAIN:'siya-example.myshopify.com',SHOPIFY_STOREFRONT_TOKEN:'siya-public-token',
  SEEDFIT_SHOPIFY_DOMAIN:'seed-example.myshopify.com',SEEDFIT_SHOPIFY_STOREFRONT_TOKEN:'seed-public-token'};
test('each app verifies its customer against its own store; missing Seedfit never falls back',async()=>{
  const calls=[];
  const tenants=createTenants({erp:{},env,fetcher:async(url,opts)=>{
    calls.push([new URL(url).hostname,opts.headers['X-Shopify-Storefront-Access-Token']]);
    return Response.json({data:{customer:{id:'gid://shopify/Customer/123',firstName:'Test'}}});
  }});
  await tenants('seedfit').authenticate('Bearer test-customer-token');
  await tenants('siya-ayurveda').authenticate('Bearer test-customer-token');
  assert.deepEqual(calls,[['seed-example.myshopify.com','seed-public-token'],['siya-example.myshopify.com','siya-public-token']]);
  assert.notEqual(tenants('seedfit').service,tenants('siya-ayurveda').service);
  assert.equal(tenants('seedfit').service.meetings.configured,false);
  assert.equal(tenants('seedfit').allowBookings,false);
  assert.throws(()=>createTenants({erp:{},env:{SHOPIFY_DOMAIN:env.SHOPIFY_DOMAIN,SHOPIFY_STOREFRONT_TOKEN:env.SHOPIFY_STOREFRONT_TOKEN}})('seedfit'),{code:'app_setup_required'});
  assert.throws(()=>tenants('unknown'),{code:'invalid_app'});
});
test('same external customer and booking ID cannot read another app generic records',async()=>{
  const docs=new Map();const erp={maybe:async(_,id)=>docs.get(id),create:async(_,doc)=>{docs.set(doc.record_key,doc);return doc;},
    update:async(_,id,doc)=>{docs.set(id,doc);return doc;},list:async(_,filters)=>[...docs.values()].filter(d=>d.account===filters.account && d.kind===filters.kind)};
  const siya=new Records(erp),seed=new Records(erp,'seedfit');
  await siya.write('customer','appointment','booking',{doctor:'other app'},0);
  assert.equal(await seed.read('customer','appointment','booking'),null);
  assert.deepEqual(await seed.list('customer','appointment'),[]);
  await seed.write('customer','appointment','booking',{doctor:'seed doctor'},0);
  assert.equal((await seed.read('customer','appointment','booking')).data.doctor,'seed doctor');
  assert.equal((await siya.read('customer','appointment','booking')).data.doctor,'other app');
  await seed.write('customer','appointment','booking',{doctor:'updated seed doctor'},1);
  assert.equal((await seed.read('customer','appointment','booking')).revision,2);
});
test('Seedfit ERP identity does not attach a raw customer ID or infer patient from phone',async()=>{
  const calls=[];const erp={maybe:async()=>null,list:async(type,filters)=>{calls.push({type,filters});return [];},
    create:async(type,doc)=>{calls.push({type,doc});return {name:'seed-user',...doc};}};
  const service=new MobileService({erp,appId:'seedfit'});
  const identity=await service.identity({id:'gid://shopify/Customer/123',name:'Test',phone:'9000000000'});
  assert.equal(identity.patient,null);
  assert.deepEqual(calls.find(c=>c.filters).filters.external_id,['in',['seedfit:gid://shopify/Customer/123']]);
});
test('Seedfit product cards only link to Seedfit and use its catalogue',async()=>{
  const card={type:'product',product_id:'gid://shopify/Product/123',title:'Care',price:'10',currency:'INR',available:true,url:'https://seed.fit/products/care'};
  assert.ok(safeProductCard(card,'seedfit'));
  assert.equal(safeProductCard({...card,url:'https://siyaayurveda.com/products/care'},'seedfit'),null);
  assert.equal(safeProductCard(card,'siya-ayurveda'),null);
  const lookup=createChatProductSearch({appId:'seedfit',domain:'seed-example.myshopify.com',storefrontToken:'test',fetcher:async()=>Response.json({data:{products:{nodes:[{
    id:card.product_id,title:'Fertility Care',handle:'care',description:'Care',tags:[],availableForSale:true,priceRange:{minVariantPrice:{amount:'10',currencyCode:'INR'}}}],pageInfo:{hasNextPage:false}}}})});
  assert.equal((await lookup('fertility care','seedfit'))[0].url,card.url);
  assert.deepEqual(await lookup('fertility care','siya-ayurveda'),[]);
});
test('HTTP routing binds authenticated and public calls to selected app',async()=>{
  const calls=[];
  const server=createApi({tenants:app=>({authenticate:async()=>{calls.push(`auth:${app}`);return{id:'test'};},allowBookings:false,
    service:{queue:{run:(_,fn)=>fn()},profile:async()=>({app}),doctors:async()=>({app})}})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const url=`http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await (await fetch(url+'/v1/profile?app=seedfit')).json(),{app:'seedfit'});
    assert.deepEqual(calls,['auth:seedfit']);
    assert.equal((await fetch(url+'/v1/doctors?app=bad')).status,400);
  } finally { await new Promise(r=>server.close(r)); }
});


test('Seedfit patient access follows the current clinic-approved profile link',async()=>{
  let profiles=[];
  const service=new MobileService({appId:'seedfit',erp:{
    maybe:async()=>({account:'seedfit:customer',kind:'identity',payload:JSON.stringify({erpUser:'seed-user',patient:'stale-patient'}),revision:1}),
    get:async()=>({name:'seed-user',external_id:'seedfit:customer',profiles}),
  }});
  const user={id:'customer'};
  assert.equal((await service.identity(user)).patient,null);
  profiles=[{patient_id:'seed-patient'}];
  assert.equal((await service.identity(user)).patient,'seed-patient');
  profiles=[{patient_id:'seed-patient'},{patient_id:'second-patient'}];
  assert.equal((await service.identity(user)).patient,null);
});

test('Seedfit kit reorder cannot inherit a shared template product from another store',async()=>{
  const erp={get:async()=>({name:'kit',template_name:'Care kit',custom_shopify_product_id:'gid://shopify/Product/111',custom_mobile_image_url:'https://cdn.shopify.com/other-store.jpg'})};
  const kit=await invoiceKit(erp,{item_group_template:'kit'},async()=>'',async()=>({shopifyProductId:'',imageUrl:''}));
  assert.equal(kit.shopifyProductId,'');assert.equal(kit.imageUrl,'');
  const matching=await invoiceKit(erp,{item_group_template:'kit'},async()=>'',async()=>({shopifyProductId:'gid://shopify/Product/222',imageUrl:'https://cdn.shopify.com/seed.jpg'}));
  assert.equal(matching.shopifyProductId,'gid://shopify/Product/222');
});
