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
  constructor() { this.docs = new Map([['Healthcare Practitioner/Megha',{name:'Megha',practitioner_name:'Megha',status:'Active',op_consulting_charge:0,custom_accept_online_appointments:0}]]); this.created = []; this.url = 'https://erp.test'; this.calendar = new Map(); this.cancelCalls = []; }
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
      Object.entries(filters || {}).every(([key,value]) => Array.isArray(value) ? value[0] === 'in' ? value[1].includes(doc[key]) : value[0] === 'like' ? String(doc[key] || '').includes(value[1].replace(/^%|%$/g,'')) : true : doc[key] === value));
  }
  async method(name,args,write) {
    if (name.endsWith('.get_appointment')) {
      const doc=await this.get(args.doctype,args.name);
      const status=doc.status==='Cancelled' ? 'Cancelled' : this.calendar.get(`${args.doctype}/${args.name}`) ||
        (args.doctype==='Patient Encounter' ? doc.custom_appointment_status : 'Pending');
      return {name:args.name,source_doctype:args.doctype,status,actions:['Pending','Approved'].includes(status)?['cancel']:[]};
    }
    if (name.endsWith('.update_appointment')) {
      assert.equal(write,true);assert.equal(args.action,'cancel');assert.ok(args.reason);
      const before=await this.method('test.get_appointment',args);
      if (before.status!==args.expected_status) throw new ApiError(409,'revision_conflict','Changed');
      assert.ok(before.actions.includes('cancel'));
      this.cancelCalls.push({...args});this.calendar.set(`${args.doctype}/${args.name}`,'Cancelled');
      if(args.doctype==='Patient Encounter') {
        const enc=await this.update(args.doctype,args.name,{custom_appointment_status:'Cancelled'});
        if(enc.encounter_reference) await this.update('Clinic Appointment',enc.encounter_reference,{appointment_status:'Cancelled'});
      }
      return this.method('test.get_appointment',args);
    }
    if (name.endsWith('.availability')) return {slots:[{time:'10:00:00',duration:10,remaining:1,schedule_id:'schedule'}],timezone:'Asia/Kolkata'};
    if (name.endsWith('.list_doctors')) return {doctors:[...this.docs.entries()].filter(([k,d])=>k.startsWith('Healthcare Practitioner/') && d.status==='Active').map(([,d])=>({id:d.name,schedules:[{days:['Monday','Saturday']}]})),timezone:'Asia/Kolkata'};
  }
}
const user = {id:'gid://shopify/Customer/1',name:'Test Account',email:'test@example.invalid',phone:'+919999999999'};
const booking = {id:'11111111-1111-1111-1111-111111111111',doctorId:'Megha',appointmentDate:'2026-10-05',time:'10:00:00',timeSlot:'10:00 AM',consultationType:'opd',patientName:'Test Patient',patientGender:'Female'};
const setup = options => { const erp = new FakeErp(); return {erp,service:new MobileService({erp,...options})}; };

test('new bookings require a selected gender before ERP writes or payment preparation',async()=>{
  for(const patientGender of [undefined,'','unknown','male',123]) {
    const {service,erp}=setup({webhookUrl:'https://webhook.test'});
    await assert.rejects(service.createAppointment(user,{...booking,patientGender}),{code:'patient_gender_required'});
    await assert.rejects(service.createAppointment(user,{...booking,patientGender},true),{code:'patient_gender_required'});
    assert.equal(erp.created.length,0);
  }
});

test('selected gender and configured department reach ERP storage and the n8n patient payload',async()=>{
  let payload;
  const {service,erp}=setup({webhookUrl:'https://webhook.test',fetcher:async(_,request)=>{
    payload=JSON.parse(request.body);return Response.json({});
  }});
  const result=await service.createAppointment(user,{...booking,department:'untrusted'});
  assert.equal(result.patientGender,'Female');assert.equal(result.department,'Skin/Fertility/Liver/IBS');
  assert.equal(payload.patient.sex,'Female');assert.equal(payload.department,result.department);
  const saved=await service.records.read(user.id,'appointment',booking.id);
  assert.equal(saved.data.patientGender,'Female');
  const reservation=await erp.get('Mobile App Appointment',result.reservation);
  assert.equal(JSON.parse(reservation.payload_json).patientGender,'Female');
  await assert.rejects(service.createAppointment(user,{...booking,patientGender:'Male'}),{code:'idempotency_conflict'});
});

