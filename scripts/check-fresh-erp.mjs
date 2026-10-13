// Read-only checks against the imported test account. This tests the service/ERP
// boundary, not a Shopify login or a physical Android device.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {Erp} from '../src/erp.mjs';
import {MobileService} from '../src/service.mjs';
import {createProductCatalog} from '../src/product-images.mjs';
const pack=JSON.parse(await readFile(process.argv[2],'utf8'));
const erp=new Erp({url:process.env.ERP_URL,token:process.env.ERP_TOKEN});
assert.equal(new URL(erp.url).hostname,'srdevportal.tech');
const productCatalog=createProductCatalog({domain:process.env.SHOPIFY_DOMAIN,storefrontToken:process.env.SHOPIFY_STOREFRONT_TOKEN});
const service=new MobileService({erp,productCatalog,productImage:async item=>(await productCatalog(item)).imageUrl});
const localUser=pack.documents.find(d=>d.doctype==='Mobile App User');
const user={id:pack.account,name:localUser.full_name,phone:localUser.phone,email:localUser.email || ''};
const checks=[];
async function check(name,run) {
  try {const detail=await run();checks.push({name,status:'PASS',detail});}
  catch(e){checks.push({name,status:'BLOCKED',reason:e.message});}
}
await check('Patient and app profile link',async()=>{
  const identity=await service.identity(user);
  const parent=await erp.get('Mobile App User',identity.erpUser);
  assert.ok(identity.patient && parent.profiles.some(p=>p.patient_id===identity.patient),'Patient link is missing');
  assert.equal((await service.profile(user)).data.patientLinked,true);
  return {patient:identity.patient};
});
await check('Assessment history',async()=>{const d=await service.treatments(user);assert.ok(d.items.length);return{count:d.items.length}});
await check('Support ticket history',async()=>{const d=await service.support.list(user,'siya-ayurveda',{});assert.ok(d.items.length);return{count:d.items.length}});
await check('Actual prescription empty state',async()=>{const d=await service.habitPrescriptions(user,'siya-ayurveda');assert.equal(d.items.length,0,'Review against source encounters');return{count:0}});
for(const app of ['siya-ayurveda','seedfit'])await check(`${app} doctors and photos`,async()=>{
  const d=await service.doctors(app);assert.equal(d.doctors.length,2);
  for(const doctor of d.doctors){const photo=await service.doctorPhoto(doctor.id,app);assert.ok((await photo.arrayBuffer()).byteLength>0);}
  return {count:d.doctors.length};
});
await check('Doctor availability',async()=>{
  const date=process.argv[3];assert.match(date || '',/^\d{4}-\d{2}-\d{2}$/,'Pass a future test date');
  const result=await service.availability('Dr Neha Tiwari',date);assert.ok(result.slots.length);return{date,slots:result.slots.length};
});
await check('Purchased-product images and reorder mapping',async()=>{
  const items=[...new Map(pack.documents.filter(d=>d.doctype==='Sales Invoice').flatMap(d=>d.items).map(i=>[i.item_code,i])).values()];
  for(const item of items){const product=await productCatalog(item);assert.ok(product.imageUrl && product.shopifyProductId,`Catalogue mapping is missing for ${item.item_code}`);}
  return{products:items.length};
});
await check('Submitted test invoices and product images',async()=>{
  const result=await service.orders(user);assert.equal(result.items.length,2,'The two copied invoices are not submitted yet');
  for(const order of result.items){const detail=await service.invoice(user,order.id);assert.ok(detail.items.every(i=>i.imageUrl));}
  return{count:result.items.length};
});
await check('Purchase-based diet and PDF download',async()=>{
  const result=await service.diets(user);assert.equal(result.items.length,1,'A submitted mapped purchase is required');
  const pdf=await service.dietPdf(user,result.items[0].id);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');return{count:1};
});
await check('Latest-purchase habit products',async()=>{
  const result=await service.erpHabitTracker(user,'siya-ayurveda');
  assert.ok(result.orders?.length || result.data?.orders?.length,'A submitted purchase is required');
});
await check('Profile photo storage',async()=>{
  const result=await service.profile(user);assert.ok(result.data.imageFileId,'ERP stored the copied avatar locally; the existing app upload flow requires ERP S3 storage');
});
await check('Existing QuickLink ERP reply and product cards',async()=>{
  const ctx=await service.aiChat.context(user,'siya-ayurveda');
  const rows=await erp.list('Chat Conversation',{channel_account:ctx.account.name,contact:ctx.contactName},['name'],{limit:1});
  assert.ok(rows.length,'Run the public product-chat smoke test first');
  const {data}=await service.aiChat.call(user,'siya-ayurveda','get_messages',{conversation:String(rows[0].name)});
  const reply=data.messages.find(m=>m.sender_type==='AI' && m.cards.length===3);
  assert.ok(reply,'No ERP AI reply with product cards yet');
  assert.ok(reply.cards.every(c=>c.image_url?.startsWith('https://') && c.url?.startsWith('https://')));
  return{conversation:data.conversation_id,cards:reply.cards.length};
});
const report={site:erp.url,checkedAt:new Date().toISOString(),scope:'Read-only backend-to-ERP integration; not a device login or payment test',checks};
await writeFile(process.argv[2]+'.validation.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(checks.some(c=>c.status==='BLOCKED'))process.exitCode=1;
