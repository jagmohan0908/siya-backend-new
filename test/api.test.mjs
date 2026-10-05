import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/server.mjs';
import {MobileService,appointmentStatus} from '../src/service.mjs';
import {Records,SerialQueue,recordName} from '../src/store.mjs';
import {createAuthenticator} from '../src/auth.mjs';
import {ApiError} from '../src/errors.mjs';
import {Razorpay} from '../src/payments.mjs';
import {isPerfectDay} from '../src/habits.mjs';

class FakeErp {
  constructor() { this.docs = new Map(); this.created = []; this.url = 'https://erp.test'; }
  async maybe(type,name) { return this.docs.get(`${type}/${name}`) || null; }
  async get(type,name) { const value = await this.maybe(type,name); if (!value) throw new ApiError(404,'not_found','Not found'); return structuredClone(value); }
  async create(type,doc) {
    const name = doc.record_key || doc.appointment_external_id || doc.external_id || `doc-${this.created.length}`;
    if (await this.maybe(type,name)) throw new ApiError(409,'duplicate','Already exists');
    const saved = {...structuredClone(doc),name}; this.docs.set(`${type}/${name}`,saved); this.created.push({type,...saved}); return saved;
  }
  async update(type,name,fields) { const result = {...await this.get(type,name),...structuredClone(fields)}; this.docs.set(`${type}/${name}`,result); return result; }
  async list(type,filters,fields,options) {
    return [...this.docs.entries()].filter(([key]) => key.startsWith(`${type}/`)).map(([,doc]) => structuredClone(doc)).filter(doc =>
      Object.entries(filters || {}).every(([key,value]) => Array.isArray(value) ? value[0] === 'in' ? value[1].includes(doc[key]) : true : doc[key] === value));
  }
  async method(name) {
    if (name.endsWith('.availability')) return {slots:[{time:'10:00:00',duration:10,remaining:1,schedule_id:'schedule'}],timezone:'Asia/Kolkata'};
    if (name.endsWith('.list_doctors')) return {doctors:[{id:'Megha',name:'Megha',specialty:'Skin',tags:[],schedules:[{days:['Monday']}],is_active:true}],timezone:'Asia/Kolkata'};
  }
}
const user = {id:'gid://shopify/Customer/1',name:'Test Account',email:'test@example.invalid',phone:'+919999999999'};
const booking = {id:'11111111-1111-1111-1111-111111111111',doctorId:'Megha',appointmentDate:'2026-10-05',time:'10:00:00',timeSlot:'10:00 AM',consultationType:'opd',patientName:'Test Patient'};
const setup = options => { const erp = new FakeErp(); return {erp,service:new MobileService({erp,doctorPolicy:{Megha:{enabled:true,fee:0,mode:'opd'}},...options})}; };

