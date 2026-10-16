import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatProductSearch,safeProductCard} from '../src/chat-products.mjs';
const product={id:'gid://shopify/Product/1',title:'Acne Spot Gel',handle:'acne-spot-gel',description:'Catalogue description',tags:['acne'],productType:'Skin',availableForSale:true,featuredImage:{url:'https://cdn.shopify.com/p.png'},priceRange:{minVariantPrice:{amount:'699.0',currencyCode:'INR'}}};
function setup(nodes=[product]){const requests=[];const search=createChatProductSearch({domain:'store.myshopify.com',storefrontToken:'test',fetcher:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({data:{products:{nodes,pageInfo:{hasNextPage:false}}}})}}});return {search,requests};}
test('catalogue cards use actual Shopify facts, safe images and canonical purchase links',async()=>{
 const {search,requests}=setup();const [c]=await search('mujhe acne hai products batao','siya-ayurveda');
 assert.equal(c.title,product.title);assert.equal(c.price,'699.0');assert.equal(c.url,'https://siyaayurveda.com/products/acne-spot-gel');assert.equal(c.image_url,product.featuredImage.url);
 assert.ok(!requests[0].options.body.includes('mujhe'));assert.equal(requests[0].options.redirect,'error');
 await search('acne products','siya-ayurveda');assert.equal(requests.length,1);
});
test('private orders, dose questions and other stores never cause product suggestions',async()=>{
 const {search,requests}=setup();
 for(const q of ['where is my acne order','how to take acne tablets','acne side effects','how to use acne gel','is acne gel safe while pregnant','how should I apply hair oil',"do not recommend products for acne"])
  assert.deepEqual(await search(q,'siya-ayurveda'),[]);
 assert.deepEqual(await search('acne products','seedfit'),[]);assert.equal(requests.length,0);
});
test('unmatched chat and missing catalogue configuration return no fabricated products',async()=>{
 const {search}=setup();assert.deepEqual(await search('hello there','siya-ayurveda'),[]);
 assert.deepEqual(await createChatProductSearch({})('acne','siya-ayurveda'),[]);
});

test('support and availability questions do not match generic words in product titles',async()=>{
 const {search}=setup([{...product,title:'Gut Support',tags:[]},{...product,title:'Fertility Support',tags:[]}]);
 for(const message of ['Is support available?','Please confirm customer support is available','Hello support team','Seedfit integration test: please confirm support is available. This is a test, no medical advice needed.'])
  assert.deepEqual(await search(message,'siya-ayurveda'),[]);
 assert.equal((await search('fertility support products','siya-ayurveda')).length,1);
});
test('catalogue errors do not break chat or expose stale prices',async()=>{
 const search=createChatProductSearch({domain:'store.myshopify.com',storefrontToken:'test',fetcher:async()=>{throw Error('offline')}});
 assert.deepEqual(await search('acne','siya-ayurveda'),[]);
});
test('unsafe cards are rejected; unavailable products have no buy action',async()=>{
 const {search}=setup([{...product,availableForSale:false}]);const [c]=await search('acne','siya-ayurveda');assert.equal(c.available,false);
 for(const url of ['http://siyaayurveda.com/products/a','https://evil.test/products/a','https://siyaayurveda.com@evil.test/products/a','https://siyaayurveda.com/cart','https://siyaayurveda.com/products/../../cart'])assert.equal(safeProductCard({...c,url}),null);
 assert.equal(safeProductCard({...c,image_url:'https://evil.test/p.png'}).image_url,'');assert.equal(safeProductCard({...c,price:'NaN'}),null);
});