test('older unsent payment reservations require gender and reuse the existing payment order',async()=>{
  let orders=0;
  const {service}=setup({webhookUrl:'https://webhook.test',payments:{keyId:'test',create:async()=>{orders++;return {id:'order_existing'};}}});
  await service.erp.update('Healthcare Practitioner','Megha',{op_consulting_charge:1000});
  await service.createAppointment(user,booking,true);
  const record=await service.records.read(user.id,'appointment',booking.id);
  const {patientGender,...legacy}=record.data;
  await service.records.write(user.id,'appointment',booking.id,legacy,record.revision);
  await assert.rejects(service.createAppointment(user,{...booking,patientGender:undefined},true),{code:'patient_gender_required'});
  const order=await service.createAppointment(user,booking,true);
  assert.equal(order.orderId,'order_existing');assert.equal(orders,1);
  assert.equal((await service.records.read(user.id,'appointment',booking.id)).data.patientGender,'Female');
});

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
  await service.erp.update('Healthcare Practitioner','Megha',{op_consulting_charge:1000});
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
    doctype:'Patient Encounter',sr_encounter_type:'Appointment',pe_practitioner:'Megha',patient:'test-patient',docstatus:0,sr_notes:`External appointment ID: ${booking.id}`,custom_appointment_status:'Pending'})});
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
      doctype:'Patient Encounter',sr_encounter_type:'Appointment',pe_practitioner:'Megha',patient:'test-patient',docstatus:0,sr_notes:`External appointment ID: ${booking.id}`,custom_appointment_status:'Pending'})});
  };
  assert.equal((await service.createAppointment(user,booking)).status,'cancelled');
});
test('forged free price cannot bypass the backend doctor fee',async () => {
  const {service}=setup();await service.erp.update('Healthcare Practitioner','Megha',{op_consulting_charge:1000});
  await assert.rejects(service.createAppointment(user,{...booking,consultationFee:0,paymentStatus:'free'}),{code:'doctor_fee_changed'});
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
test('cancellation verifies ownership and cancels the ERP reservation',async () => {
  const {service}=setup({webhookUrl:'https://webhook.test',fetcher:async()=>{throw Error('offline')}});
  await service.createAppointment(user,booking);
  await assert.rejects(service.appointmentChange({...user,id:'other'},booking.id,{action:'cancel',requestId:booking.id}),{status:404});
  const request=await service.appointmentChange(user,booking.id,{action:'cancel',requestId:booking.id});
  assert.equal(request.status,'Completed');assert.equal(request.appointment.status,'cancelled');
  assert.equal((await service.records.read(user.id,'appointment',booking.id)).data.status,'cancelled');
});

async function bookingWithClinic() {
  const {erp,service}=setup({webhookUrl:'https://webhook.test'});
  service.fetcher=async()=>{
    let enc=await erp.create('Patient Encounter',{doctype:'Patient Encounter',sr_encounter_type:'Appointment',
      pe_practitioner:booking.doctorId,patient:'patient-test',docstatus:0,custom_appointment_status:'Pending',
      sr_notes:`External appointment ID: ${booking.id}`});
    const clinic=await erp.create('Clinic Appointment',{encounter_reference:enc.name,appointment_status:'Confirmed'});
    enc=await erp.update('Patient Encounter',enc.name,{encounter_reference:clinic.name});
    return Response.json({data:enc});
  };
  const appointment=await service.createAppointment(user,booking);
  return {erp,service,appointment};
}

test('cancellation updates encounter, clinic, reservation and history, with safe retries',async()=>{
  const {erp,service,appointment}=await bookingWithClinic();
  const body={action:'cancel',requestId:'cancel-test'};
  const result=await service.appointmentChange(user,booking.id,body);
  assert.equal(result.status,'Completed');assert.equal(result.appointment.bookingSyncPending,false);
  assert.equal((await erp.get('Mobile App Appointment',appointment.reservation)).status,'Cancelled');
  assert.equal((await erp.get('Patient Encounter',appointment.erpEncounterId)).custom_appointment_status,'Cancelled');
  assert.equal((await erp.get('Clinic Appointment',appointment.erpAppointmentReference)).appointment_status,'Cancelled');
  assert.equal((await service.appointments(user)).items[0].status,'cancelled');
  const calls=erp.cancelCalls.length;
  await service.appointmentChange(user,booking.id,body);
  await service.appointmentChange(user,booking.id,{...body,requestId:'another-retry'});
  assert.equal(erp.cancelCalls.length,calls);
  assert.equal(erp.created.filter(d=>d.type==='Patient Encounter').length,1);
});

test('cancellation cannot reuse a request for another action or change an unrelated encounter',async()=>{
  const {erp,service,appointment}=await bookingWithClinic();
  await service.appointmentChange(user,booking.id,{action:'reschedule',requestId:'same-request'});
  await assert.rejects(service.appointmentChange(user,booking.id,{action:'cancel',requestId:'same-request'}),{code:'idempotency_conflict'});
  await erp.update('Patient Encounter',appointment.erpEncounterId,{sr_notes:`External appointment ID: ${booking.id}-another`});
  await assert.rejects(service.appointmentChange(user,booking.id,{action:'cancel',requestId:'new-request'}),{code:'unverified_encounter'});
  assert.equal(erp.cancelCalls.length,0);
});

test('checked-in appointments and ERP failures never produce a completed cancellation',async()=>{
  const {erp,service,appointment}=await bookingWithClinic();
  await erp.update('Patient Encounter',appointment.erpEncounterId,{custom_appointment_status:'Checked In'});
  await assert.rejects(service.appointmentChange(user,booking.id,{action:'cancel',requestId:'cannot-cancel'}),{code:'cancellation_not_allowed'});
  assert.equal((await erp.get('Mobile App Appointment',appointment.reservation)).status,'Confirmed');
  assert.equal(erp.cancelCalls.length,0);
  await erp.update('Patient Encounter',appointment.erpEncounterId,{custom_appointment_status:'Pending'});
  const method=erp.method.bind(erp);
  erp.method=async(name,...args)=>{
    if(name.endsWith('.update_appointment'))throw new ApiError(502,'erp_request_failed','Unavailable');
    return method(name,...args);
  };
  await assert.rejects(service.appointmentChange(user,booking.id,{action:'cancel',requestId:'failed-cancel'}),{status:502});
  assert.equal((await service.records.read(user.id,'appointment',booking.id)).data.status,'confirmed');
  assert.equal((await service.records.read(user.id,'appointment_request','failed-cancel')).data.status,'Processing');
});

test('partial ERP cancellation resumes without repeating a completed clinic transition',async()=>{
  const {erp,service,appointment}=await bookingWithClinic();
  const update=erp.update.bind(erp);
  erp.update=async(type,name,fields)=>{
    if(type==='Mobile App Appointment' && fields.status==='Cancelled') throw new ApiError(502,'erp_request_failed','Unavailable');
    return update(type,name,fields);
  };
  const body={action:'cancel',requestId:'retry-partial'};
  await assert.rejects(service.appointmentChange(user,booking.id,body),{status:502});
  assert.equal((await erp.get('Patient Encounter',appointment.erpEncounterId)).custom_appointment_status,'Cancelled');
  erp.update=update;
  const result=await service.appointmentChange(user,booking.id,body);
  assert.equal(result.appointment.status,'cancelled');
  assert.equal(erp.cancelCalls.filter(c=>c.doctype==='Patient Encounter').length,1);
});

test('a successful HTTP response without a saved ERP cancellation is rejected',async()=>{
  const {erp,service,appointment}=await bookingWithClinic();
  const method=erp.method.bind(erp);
  erp.method=async(name,...args)=> name.endsWith('.update_appointment')
    ? {status:'Cancelled'} : method(name,...args);
  await assert.rejects(service.appointmentChange(user,booking.id,
    {action:'cancel',requestId:'unverified-cancel'}),{code:'cancellation_unverified'});
  assert.equal((await erp.get('Mobile App Appointment',appointment.reservation)).status,'Confirmed');
  assert.equal((await service.records.read(user.id,'appointment',booking.id)).data.status,'confirmed');
});

test('an encounter arriving after cancellation is cancelled during reconciliation',async()=>{
  const {erp,service}=setup({webhookUrl:'https://webhook.test',fetcher:async()=>{throw Error('timeout');}});
  await service.createAppointment(user,booking);
  await service.appointmentChange(user,booking.id,{action:'cancel',requestId:'cancel-before-encounter'});
  const enc=await erp.create('Patient Encounter',{doctype:'Patient Encounter',sr_encounter_type:'Appointment',
    pe_practitioner:booking.doctorId,patient:'patient-test',docstatus:0,custom_appointment_status:'Pending',
    sr_notes:`External appointment ID: ${booking.id}`});
  const history=await service.appointments(user);
  assert.equal(history.items[0].status,'cancelled');
  assert.equal(history.items[0].erpEncounterId,enc.name);
  assert.equal((await erp.get('Patient Encounter',enc.name)).custom_appointment_status,'Cancelled');
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
  await service.erp.update('Healthcare Practitioner','Megha',{op_consulting_charge:1000});
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


test('ERP controls practitioner details, diseases, charges and online eligibility without an app allowlist',async()=>{
  const {erp,service}=setup();
  await erp.update('Healthcare Practitioner','Megha',{practitioner_name:'Updated ERP name',sr_qualification:'BHMS',
    sr_diseases:[{disease:'Skin Allergy'},{disease:'Fatty Liver Disease'}],op_consulting_charge:1000.50,
    custom_about_doctor:'Updated biography',custom_accept_online_appointments:0,image:'/files/doctor.jpg',modified:'v1'});
  let doctor=(await service.doctors()).doctors[0];
  assert.equal(doctor.name,'Updated ERP name');assert.equal(doctor.qualification,'BHMS');
  assert.deepEqual(doctor.expertise,['Skin Allergy','Fatty Liver Disease']);
  assert.equal(doctor.about,'Updated biography');assert.equal(doctor.consultationFee,1000.5);
  assert.equal(doctor.isFreeConsultation,false);assert.equal(doctor.availableConsultationType,'opd');
  assert.deepEqual(doctor.availableDays,['Mon','Sat']);assert.match(doctor.imageUrl,/photo\?v=v1$/);
  await erp.update('Healthcare Practitioner','Megha',{custom_accept_online_appointments:1,image:'',op_consulting_charge:0});
  doctor=(await service.doctors()).doctors[0];
  assert.equal(doctor.availableConsultationType,'all');assert.equal(doctor.imageUrl,'');assert.equal(doctor.isFreeConsultation,true);
  const extra=await erp.create('Healthcare Practitioner',{practitioner_name:'New doctor',status:'Active',op_consulting_charge:250});
  assert.ok((await service.doctors()).doctors.some(d=>d.id===extra.name));
  await erp.update('Healthcare Practitioner','Megha',{status:'Inactive'});
  assert.ok(!(await service.doctors()).doctors.some(d=>d.id==='Megha'));
  await assert.rejects(service.availability('Megha',booking.appointmentDate),{status:404});
});

test('online opt-out blocks video and audio before reservations; opt-in allows video',async()=>{
  const {erp,service}=setup({webhookUrl:'https://webhook.test',fetcher:async()=>Response.json({})});
  for(const consultationType of ['video','audio']) {
    await assert.rejects(service.createAppointment(user,{...booking,consultationType}),{status:400});
  }
  assert.equal(erp.created.length,0);
  await erp.update('Healthcare Practitioner','Megha',{custom_accept_online_appointments:1});
  const saved=await service.createAppointment(user,{...booking,consultationType:'video'});
  assert.equal(saved.consultationType,'video');
});

test('missing or invalid ERP charges never become free appointments',async()=>{
  for(const fee of [null,undefined,'','invalid',-1]) {
    const {erp,service}=setup();
    await erp.update('Healthcare Practitioner','Megha',{op_consulting_charge:fee});
    await assert.rejects(service.createAppointment(user,booking),{code:'doctor_fee_unavailable'});
    assert.equal(erp.created.length,0);
  }
});

test('current ERP fee wins over a stale client quote and supports fractional rupees',async()=>{
  let charge;
  const {erp,service}=setup({webhookUrl:'https://webhook.test',payments:{keyId:'test',create:async(_,a)=>{charge=a.consultationFee;return {id:'test-order'};}}});
  await erp.update('Healthcare Practitioner','Megha',{op_consulting_charge:1000.5});
  await assert.rejects(service.createAppointment(user,{...booking,consultationFee:0},true),{code:'doctor_fee_changed'});
  assert.equal(erp.created.length,0);
  const prepared=await service.createAppointment(user,{...booking,consultationFee:1000.5},true);
  assert.equal(charge,1000.5);assert.equal(prepared.amount,1000.5);
});

test('doctor photos serve only the selected practitioner attachment and reject non-image content',async()=>{
  const {erp,service}=setup();
  await erp.update('Healthcare Practitioner','Megha',{image:'/files/doctor.jpg'});
  await erp.create('File',{attached_to_doctype:'Mobile App User',attached_to_name:'other',file_url:'/files/doctor.jpg'});
  await assert.rejects(service.doctorPhoto('Megha'),{status:404});
  await erp.create('File',{attached_to_doctype:'Healthcare Practitioner',attached_to_name:'Megha',file_url:'/files/doctor.jpg'});
  let contentType='image/jpeg';
  erp.request=async(path,options)=>{
    assert.equal(options.raw,true);assert.match(path,/download_file/);
    return new Response(new Uint8Array([255,216,255]),{headers:{'Content-Type':contentType}});
  };
  assert.equal((await service.doctorPhoto('Megha')).headers.get('content-type'),'image/jpeg');
  contentType='text/html';
  await assert.rejects(service.doctorPhoto('Megha'),{status:404});
  await erp.update('Healthcare Practitioner','Megha',{image:''});
  await assert.rejects(service.doctorPhoto('Megha'),{status:404});
});