test('record ownership is part of the deterministic key',async () => {
  const {erp} = setup(); const records = new Records(erp);
  await records.write(user.id,'treatment','id',{answers:{q:'a'}},0);
  assert.equal(await records.read('another-customer','treatment','id'),null);
  assert.notEqual(recordName('a','b','c'),recordName('a','bc',''));
});
test('stale revisions are rejected without overwriting the current record',async () => {
  const {erp} = setup(); const records = new Records(erp);
  await records.write(user.id,'profile','self',{name:'First'},0);
  await assert.rejects(records.write(user.id,'profile','self',{name:'Stale'},0),{status:409});
  assert.equal((await records.read(user.id,'profile','self')).data.name,'First');
});
test('concurrent customer writes execute in order and recover after failure',async () => {
  const queue = new SerialQueue(); const order=[];
  await Promise.allSettled([queue.run('a',async () => {await new Promise(r => setTimeout(r,10));order.push(1);throw Error('x');}),queue.run('a',async () => order.push(2))]);
  assert.deepEqual(order,[1,2]);assert.equal(queue.pending.size,0);
});
test('Shopify verifies identity; supplied metadata cannot select a patient',async () => {
  let request;
  const authenticate=createAuthenticator({domain:'test.myshopify.com',storefrontToken:'public',fetcher:async (_,args) => {request=JSON.parse(args.body);return Response.json({data:{customer:{id:user.id,firstName:'Verified'}}});}});
  assert.equal((await authenticate('Bearer valid-token-123')).id,user.id);
  assert.equal(request.variables.token,'valid-token-123');
  await assert.rejects(authenticate('Bearer shiprocket_session'.replace('Bearer','Invalid')),{status:401});
});
test('invalid and expired Shopify tokens are rejected',async () => {
  const auth=createAuthenticator({domain:'test.myshopify.com',storefrontToken:'public',fetcher:async () => Response.json({data:{customer:null}})});
  await assert.rejects(auth('Bearer expired-token-123'),{status:401});
});
test('webhook timeout preserves a confirmed reservation and retry does not post twice',async () => {
  let calls=0; const {service,erp}=setup({webhookUrl:'https://webhook.test',fetcher:async () => {calls++;throw Error('timeout');}});
  const first=await service.createAppointment(user,booking);
  const second=await service.createAppointment(user,booking);
  assert.equal(first.bookingSyncPending,false);assert.equal(first.encounterSyncPending,true);assert.equal(first.status,'confirmed');
  assert.equal((await erp.get('Mobile App Appointment',first.reservation)).status,'Confirmed');assert.equal(second.id,first.id);assert.equal(calls,1);
  assert.equal(erp.created.filter(d=>d.type==='Mobile App Appointment').length,1);
});
test('ERP Approved and Checked In remain distinct from clinical completion',() => {
  assert.equal(appointmentStatus('Approved'),'confirmed');assert.equal(appointmentStatus('Checked In'),'checked_in');
  assert.equal(appointmentStatus('Cancelled'),'cancelled');
});

test('failed ERP confirmation is not reported as success and does not send a webhook',async()=>{
  let calls=0;
  const {service,erp}=setup({webhookUrl:'https://webhook.test',fetcher:async()=>{calls++;return Response.json({});}});
  const update=erp.update.bind(erp);
  erp.update=async(type,name,fields)=>{
    if(type==='Mobile App Appointment' && fields.status==='Confirmed') throw new ApiError(502,'erp_request_failed','Offline');
    return update(type,name,fields);
  };
  await assert.rejects(service.createAppointment(user,booking),{status:502});
  const saved=await service.records.read(user.id,'appointment',booking.id);
  assert.equal(saved.data.status,'pending');assert.equal(saved.data.bookingSyncPending,true);assert.equal(calls,0);
  erp.update=update;
  assert.equal((await service.createAppointment(user,booking)).status,'confirmed');
  assert.equal(erp.created.filter(d=>d.type==='Mobile App Appointment').length,1);
  assert.equal(calls,1);
});

test('confirmation requires ERP readback, not just a successful update response',async()=>{
  const {service,erp}=setup({webhookUrl:'https://webhook.test',fetcher:async()=>assert.fail('must not deliver')});
  const update=erp.update.bind(erp);
  erp.update=async(type,name,fields)=>type==='Mobile App Appointment'
    ? {...await erp.get(type,name),...fields} : update(type,name,fields);
  await assert.rejects(service.createAppointment(user,booking),{status:409});
  assert.equal((await service.records.read(user.id,'appointment',booking.id)).data.bookingSyncPending,true);
});

test('paid reservations stay pending until the payment gateway verifies capture',async()=>{
  let verified=false,calls=0;
  const {service,erp}=setup({webhookUrl:'https://webhook.test',fetcher:async()=>{calls++;throw Error('timeout');},
    payments:{keyId:'test',create:async()=>({id:'order_123'}),verify:async()=>{if(!verified)throw new ApiError(409,'unpaid','Not captured');}}});
  service.doctorPolicy.Megha.fee=1000;
  await service.createAppointment(user,booking,true);
  let record=await service.records.read(user.id,'appointment',booking.id);
  await assert.rejects(service.confirmReservation(user,record),{code:'payment_not_verified'});
  await assert.rejects(service.createAppointment(user,{...booking,paymentId:'pay_test'}),{status:409});
  assert.equal((await erp.get('Mobile App Appointment',record.data.reservation)).status,'Pending');assert.equal(calls,0);
  verified=true;
  const result=await service.createAppointment(user,{...booking,paymentId:'pay_test'});
  assert.equal(result.paymentStatus,'paid');assert.equal(result.status,'confirmed');assert.equal(result.bookingSyncPending,false);
  assert.equal((await erp.get('Mobile App Appointment',record.data.reservation)).status,'Confirmed');assert.equal(calls,1);
});

