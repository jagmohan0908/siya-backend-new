import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductImages,createProductCatalog} from '../src/product-images.mjs';
import {orderDetails} from '../src/order-details.mjs';

test('Shopify images match invoice SKU, share catalogue requests and preserve ERP prices',async()=>{
  let calls=0;
  const productImage=createProductImages({domain:'test.myshopify.com',storefrontToken:'test',fetcher:async()=>{
    calls++;return Response.json({data:{products:{nodes:[{title:'Different product title',featuredImage:{url:'https://cdn.shopify.com/product.jpg'},
      variants:{nodes:[{sku:'ERP-SKU',image:{url:'https://cdn.shopify.com/variant.jpg'}}]}}],pageInfo:{hasNextPage:false}}}});
  }});
  const item={item_code:'ERP-SKU',item_name:'ERP product',rate:1499,amount:2998,qty:2};
  const [a,b]=await Promise.all([productImage(item),productImage(item)]);
  assert.equal(a,'https://cdn.shopify.com/variant.jpg');assert.equal(a,b);assert.equal(calls,1);
  const result=await orderDetails({name:'invoice',patient:'patient',items:[item],grand_total:2998},
    {name:'patient',patient_name:'Test Patient',sr_patient_id:'PID',mobile:'9999999999'},productImage);
  assert.equal(result.items[0].rate,1499);assert.equal(result.items[0].total,2998);assert.equal(result.total,2998);
  assert.deepEqual(result.patient,{name:'Test Patient',id:'PID',recordId:'patient',phone:'9999999999'});
});

test('image lookup follows catalogue pages and rejects ambiguous or unsafe images',async()=>{
  let calls=0;
  const image=createProductImages({domain:'test.myshopify.com',storefrontToken:'test',fetcher:async(_,req)=>{
    const cursor=JSON.parse(req.body).variables.after;calls++;
    return Response.json({data:{products:{nodes:cursor ? [
      {title:'Exact title',featuredImage:{url:'https://cdn.shopify.com/exact.jpg'},variants:{nodes:[]}},
      {title:'Duplicate',variants:{nodes:[{sku:'DUP',image:{url:'https://cdn.shopify.com/1.jpg'}},{sku:'DUP',image:{url:'https://cdn.shopify.com/2.jpg'}}]}},
      {title:'Unsafe',variants:{nodes:[{sku:'BAD',image:{url:'http://untrusted.test/image'}}]}},
    ] : [],pageInfo:{hasNextPage:!cursor,endCursor:'next'}}}});
  }});
  assert.equal(await image({item_name:'Exact title'}),'https://cdn.shopify.com/exact.jpg');assert.equal(calls,2);
  assert.equal(await image({item_code:'DUP'}),'');assert.equal(await image({item_code:'BAD'}),'');
  assert.equal(await image({item_name:'Exact'}),'');
});

test('Shopify failure leaves the ERP invoice available without a fabricated image',async()=>{
  const image=createProductImages({domain:'test.myshopify.com',storefrontToken:'test',fetcher:async()=>{throw Error('Offline');}});
  assert.equal(await image({item_code:'SKU'}),'');
  const result=await orderDetails({patient:'different',items:[]},{name:'current',patient_name:'Wrong patient',mobile:'123'},image);
  assert.equal(result.patient.name,'');assert.equal(result.patient.phone,'');assert.equal(result.patient.id,'different');
});


test('reorder IDs use the exact SKU or unique title match and reject ambiguous matches',async()=>{
  let calls=0;
  const lookup=createProductCatalog({domain:'test.myshopify.com',storefrontToken:'test',fetcher:async()=>{
    calls++;
    return Response.json({data:{products:{nodes:[
      {id:'gid://shopify/Product/123',title:'Cream',variants:{nodes:[{sku:'CREAM-SKU'}]}},
      {id:'gid://shopify/Product/456',title:'Wash',variants:{nodes:[{sku:'DUP'}]}},
      {id:'gid://shopify/Product/789',title:'Duplicate wash',variants:{nodes:[{sku:'DUP'}]}},
      {id:'gid://shopify/Product/999',title:'Cream',variants:{nodes:[]}},
    ],pageInfo:{hasNextPage:false}}}});
  }});
  assert.equal((await lookup({item_code:'CREAM-SKU',item_name:'Wash'})).shopifyProductId,'gid://shopify/Product/123');
  assert.equal((await lookup({item_name:'Wash'})).shopifyProductId,'gid://shopify/Product/456');
  assert.equal((await lookup({item_code:'DUP',item_name:'Wash'})).shopifyProductId,'');
  assert.equal((await lookup({item_name:'Cream'})).shopifyProductId,'');
  assert.equal((await lookup({item_code:'MISSING'})).shopifyProductId,'');
  assert.equal(calls,1);
});