test('confirmation rejects foreign reservations, cancelled bookings and changed appointment times',async()=>{
  const {service,erp}=setup({webhookUrl:'https://webhook.test',fetcher:async()=>{throw Error('timeout');}});
  const first=await service.createAppointment(user,booking);
  const record=await service.records.read(user.id,'appointment',booking.id);
  await erp.update('Mobile App Appointment',first.reservation,{mobile_app_user:'another-account',status:'Pending'});
  await assert.rejects(service.confirmReservation(user,record),{code:'unverified_reservation'});
  const identity=await service.identity(user);
  await erp.update('Mobile App Appointment',first.reservation,{mobile_app_user:identity.erpUser,status:'Cancelled'});
  await assert.rejects(service.confirmReservation(user,record),{status:409});
  assert.equal((await service.refreshAppointment(user,record)).status,'cancelled');
  await erp.update('Mobile App Appointment',first.reservation,{status:'Pending',appointment_time:'12:00:00'});
  await assert.rejects(service.confirmReservation(user,record),{status:409});
});

test('a pending Encounter cannot downgrade a confirmed booking and cancellation remains authoritative',async()=>{
  const {service,erp}=setup({webhookUrl:'https://webhook.test'});
  service.fetcher=async()=>Response.json({data:await erp.create('Patient Encounter',{
    doctype:'Patient Encounter',patient:'test-patient',docstatus:0,sr_notes:`External appointment ID: ${booking.id}`,custom_appointment_status:'Pending'})});
  const first=await service.createAppointment(user,booking);
  assert.equal(first.status,'confirmed');assert.equal(first.encounterSyncPending,false);
  assert.equal((await service.createAppointment(user,booking)).status,'confirmed');
  await erp.update('Mobile App Appointment',first.reservation,{status:'Cancelled'});
  assert.equal((await service.createAppointment(user,booking)).status,'cancelled');
  assert.equal(erp.created.filter(d=>d.type==='Patient Encounter').length,1);
});

test('cancellation while the webhook runs is preserved when attaching the Encounter',async()=>{
  const {service,erp}=setup({webhookUrl:'https://webhook.test'});
  service.fetcher=async()=>{
    const record=await service.records.read(user.id,'appointment',booking.id);
    await erp.update('Mobile App Appointment',record.data.reservation,{status:'Cancelled'});
    return Response.json({data:await erp.create('Patient Encounter',{
      doctype:'Patient Encounter',patient:'test-patient',docstatus:0,sr_notes:`External appointment ID: ${booking.id}`,custom_appointment_status:'Pending'})});
  };
  assert.equal((await service.createAppointment(user,booking)).status,'cancelled');
});
test('forged free price cannot bypass the backend doctor fee',async () => {
  const {service}=setup();service.doctorPolicy.Megha.fee=1000;
  await assert.rejects(service.createAppointment(user,{...booking,consultationFee:0,paymentStatus:'free'}),{status:503});
});
test('a legacy clinic booking removes that slot',async () => {
  const {erp,service}=setup();await erp.create('Clinic Appointment',{practitioner:'Megha',appointment_date:booking.appointmentDate,appointment_time:'10:00:00'});
  assert.equal((await service.availability('Megha',booking.appointmentDate)).slots.length,0);
  await assert.rejects(service.createAppointment(user,booking),{status:409});
});
test('webhook cannot link an unrelated encounter',async () => {
  const {service,erp}=setup();await erp.create('Patient Encounter',{name:'wrong',sr_notes:'Other booking'});
  const row=erp.created.at(-1);
  await assert.rejects(service.attachEncounter(user,{data:booking,revision:1},row.name),{status:409});
});
test('invoices require an explicit Patient link; phone alone grants no access',async () => {
  const {service}=setup();await assert.rejects(service.orders(user),{status:409,code:'patient_link_required'});
});
test('a private file owned by another user is rejected before signing',async () => {
  const {service,erp}=setup();await service.identity(user);
  const file=await erp.create('File',{attached_to_doctype:'Mobile App User',attached_to_name:'other',file_url:'s3://private'});
  await assert.rejects(service.file(user,file.name),{status:404});
});
test('treatment retries preserve the original assessment',async () => {
  const {service}=setup();const body={id:booking.id,questionnaireVersion:'v1',answers:{a:'first'}};
  await service.treatment(user,body); const saved=await service.treatment(user,{...body,answers:{a:'second'}});
  assert.equal(saved.data.answers.a,'first');
});
test('client-supplied streaks and rewards are ignored',async () => {
  const {service}=setup();const result=await service.saveHabits(user,{revision:0,data:{habits:[{id:'h'}],dailyCompliance:{},currentStreak:999,rewards:[{couponCode:'FORGED'}]}});
  assert.equal(result.data.currentStreak,0);assert.deepEqual(result.data.rewards,[]);
});
test('API requires authentication and returns safe errors',async t => {
  const {service}=setup(); const server=createApi({service,authenticate:async () => {throw new ApiError(401,'unauthenticated','Please sign in');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status,200);
  const response=await fetch(`${base}/v1/profile`);assert.equal(response.status,401);
  assert.deepEqual(await response.json(),{error:{code:'unauthenticated',message:'Please sign in'}});
});

test('a verified webhook encounter is returned with the ERP meeting link and status',async () => {
  const {erp,service}=setup({webhookUrl:'https://webhook.test'});
  service.fetcher=async () => {
    const enc=await erp.create('Patient Encounter',{doctype:'Patient Encounter',patient:'patient-test',docstatus:0,
      sr_notes:`External appointment ID: ${booking.id}`,custom_appointment_status:'Approved',google_meet_link:'https://meet.google.com/test-link'});
    return Response.json([{data:enc}]);
  };
  const result=await service.createAppointment(user,booking);
  assert.equal(result.bookingSyncPending,false);assert.equal(result.status,'confirmed');
  assert.equal(result.meetingLink,'https://meet.google.com/test-link');
  const second=await service.createAppointment(user,booking);
  assert.equal(second.erpEncounterId,result.erpEncounterId);
  assert.equal(erp.created.filter(row=>row.type==='Patient Encounter').length,1);
});
test('cancellation requests cannot name another account appointment',async () => {
  const {service}=setup({webhookUrl:'https://webhook.test',fetcher:async()=>{throw Error('offline')}});
  await service.createAppointment(user,booking);
  await assert.rejects(service.appointmentChange({...user,id:'other'},booking.id,{action:'cancel',requestId:booking.id}),{status:404});
  const request=await service.appointmentChange(user,booking.id,{action:'cancel',requestId:booking.id});
  assert.equal(request.status,'Pending');
  assert.equal((await service.records.read(user.id,'appointment',booking.id)).data.status,'confirmed');
});
test('profile saves strip attempts to change account, patient, email or permissions',async () => {
  const {service}=setup();
  const result=await service.saveProfile(user,{revision:0,data:{name:'Updated',patient:'other',email:'other@example.invalid',account:'other',role:'System Manager'}});
  assert.deepEqual(result.data,{name:'Updated'});
});
test('invoice reads reject other patients and draft invoices',async () => {
  const {service,erp}=setup();await service.identity(user);
  const identity=await service.records.read(user.id,'identity','self');
  const patient=await erp.create('Patient',{});
  await service.records.write(user.id,'identity','self',{...identity.data,patient:patient.name},identity.revision);
  const other=await erp.create('Sales Invoice',{patient:'another-patient',docstatus:1,items:[]});
  const draft=await erp.create('Sales Invoice',{patient:patient.name,docstatus:0,items:[]});
  await assert.rejects(service.invoice(user,other.name),{status:404});
  await assert.rejects(service.invoice(user,draft.name),{status:404});
});
test('image content is validated before contacting ERP upload',async () => {
  const {service}=setup();
  await assert.rejects(service.upload(user,{mimeType:'image/png',base64:Buffer.from('<script>x</script>').toString('base64')}),{status:400});
});
test('Razorpay verification checks capture, amount, order and customer ownership',async () => {
  const appointment={id:booking.id,consultationFee:1000,paymentOrderId:'order_123'};
  let payment={order_id:'order_123',amount:100000,currency:'INR',status:'captured',amount_refunded:0};
  const gateway=new Razorpay({keyId:'test',keySecret:'test',fetcher:async url=>Response.json(url.includes('/payments/')?payment:{notes:{mobile_account:user.id,appointment_id:booking.id}})});
  assert.equal((await gateway.verify(user,appointment,'pay_123')).status,'captured');
  payment={...payment,amount:1};await assert.rejects(gateway.verify(user,appointment,'pay_123'),{status:409});
  payment={...payment,amount:100000,status:'authorized'};await assert.rejects(gateway.verify(user,appointment,'pay_123'),{status:409});
});
test('paid preparation reserves once and retries return the same order',async () => {
  let created=0;
  const {service,erp}=setup({webhookUrl:'https://webhook.test',payments:{keyId:'test',create:async()=>{created++;return {id:'order_123'}}}});
  service.doctorPolicy.Megha.fee=1000;
  const first=await service.createAppointment(user,booking,true);
  const second=await service.createAppointment(user,booking,true);
  assert.equal(first.orderId,second.orderId);assert.equal(created,1);
  assert.equal(erp.created.filter(row=>row.type==='Mobile App Appointment').length,1);
});

test('a daily streak does not require using weekly products every day',()=>{
  assert.equal(isPerfectDay({completedHabits:{hair_growth_serum:true}},['hair_growth_serum','hair_shampoo']),true);
  assert.equal(isPerfectDay({completedHabits:{psoria_oil:true}},['psoria_oil']),false);
  assert.equal(isPerfectDay({completedHabitTimes:{psoria_oil_morning:true,psoria_oil_evening:true}},['psoria_oil']),true);
});

test('HTTP booking writes stay disabled until deployment is explicitly enabled',async t=>{
  const {service}=setup();
  const server=createApi({service,authenticate:async()=>user});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/appointment-orders`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(booking)});
  assert.equal(response.status,503);assert.equal((await response.json()).error.code,'booking_setup_required');
});

test('ERP avatar changes and removal override stale app photo references', async () => {
  const {service,erp}=setup();const identity=await service.identity(user);
  await service.records.write(user.id,'profile','self',{name:user.name,imageFileId:'stale-file'},0);
  const first=await erp.create('File',{attached_to_doctype:'Mobile App User',attached_to_name:identity.erpUser,file_url:'s3://bucket/first.jpg'});
  await erp.update('Mobile App User',identity.erpUser,{image:first.file_url});
  assert.equal((await service.profile(user)).data.imageFileId,first.name);
  const second=await erp.create('File',{attached_to_doctype:'Mobile App User',attached_to_name:identity.erpUser,file_url:'s3://bucket/second.jpg'});
  await erp.update('Mobile App User',identity.erpUser,{image:second.file_url});
  assert.equal((await service.profile(user)).data.imageFileId,second.name);
  await erp.update('Mobile App User',identity.erpUser,{image:''});
  const cleared=await service.profile(user);
  assert.equal(cleared.data.imageFileId,null);assert.equal(cleared.data.imageSyncPending,false);
});

test('an ERP avatar cannot expose an attachment owned by another account', async () => {
  const {service,erp}=setup();const identity=await service.identity(user);
  const file=await erp.create('File',{attached_to_doctype:'Mobile App User',attached_to_name:'another',file_url:'s3://bucket/private.jpg'});
  await erp.update('Mobile App User',identity.erpUser,{image:file.file_url});
  const profile=await service.profile(user);
  assert.equal(profile.data.imageFileId,null);assert.equal(profile.data.imageSyncPending,true);
});

async function fakeUpload(service,erp,{storage='s3://bucket/upload.jpg',duringUpload}={}) {
  const identity=await service.identity(user);
  erp.request=async (_,request)=>{
    assert.equal(request.body.get('docname'),identity.erpUser);
    assert.equal(request.body.get('is_private'),'1');
    const file=await erp.create('File',{attached_to_doctype:'Mobile App User',attached_to_name:identity.erpUser,file_url:storage});
    await duringUpload?.();
    return {name:file.name,file_url:'/stale-upload-response.jpg'};
  };
  return identity;
}
const photo={mimeType:'image/jpeg',base64:Buffer.from([255,216,255,1]).toString('base64')};

test('app photo uploads update the ERP Desk image from the saved S3 File',async()=>{
  const {service,erp}=setup();const identity=await fakeUpload(service,erp);
  const result=await service.upload(user,photo);
  const image = new URL((await erp.get('Mobile App User',identity.erpUser)).image, erp.url);
  assert.equal(image.pathname,'/api/method/frappe.handler.download_file');
  assert.equal(image.searchParams.get('file_url'),'s3://bucket/upload.jpg');
  assert.equal((await service.profile(user)).data.imageFileId,result.fileId);
});

test('treatment attachments do not replace the profile photo',async()=>{
  const {service,erp}=setup();const identity=await fakeUpload(service,erp);
  await erp.update('Mobile App User',identity.erpUser,{image:'s3://bucket/original.jpg'});
  await service.upload(user,{...photo,purpose:'treatment'});
  assert.equal((await erp.get('Mobile App User',identity.erpUser)).image,'s3://bucket/original.jpg');
});

test('failed S3 migration preserves the current ERP photo',async()=>{
  const {service,erp}=setup();const identity=await fakeUpload(service,erp,{storage:'/private/files/pending.jpg'});
  await erp.update('Mobile App User',identity.erpUser,{image:'s3://bucket/original.jpg'});
  await assert.rejects(service.upload(user,photo),{code:'s3_required'});
  assert.equal((await erp.get('Mobile App User',identity.erpUser)).image,'s3://bucket/original.jpg');
});

test('a profile edited during upload is not silently overwritten',async()=>{
  const {service,erp}=setup();const identity=await fakeUpload(service,erp);
  await erp.update('Mobile App User',identity.erpUser,{modified:'before'});
  const update=erp.update.bind(erp);
  erp.update=async(type,name,fields)=>{
    if(type==='Mobile App User' && fields.image){assert.equal(fields.modified,'before');throw new ApiError(409,'revision_conflict','Changed');}
    return update(type,name,fields);
  };
  await assert.rejects(service.upload(user,photo),{status:409});
});

test('private photo signing uses the installed ERP app and preserves signed URLs',async()=>{
  const {service,erp}=setup();const identity=await service.identity(user);
  const file=await erp.create('File',{attached_to_doctype:'Mobile App User',attached_to_name:identity.erpUser,file_url:'s3://bucket/image.jpg'});
  erp.method=async(method,args)=>{
    assert.equal(method,'sriaas_clinic.api.s3.presign.get_presigned_url');
    assert.equal(args.file_url,file.file_url);assert.equal(args.expires,300);
    return 'https://storage.test/image.jpg?signature=keep-exactly';
  };
  assert.deepEqual(await service.file(user,file.name),{url:'https://storage.test/image.jpg?signature=keep-exactly',expiresIn:300});
});

test('a committed upload with a lost response is reconciled without another POST',async()=>{
  const {service,erp}=setup();const identity=await service.identity(user);let posts=0;
  erp.request=async (_,request)=>{
    posts++;
    await erp.create('File',{file_name:request.body.get('file').name,attached_to_doctype:'Mobile App User',attached_to_name:identity.erpUser,file_url:'s3://bucket/committed.jpg'});
    throw new DOMException('Timed out','TimeoutError');
  };
  const uploaded=await service.upload(user,photo);
  assert.equal(posts,1);
  assert.equal((await service.profile(user)).data.imageFileId,uploaded.fileId);
});
