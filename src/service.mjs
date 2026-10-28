import {trackedInvoices} from './purchase-invoices.mjs';
import {AiChat} from './ai-chat.mjs';
import {SupportTickets} from './support-tickets.mjs';
import {randomUUID} from 'node:crypto';
import {ApiError, object, requireValue, text} from './errors.mjs';
import {Records, SerialQueue, recordName} from './store.mjs';
import {isPerfectDay} from './habits.mjs';
import {orderDetails, trackingSummary} from './order-details.mjs';
import {patientDiets, dietPdf} from './diets.mjs';
import {Assessments, assessmentApp} from './assessments.mjs';
import {habitOrders, habitPrescriptions} from './invoice-habits.mjs';
import {invoiceKit} from './invoice-kit.mjs';
import {getErpHabitTracker,saveErpHabitTracker} from './erp-habit-tracker.mjs';
import {prepareAppointmentMeet} from './appointment-meet.mjs';
import {recoverPatientLink} from './patient-link.mjs';
import {CheckoutTracking} from './checkout-tracking.mjs';

// Only ERP-hosted public images are exposed directly. Private/S3 treatment
// attachments keep their existing signed-download path.
const publicImageUrl = (erp, file) => {
  if (Number(file.is_private) !== 0 || typeof file.file_url !== 'string') return null;
  try {
    const path = decodeURIComponent(file.file_url);
    if (!/^\/files\/[^/\\?#\x00-\x1f]+\.(jpe?g|png|webp)$/i.test(path)) return null;
    const url = new URL(file.file_url, erp.url);
    return url.origin === new URL(erp.url).origin ? url.href : null;
  } catch { return null; }
};

const day = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
const statuses = {Pending: 'pending', Approved: 'confirmed', Confirmed: 'confirmed', 'Checked In': 'checked_in', Completed: 'completed', Cancelled: 'cancelled'};
export const appointmentStatus = value => statuses[value] || 'pending';
const cleanProfile = data => Object.fromEntries(['name','gender','dateOfBirth','height','weight'].filter(k => data[k] != null).map(k => [k, text(String(data[k]), 150)]));
const patientGenders = new Set(['Male','Female','Other','Prefer not to say','Non-Conforming','Genderqueer','Transgender']);
const appointmentDepartment = 'Skin/Fertility/Liver/IBS';
const appointmentMeetLink = (data, value) => {
  if (data.consultationType !== 'video' || data.status === 'cancelled' || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'meet.google.com' && !url.username && !url.password && !url.port
      ? url.href : null;
  } catch { return null; }
};
const appDoctorTags = new Map([['siya-ayurveda', 'Siya Ayurveda'], ['seedfit', 'Seedfit']]);
const doctorTag = appId => {
  requireValue(appDoctorTags.has(appId), 'Unknown app ID',400,'invalid_app');
  return appDoctorTags.get(appId);
};

export class MobileService {
  constructor({erp, webhookUrl, webhookSecret, fetcher = fetch, rewardIssuer, payments, meetings, productImage = async () => '', productCatalog, chatProducts, checkoutTracking, appId = 'siya-ayurveda',
    s3PresignMethod = 'sriaas_clinic.api.s3.presign.get_presigned_url'}) {
    Object.assign(this, {erp, webhookUrl, webhookSecret, fetcher, rewardIssuer, payments, meetings, productImage, productCatalog, chatProducts, s3PresignMethod});
    this.appId = appId;
    this.records = new Records(erp, appId === 'siya-ayurveda' ? '' : appId); this.queue = new SerialQueue();
    this.checkoutTracking = new CheckoutTracking(this,checkoutTracking);
    this.assessments = new Assessments(erp);
    this.support = new SupportTickets(this);
    this.aiChat = new AiChat(this);
  }
  async identity(user) {
    const externalId = this.appId === 'siya-ayurveda' ? user.id : `${this.appId}:${user.id}`;
    const ids = this.appId === 'siya-ayurveda' ? [user.id, user.id.split('/').at(-1)] : [externalId];
    let record = await this.records.read(user.id, 'identity', 'self');
    if (record) {
      // The cached record locates the account; current ERP profiles authorize
      // patient access on every platform, including later linking/unlinking.
      let parent = await this.erp.get('Mobile App User',record.data.erpUser);
      requireValue(ids.includes(parent.external_id),
        'Your account needs to be linked by the clinic',409,'identity_link_required');
      const previousParent = parent;
      parent = await recoverPatientLink(this.erp,user,parent,record.data,this.appId);
      requireValue(ids.includes(parent.external_id),
        'Your account needs to be linked by the clinic',409,'identity_link_required');
      const patients = [...new Set((parent.profiles || []).map(p=>p.patient_id).filter(Boolean))];
      const patient = patients.length === 1 ? patients[0] : null;
      if (parent !== previousParent && patient && !record.data.patient) {
        await this.records.write(user.id,'identity','self',{erpUser:parent.name,patient},record.revision);
      }
      // Preserve separately reviewed billing access only while its patient link
      // is still current; changing the profile must not inherit that grant.
      return {erpUser:parent.name,patient,
        ...(this.appId === 'siya-ayurveda' && patient && record.data.patient === patient && Array.isArray(record.data.customers)
          ? {customers:record.data.customers} : {})};
    }
    // Only stable, verified external IDs may attach an existing ERP account.
    // Keep existing Siya identities unchanged. Other stores have their own ERP identity.
    let matches = await this.erp.list('Mobile App User', {external_id: ['in', ids]}, ['name'], {limit: 2});
    requireValue(matches.length < 2, 'Your account needs to be linked by the clinic', 409, 'identity_link_required');
    let parent = matches.length ? await this.erp.get('Mobile App User', matches[0].name) :
      await this.erp.create('Mobile App User', {external_id: externalId, full_name: user.name, phone: user.phone, is_active: 1});
    parent = await recoverPatientLink(this.erp,user,parent,null,this.appId);
    requireValue(ids.includes(parent.external_id),
      'Your account needs to be linked by the clinic',409,'identity_link_required');
    const patients = [...new Set((parent.profiles || []).map(p => p.patient_id).filter(Boolean))];
    const data = {erpUser: parent.name, patient: patients.length === 1 ? patients[0] : null};
    await this.records.write(user.id, 'identity', 'self', data, 0);
    return data;
  }
  async profile(user) {
    const identity = await this.identity(user);
    const record = await this.records.read(user.id, 'profile', 'self');
    const parent = await this.erp.get('Mobile App User', identity.erpUser);
    // The Desk avatar and app avatar share this field, including image removal.
    // Never let a stale app record override a photo changed by clinic staff.
    let imageReference = parent.image;
    if (imageReference) {
      try {
        const uri = new URL(imageReference, this.erp.url);
        if (uri.origin === new URL(this.erp.url).origin && uri.pathname === '/api/method/frappe.handler.download_file') {
          imageReference = uri.searchParams.get('file_url');
        }
      } catch { imageReference = null; }
    }
    const files = imageReference ? await this.erp.list('File', {
      attached_to_doctype: 'Mobile App User', attached_to_name: identity.erpUser,
      file_url: imageReference,
    }, ['name','file_url','is_private'], {limit: 1}) : [];
    const image = files.find(file => file.file_url?.startsWith('s3://') || publicImageUrl(this.erp,file));
    return {data: {...(record?.data || {}), name: parent.full_name || user.name,
      imageFileId: image?.name || null, imageSyncPending: Boolean(parent.image && !image),
      email: user.email, phone: user.phone,
      patientLinked: Boolean(identity.patient)}, revision: record?.revision || 0};
  }
  async saveProfile(user, body) {
    object(body); const fields = cleanProfile(object(body.data));
    requireValue(fields.name?.length, 'Please enter your name');
    const old = await this.records.read(user.id, 'profile', 'self');
    const saved = await this.records.write(user.id, 'profile', 'self', {...old?.data, ...fields}, body.revision);
    const identity = await this.identity(user);
    await this.erp.update('Mobile App User', identity.erpUser, {full_name: fields.name});
    return saved;
  }
  async doctorDetails(row, appId = 'siya-ayurveda') {
    const tag = doctorTag(appId);
    const doc = await this.erp.get('Healthcare Practitioner', row.id);
    if (doc.status !== 'Active' || !(doc.sr_diseases || []).some(d => d.disease === tag)) return null;
    const qualification = doc.sr_qualification || '';
    const opd = Number(doc.custom_accept_opd_appointments ?? 1) === 1;
    const online = Number(doc.custom_accept_online_appointments) === 1;
    const charge = (value, enabled) => {
      if (!enabled) return null;
      requireValue(value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0,
        'The clinic needs to configure this doctor\'s consultation charge.',503,'doctor_fee_unavailable');
      return Math.round(Number(value)*100)/100;
    };
    const opdFee = charge(doc.op_consulting_charge, opd);
    const onlineFee = charge(doc.custom_online_consulting_charge, online);
    const fee = opd ? opdFee : onlineFee;
    return {id:doc.name, name:doc.practitioner_name || doc.name,
      specialization:qualification || doc.department || '', qualification,
      imageUrl:doc.image ? `/v1/doctors/${encodeURIComponent(doc.name)}/photo?app=${encodeURIComponent(appId)}&v=${encodeURIComponent(doc.modified || doc.image)}` : '',
      consultationFee:fee, isFreeConsultation:fee === 0,
      consultationFees:{opd:opdFee,video:onlineFee,audio:onlineFee},
      about:doc.custom_about_doctor || '', isAvailable:opd || online,
      acceptsOpdAppointments:opd, acceptsOnlineAppointments:online,
      availableDays:[...new Set((row.schedules || []).flatMap(s=>s.days))].map(v=>v.slice(0,3)),
      nextAvailableSlot:'', expertise:(doc.sr_diseases || []).map(d=>d.disease).filter(d=>d && ![...appDoctorTags.values()].includes(d)),
      tags:(doc.sr_diseases || []).map(d=>d.disease?.toLowerCase()).filter(d=>['male','female'].includes(d)),
      availableConsultationType:opd ? (online ? 'all' : 'opd') : (online ? 'online' : 'none')};
  }
  async doctors(appId = 'siya-ayurveda') {
    doctorTag(appId);
    const response = await this.erp.method('mobile_app.api.practitioners.list_doctors');
    return {doctors:(await Promise.all(response.doctors.map(d=>this.doctorDetails(d,appId)))).filter(Boolean),timezone:response.timezone,appId};
  }
  async bookableDoctor(id, appId = 'siya-ayurveda') {
    doctorTag(appId);
    const response = await this.erp.method('mobile_app.api.practitioners.list_doctors');
    const row = response.doctors.find(d=>d.id === id);
    requireValue(row, 'Doctor not available',404);
    const doctor = await this.doctorDetails(row,appId);
    requireValue(doctor, 'Doctor not available',404);
    return doctor;
  }
  async doctorPhoto(id, appId = 'siya-ayurveda') {
    await this.bookableDoctor(id,appId);
    const doc = await this.erp.get('Healthcare Practitioner',id);
    let reference = doc.image;
    requireValue(reference, 'Doctor photo not available',404);
    try {
      const uri = new URL(reference,this.erp.url);
      if (uri.origin === new URL(this.erp.url).origin && uri.pathname === '/api/method/frappe.handler.download_file') {
        reference = uri.searchParams.get('file_url');
      }
    } catch { throw new ApiError(404,'not_found','Doctor photo not available'); }
    // Publish only the practitioner's selected, attached photo, never arbitrary ERP files.
    const files = await this.erp.list('File',{attached_to_doctype:'Healthcare Practitioner',attached_to_name:id,
      file_url:reference},['name','file_url'],{limit:1});
    requireValue(files.length === 1, 'Doctor photo not available',404);
    const response = await this.erp.request(`/api/method/frappe.handler.download_file?${new URLSearchParams({file_url:reference})}`,{raw:true});
    requireValue(['image/jpeg','image/png','image/webp','image/gif'].includes(response.headers.get('content-type')?.split(';')[0]),
      'Doctor photo not available',404);
    return response;
  }
  async reviewAvatars() {
    const assets=await this.records.read('system','review_assets','indian-illustrations');
    const result={};
    if (!assets) return result;
    for (const gender of ['man','woman']) {
      const id=assets.data[gender];if (!id) continue;
      const file=await this.erp.get('File',id);
      requireValue(file.attached_to_doctype==='Siya Mobile Record' && file.attached_to_name===this.records.key('system','review_assets','indian-illustrations')
        && !file.is_private,'Review image not available',404);
      const signed=await this.erp.method(this.s3PresignMethod,{file_url:file.file_url,expires:900});
      const url=typeof signed==='string'?signed:signed?.url;
      if (url?.startsWith('https://')) result[gender]=url;
    }
    return result;
  }
  async availability(doctor, date, exclude, appId = 'siya-ayurveda') {
    const profile = await this.bookableDoctor(doctor,appId);
    requireValue(/^\d{4}-\d{2}-\d{2}$/.test(date), 'Invalid date');
    const result = await this.erp.method('mobile_app.api.practitioners.availability', {practitioner_id: doctor, date,
      ...(exclude ? {exclude_booking_id: exclude} : {})});
    // Include legacy/direct clinic bookings omitted by the existing mobile availability API.
    const clinic = await this.erp.list('Clinic Appointment', {practitioner: doctor, appointment_date: date,
      appointment_status: ['not in', ['Cancelled','No Show']]}, ['appointment_time'], {limit: 1000});
    return {...result, slots: !profile.isAvailable ? [] : result.slots.filter(s => !clinic.some(b => String(b.appointment_time).slice(0,5) === s.time.slice(0,5)))};
  }
  async createAppointment(user, body, prepare = false, appId = 'siya-ayurveda') {
    doctorTag(appId);
    object(body); const id = text(body.id, 100);
    requireValue(/^[a-zA-Z0-9-]{16,100}$/.test(id), 'A stable booking ID is required');
    let existing = await this.records.read(user.id, 'appointment', id);
    if (existing) {
      requireValue((existing.data.appId || 'siya-ayurveda')===appId && existing.data.doctorId===body.doctorId && existing.data.appointmentDate===String(body.appointmentDate).slice(0,10)
        && existing.data.time===body.time && existing.data.consultationType===body.consultationType && existing.data.patientName===body.patientName
        && (!existing.data.patientGender || existing.data.patientGender===body.patientGender),
        'This booking ID already belongs to another appointment. Start a new booking.',409,'idempotency_conflict');
      if (existing.data.deliveryState === 'not_sent' && !existing.data.patientGender) {
        requireValue(patientGenders.has(body.patientGender), 'Please select the patient gender before booking.',400,'patient_gender_required');
        existing = await this.records.write(user.id,'appointment',id,{...existing.data,
          patientGender:body.patientGender,department:appointmentDepartment},existing.revision);
      }
      return prepare ? this.paymentOrder(user, existing) : this.deliverAppointment(user, existing, body.paymentId);
    }
    const patientGender = body.patientGender;
    requireValue(patientGenders.has(patientGender), 'Please select the patient gender before booking.',400,'patient_gender_required');
    const doctor = text(body.doctorId); const profile = await this.bookableDoctor(doctor,appId);
    requireValue(profile.isAvailable, 'This doctor is not accepting appointments.',400,'consultation_unavailable');
    const mode = text(body.consultationType);
    requireValue(['video','opd','audio'].includes(mode) && (profile.availableConsultationType === 'all' || profile.availableConsultationType === mode ||
      (profile.availableConsultationType === 'online' && ['video','audio'].includes(mode))), 'Consultation type not available');
    const fee = profile.consultationFees[mode];
    requireValue(body.consultationFee == null || Number(body.consultationFee) === fee,
      'The consultation charge has changed. Refresh the doctor details before booking.',409,'doctor_fee_changed');
    requireValue(fee === 0 || (this.payments?.keyId && this.payments.configured !== false), 'Payments are temporarily unavailable. No payment was taken.', 503, 'payment_setup_required');
    requireValue(fee === 0 || prepare, 'Prepare your appointment payment first',409);
    const date = text(body.appointmentDate).slice(0,10);
    const time = text(body.time, 8);
    const reservationName = `${this.appId === 'seedfit' ? 'SEEDFIT' : 'SIYA'}-${this.records.key(user.id, 'appointment', id).slice(0,32)}`;
    let reservation = await this.erp.maybe('Mobile App Appointment', reservationName);
    const slots = await this.availability(doctor, date, reservation ? id : undefined, appId);
    const slot = slots.slots.find(s => s.time === time);
    requireValue(slot, 'This slot is no longer available. Please select another.', 409, 'slot_unavailable');
    requireValue(this.webhookUrl, 'Appointment booking is temporarily unavailable. No payment was taken.',503,'booking_setup_required');
    const identity = await this.identity(user);
    if (reservation) {
      requireValue(reservation.mobile_app_user === identity.erpUser && reservation.practitioner_id === doctor &&
        String(reservation.appointment_date).slice(0,10) === date && String(reservation.appointment_time).slice(0,5) === time.slice(0,5),
        'This booking ID already refers to another appointment. Please contact the clinic.',409);
    }
    const patientName = text(body.patientName, 150);
    const patientPhone = text(body.patientPhone || user.phone, 30);
    requireValue(patientName && /^\+?[\d\s-]{10,20}$/.test(patientPhone), 'A patient name and valid contact phone number are required');
    if (!reservation) reservation = await this.erp.create('Mobile App Appointment', {
      appointment_external_id: reservationName, booking_id: id, mobile_app_user: identity.erpUser,
      practitioner_id: doctor, practitioner_schedule: slot.schedule_id, appointment_date: date, appointment_time: time,
      duration: slot.duration, status: 'Pending', consultation_type: mode, is_online: mode === 'opd' ? 0 : 1, patient_name: patientName,
      mobile_number: patientPhone, email: user.email,
      payload_json: JSON.stringify({source: 'mobile-api', appId, id, patientGender, department: appointmentDepartment}),
    });
    const saved = {id, appId, doctorId: doctor, doctorName: profile.name,
      doctorImage: profile.imageUrl, specialization: profile.specialization, appointmentDate: date, time,
      timeSlot: `${String(Number(time.slice(0,2)) % 12 || 12).padStart(2,'0')}:${time.slice(3,5)} ${Number(time.slice(0,2)) < 12 ? 'AM' : 'PM'}`,
      consultationType: mode, patientName, patientPhone, patientEmail: user.email,
      patientGender, department: appointmentDepartment,
      symptoms: text(body.symptoms || '', 4000), consultationFee: fee, status: 'pending',
      createdAt: new Date().toISOString(), paymentStatus: fee === 0 ? 'free' : 'pending', paymentId: fee === 0 ? `FREE-${id}` : null,
      reservation: reservationName, bookingSyncPending: true, deliveryState: 'not_sent'};
    const record = await this.records.write(user.id, 'appointment', id, saved, 0);
    return prepare ? this.paymentOrder(user,record) : this.deliverAppointment(user,record,body.paymentId);
  }
  async paymentOrder(user, record) {
    requireValue(this.payments?.keyId && this.payments.configured !== false,
      'Payments are temporarily unavailable. No payment was taken.',503,'payment_setup_required');
    requireValue(record.data.consultationFee > 0 && this.payments?.keyId,'Payment is not available',503);
    if (record.data.paymentOrderId) return {orderId:record.data.paymentOrderId,keyId:this.payments.keyId,amount:record.data.consultationFee};
    requireValue(!record.data.paymentOrderRequested,'Payment preparation is pending. Contact the clinic before retrying.',409,'payment_order_pending');
    record = await this.records.write(user.id,'appointment',record.data.id,{...record.data,paymentOrderRequested:true},record.revision);
    const order=await this.payments.create(user,record.data);
    await this.records.write(user.id,'appointment',record.data.id,{...record.data,paymentOrderId:order.id},record.revision);
    return {orderId:order.id,keyId:this.payments.keyId,amount:record.data.consultationFee};
  }
  async bookingReservation(user, data) {
    const identity = await this.identity(user);
    const reservation = await this.erp.get('Mobile App Appointment', data.reservation);
    requireValue(reservation.mobile_app_user === identity.erpUser && reservation.practitioner_id === data.doctorId,
      'Appointment reservation could not be verified',409,'unverified_reservation');
    return reservation;
  }
  async confirmReservation(user, record) {
    const data = record.data;
    requireValue(data.consultationFee === 0 ? data.paymentStatus === 'free' : data.paymentStatus === 'paid',
      'Payment must be verified before confirmation',409,'payment_not_verified');
    let reservation = await this.bookingReservation(user, data);
    requireValue(String(reservation.appointment_date).slice(0,10) === data.appointmentDate &&
      String(reservation.appointment_time).slice(0,5) === data.time.slice(0,5),
      'Appointment details changed. Refresh before confirming.',409);
    requireValue(['Pending','Confirmed','Rescheduled'].includes(reservation.status),
      'This appointment can no longer be confirmed.',409);
    if (reservation.status === 'Pending') {
      await this.erp.update('Mobile App Appointment', reservation.name, {status:'Confirmed',modified:reservation.modified});
      reservation = await this.bookingReservation(user, data);
    }
    requireValue(['Confirmed','Rescheduled'].includes(reservation.status),'Clinic confirmation could not be verified',409);
    return this.records.write(user.id,'appointment',data.id,{...data,status:'confirmed',bookingSyncPending:false,
      encounterSyncPending:!data.erpEncounterId},record.revision);
  }
  encounterBookingStatus(encounter, data) {
    const status = appointmentStatus(encounter.custom_appointment_status);
    if (['cancelled','completed'].includes(data.status)) return data.status;
    if (data.status === 'checked_in' && ['pending','confirmed'].includes(status)) return data.status;
    // A new encounter starts Pending; it must not downgrade an already confirmed reservation.
    return status === 'pending' && data.status === 'confirmed' ? 'confirmed' : status;
  }
  async deliverAppointment(user, record, paymentId) {
    if (record.data.deliveryState !== 'not_sent') return this.refreshAppointment(user,record);
    if (record.data.consultationFee > 0) {
      await this.payments.verify(user,record.data,paymentId);
      record=await this.records.write(user.id,'appointment',record.data.id,{...record.data,paymentId,paymentStatus:'paid'},record.revision);
    }
    record = await this.confirmReservation(user, record);
    if (this.meetings && record.data.consultationType === 'video') {
      const reservation = await this.bookingReservation(user,record.data);
      const prepared = await prepareAppointmentMeet(this,user,record.data,null,reservation);
      record = await this.records.write(user.id,'appointment',record.data.id,prepared,record.revision);
    }
    const saved=record.data; const id=saved.id; const identity=await this.identity(user);
    // Persist intent before external delivery. Uncertain delivery is reconciled, never blindly replayed.
    record = await this.records.write(user.id, 'appointment', id, {...saved, deliveryState: 'sent'}, record.revision);
    if (!this.webhookUrl) return record.data;
    try {
      const response = await this.fetcher(this.webhookUrl, {method: 'POST', headers: {'Content-Type': 'application/json',
        'Idempotency-Key': id, ...(this.webhookSecret ? {'X-Mobile-Webhook-Secret': this.webhookSecret} : {})},
        body: JSON.stringify({event: 'appointment.created', ...saved, fee: saved.consultationFee,
          department: saved.department || appointmentDepartment,
          patient: {name: saved.patientName, phone: saved.patientPhone, email: user.email, sex: saved.patientGender},
          erpMobileUser: identity.erpUser, erpReservation: saved.reservation, erpPatientId: identity.patient}),
        signal: AbortSignal.timeout(25000), redirect: 'error'});
      if (!response.ok) return record.data;
      let result = await response.json(); if (Array.isArray(result)) result = result.length === 1 ? result[0] : null;
      const encounter = result?.data ?? result;
      if (encounter?.doctype !== 'Patient Encounter' || !encounter.name) return record.data;
      return await this.attachEncounter(user, record, encounter.name);
    } catch { return record.data; }
  }
  async attachEncounter(user, record, encounterId) {
    let encounter = await this.erp.get('Patient Encounter', encounterId);
    // A webhook cannot attach another patient's arbitrary encounter to this account.
    requireValue(encounter.docstatus !== 2 && (encounter.sr_notes || '').includes(`External appointment ID: ${record.data.id}`), 'Appointment response could not be verified', 409);
    const reservation = await this.bookingReservation(user, record.data);
    // A delayed n8n response must not leave a cancelled reservation active in the clinic.
    if (reservation.status === 'Cancelled' || record.data.status === 'cancelled') {
      requireValue(encounter.sr_encounter_type === 'Appointment' &&
        (encounter.pe_practitioner || encounter.practitioner) === record.data.doctorId &&
        (!record.data.erpPatientId || encounter.patient === record.data.erpPatientId) &&
        (encounter.sr_notes || '').split(/\r?\n/).some(line=>line.trim() === `External appointment ID: ${record.data.id}`),
        'Clinic appointment does not match this booking.',409,'unverified_encounter');
      await this.cancelCalendarAppointment('Patient Encounter', encounter.name);
      encounter = await this.erp.get('Patient Encounter', encounterId);
      requireValue(encounter.custom_appointment_status === 'Cancelled', 'Clinic cancellation could not be verified',502,'cancellation_unverified');
    }
    record = {...record,data:this.reservationBookingData(reservation,record.data)};
    const data = {...record.data, erpEncounterId: encounter.name, erpPatientId: encounter.patient,
      erpAppointmentReference: encounter.encounter_reference, status: this.encounterBookingStatus(encounter, record.data),
      meetingLink: appointmentMeetLink(record.data, encounter.google_meet_link), bookingSyncPending: false, encounterSyncPending: false, deliveryState: 'acknowledged'};
    await this.erp.update('Mobile App Appointment', data.reservation, {
      patient_encounter: encounter.name, modified:reservation.modified,
      // ERP recognizes online reservations by the real Meet URL, not the app's "video" label.
      ...(encounter.sr_encounter_place === 'Online' && data.meetingLink ? {
        consultation_type:data.meetingLink,is_online:1,google_meet_link:data.meetingLink,
      } : {}),
    });
    // Do not automatically grant access to a historical patient matched by phone inside n8n.
    // An existing explicit account->Patient mapping remains the authority for records/invoices.
    const saved = await this.records.write(user.id, 'appointment', data.id, data, record.revision);
    return this.meetings ? this.refreshAppointment(user,saved) : saved.data;
  }
  reservationBookingData(reservation, data) {
    const status = appointmentStatus(reservation.status);
    const paid = data.consultationFee === 0 ? data.paymentStatus === 'free' : data.paymentStatus === 'paid';
    if (['Confirmed','Rescheduled','Cancelled','Completed','Checked In','No Show'].includes(reservation.status) &&
        (paid || !['Confirmed','Rescheduled'].includes(reservation.status))) {
      return {...data,
        status:reservation.status === 'Rescheduled' ? 'confirmed' : reservation.status === 'No Show' ? 'cancelled' : status,
        bookingSyncPending:false};
    }
    return data;
  }
  async refreshAppointment(user, record) {
    let reservation;
    if (record.data.reservation) {
      reservation = await this.bookingReservation(user, record.data);
      record = {...record,data:this.reservationBookingData(reservation,record.data)};
      record.data.meetingLink = appointmentMeetLink(record.data, reservation.google_meet_link);
    }
    if (record.data.erpEncounterId) {
      const enc = await this.erp.get('Patient Encounter', record.data.erpEncounterId);
      let data = {...record.data, status: this.encounterBookingStatus(enc, record.data)};
      if (this.meetings && reservation) data = await prepareAppointmentMeet(this,user,data,enc,reservation);
      if (data.meetingState && data.meetingState !== 'ready') return {...data,meetingLink:null};
      // Provisioning writes ERP, so reread before exposing its link or syncing flags.
      if (data.meetingState === 'ready') {
        const current = await this.erp.get('Patient Encounter',enc.name);
        return {...data,meetingLink:appointmentMeetLink(data,current.google_meet_link)};
      }
      const meetingLink = appointmentMeetLink(data, enc.google_meet_link);
      // A Google link can arrive after the webhook has finished. Keep the owned ERP
      // reservation in sync when the app refreshes, without creating another meeting.
      if (meetingLink && enc.sr_encounter_place === 'Online' && reservation?.patient_encounter === enc.name &&
          (reservation.consultation_type !== meetingLink || Number(reservation.is_online) !== 1 || reservation.google_meet_link !== meetingLink)) {
        await this.erp.update('Mobile App Appointment',data.reservation,{
          consultation_type:meetingLink,is_online:1,google_meet_link:meetingLink,modified:reservation.modified,
        });
      }
      return {...data, meetingLink};
    }
    if (record.data.deliveryState === 'sent') {
      const matches = await this.erp.list('Patient Encounter', {sr_notes: ['like', `%External appointment ID: ${record.data.id}%`]}, ['name'], {limit: 2});
      if (matches.length === 1) return this.attachEncounter(user, record, matches[0].name);
    }
    if (this.meetings && reservation) return prepareAppointmentMeet(this,user,record.data,null,reservation);
    return record.data;
  }
  async appointments(user) {
    const rows = await this.records.list(user.id, 'appointment');
    const items = [];
    for (const row of rows) {
      try { items.push(await this.refreshAppointment(user, row)); }
      catch (error) {
        // A stale booking reference must not hide the customer's other bookings.
        // Only a confirmed missing Frappe document qualifies, not an ERP outage
        // or a proxy's generic 404. Never expose an unverified old meeting link.
        if (!(error instanceof ApiError) || !error.missingDocument) throw error;
        items.push({...row.data,status:'pending',bookingSyncPending:true,
          encounterSyncPending:true,meetingLink:null,meetingState:'needs_review',
          syncIssue:'erp_record_missing'});
      }
    }
    return {items};
  }
  async appointmentChange(user, id, body) {
    const record = await this.records.read(user.id, 'appointment', id);
    requireValue(record, 'Appointment not found', 404);
    requireValue(['cancel','reschedule'].includes(body.action), 'Invalid appointment action');
    const requestId = text(body.requestId, 100);
    requireValue(requestId, 'A request ID is required');
    const prior = await this.records.read(user.id, 'appointment_request', requestId);
    if (prior) requireValue(prior.data.appointmentId === id && prior.data.action === body.action,
      'This request ID belongs to another appointment change.',409,'idempotency_conflict');
    if (body.action === 'cancel') {
      if (prior?.data.status === 'Completed') return prior.data;
      return this.cancelAppointment(user,record,requestId,prior);
    }
    // Rescheduling remains a clinic request.
    if (prior) return prior.data;
    const request = {id: requestId, appointmentId: id, action: body.action, date: body.date, time: body.time,
      status: 'Pending', createdAt: new Date().toISOString()};
    await this.records.write(user.id, 'appointment_request', requestId, request, 0);
    return request;
  }
  async cancellationState(doctype, name) {
    const state = await this.erp.method('mobile_app.api.appointment_calendar.get_appointment',{doctype,name});
    requireValue(state?.name === name && state.source_doctype === doctype,
      'Clinic appointment could not be verified',502,'cancellation_unverified');
    requireValue(state.status === 'Cancelled' ||
      (['Pending','Approved'].includes(state.status) && state.actions?.includes('cancel')),
      'This appointment can no longer be cancelled in the app. Please contact the clinic.',409,'cancellation_not_allowed');
    return state;
  }
  async cancelCalendarAppointment(doctype, name, state) {
    state ||= await this.cancellationState(doctype,name);
    if (state.status !== 'Cancelled') {
      await this.erp.method('mobile_app.api.appointment_calendar.update_appointment',{
        doctype,name,action:'cancel',expected_status:state.status,reason:'Cancelled by the patient in the mobile app.',
      },true);
    }
    const verified = await this.cancellationState(doctype,name);
    requireValue(verified.status === 'Cancelled','Clinic cancellation could not be verified',502,'cancellation_unverified');
  }
  async cancelAppointment(user, record, requestId, prior) {
    const data = record.data;
    let reservation = await this.bookingReservation(user,data);
    requireValue(reservation.booking_id === data.id, 'Appointment reservation could not be verified',409,'unverified_reservation');
    requireValue(!['completed','checked_in'].includes(data.status) &&
      ['Pending','Confirmed','Rescheduled','Cancelled'].includes(reservation.status),
      'This appointment can no longer be cancelled in the app. Please contact the clinic.',409,'cancellation_not_allowed');
    requireValue(!data.erpEncounterId || !reservation.patient_encounter || data.erpEncounterId === reservation.patient_encounter,
      'The clinic appointment links need review. Please contact the clinic.',409,'unverified_encounter');
    let encounterId = data.erpEncounterId || reservation.patient_encounter;
    if (!encounterId) {
      const matches = await this.erp.list('Patient Encounter',
        {sr_notes:['like',`%External appointment ID: ${data.id}%`]},['name'],{limit:2});
      requireValue(matches.length < 2,'Multiple clinic records match this booking. Please contact the clinic.',409,'ambiguous_encounter');
      encounterId = matches[0]?.name;
    }
    let encounter;
    if (encounterId) {
      encounter = await this.erp.get('Patient Encounter',encounterId);
      requireValue(encounter.sr_encounter_type === 'Appointment' &&
        (encounter.sr_notes || '').split(/\r?\n/).some(line=>line.trim() === `External appointment ID: ${data.id}`) &&
        (encounter.pe_practitioner || encounter.practitioner) === data.doctorId &&
        (!data.erpPatientId || encounter.patient === data.erpPatientId),
        'Clinic appointment does not match this booking. Please contact the clinic.',409,'unverified_encounter');
    }
    // Validate both states before making changes. ERP locks and expected_status guard races.
    const reservationState = await this.cancellationState('Mobile App Appointment',reservation.name);
    const encounterState = encounter && await this.cancellationState('Patient Encounter',encounter.name);
    const request = prior || await this.records.write(user.id,'appointment_request',requestId,{
      id:requestId,appointmentId:data.id,action:'cancel',status:'Processing',createdAt:new Date().toISOString(),
    },0);
    if (encounter) await this.cancelCalendarAppointment('Patient Encounter',encounter.name,encounterState);
    await this.cancelCalendarAppointment('Mobile App Appointment',reservation.name,reservationState);
    // The calendar workflow tracks decisions; the reservation status also controls slot capacity.
    reservation = await this.bookingReservation(user,data);
    if (reservation.status !== 'Cancelled') {
      requireValue(['Pending','Confirmed','Rescheduled'].includes(reservation.status),
        'This appointment changed. Please refresh and retry.',409);
      await this.erp.update('Mobile App Appointment',reservation.name,{status:'Cancelled',modified:reservation.modified});
    }
    reservation = await this.bookingReservation(user,data);
    requireValue(reservation.status === 'Cancelled','Reservation cancellation could not be verified',502,'cancellation_unverified');
    if (encounter) {
      encounter = await this.erp.get('Patient Encounter',encounter.name);
      requireValue(encounter.custom_appointment_status === 'Cancelled','Clinic cancellation could not be verified',502,'cancellation_unverified');
    }
    const saved = await this.records.write(user.id,'appointment',data.id,{
      ...data,status:'cancelled',bookingSyncPending:false,cancelledAt:data.cancelledAt || new Date().toISOString(),
      ...(encounter ? {erpEncounterId:encounter.name,erpPatientId:encounter.patient,encounterSyncPending:false,deliveryState:'acknowledged'} : {}),
    },record.revision);
    const completed = await this.records.write(user.id,'appointment_request',requestId,{
      ...request.data,status:'Completed',appointment:saved.data,
    },request.revision);
    return completed.data;
  }
  async treatments(user, appId = 'siya-ayurveda') {
    assessmentApp(appId);
    return {items:await this.assessments.list(user.id,appId)};
  }
  async treatment(user, body, appId = 'siya-ayurveda') {
    assessmentApp(appId);
    const id = text(body.id, 100); object(body.answers);
    requireValue(/^[a-zA-Z0-9-]{16,100}$/.test(id), 'Invalid assessment ID');
    await this.assessments.migrateLegacy(user.id,appId);
    const prior = await this.assessments.read(user.id,appId,id);
    if (prior) return prior;
    const identity = await this.identity(user);
    return this.assessments.create(user.id,appId,{id, patient: identity.patient, questionnaireVersion: text(body.questionnaireVersion, 100),
      answers: body.answers, result: body.result || {}, createdAt: new Date().toISOString()});
  }
  async patient(user) {
    const {patient} = await this.identity(user);
    requireValue(patient, 'Please ask the clinic to link your patient record to your account.', 409, 'patient_link_required');
    return this.erp.get('Patient', patient);
  }
  async dietContext(user) {
    const identity = await this.identity(user);
    const invoices = await trackedInvoices(this,user,{returns:true});
    requireValue(identity.patient || invoices.some(doc => !doc.is_return),
      'Please ask the clinic to link your patient record to your account.',409,'patient_link_required');
    return {patient:identity.patient ? await this.erp.get('Patient',identity.patient) : null,invoices};
  }
  async diets(user) {
    const {patient,invoices} = await this.dietContext(user);
    return patientDiets(this.erp,patient,invoices);
  }
  async dietPdf(user, id) {
    const {patient,invoices} = await this.dietContext(user);
    return dietPdf(this.erp,patient,id,invoices);
  }
  async orders(user, offset = 0) {
    const identity = await this.identity(user);
    const trackedIds = await this.checkoutTracking.ids(user);
    requireValue(identity.patient || trackedIds.length, 'Please ask the clinic to link your patient record to your account.',409,'patient_link_required');
    const patient = identity.patient ? await this.erp.get('Patient',identity.patient) : null;
    // Patient-scoped invoices prevent a shared Customer from exposing another family member's care.
    // List only core fields; optional shipping data is read from the owned document.
    // Return only the explicit order details below, never the raw ERP record.
    const legacyFilters = [...(patient ? [['patient','=',patient.name]] : []),
      ...(identity.customers?.length ? [['customer','in',identity.customers]] : [])];
    const limit = offset+21;
    const rows = legacyFilters.length ? await this.erp.list('Sales Invoice',
      !identity.customers?.length ? {docstatus:1,patient:patient.name} : {docstatus:1},
      ['name','posting_date'],{limit,order:'posting_date desc, name desc',
        ...(identity.customers?.length ? {orFilters:legacyFilters} : {})}) : [];
    // Keep URL sizes bounded and combine before paging so duplicate invoices do not
    // skip or repeat entries when an order is also visible through the Patient.
    for (let i=0;i<trackedIds.length;i+=50) {
      const linked=await this.erp.list('Sales Invoice',{docstatus:1,shopify_order_id:['in',trackedIds.slice(i,i+50)]},
        ['name','posting_date','custom_app_brand'],{limit,order:'posting_date desc, name desc'});
      rows.push(...linked.filter(row=>this.checkoutTracking.brandMatches(row)));
    }
    const invoiceRows=[...new Map(rows.map(row=>[row.name,row])).values()]
      .sort((a,b)=>String(b.posting_date).localeCompare(String(a.posting_date)) || b.name.localeCompare(a.name));
    const orders = identity.customers?.length ? await this.erp.list('Sales Order', {customer:['in',identity.customers],docstatus:1,per_billed:['<',100]},
      ['name','transaction_date','grand_total','currency','status'], {limit,order:'transaction_date desc, name desc'}) : [];
    const items = [];
    const all = [...orders.map(r=>({type:'Sales Order',name:r.name,date:r.transaction_date})),
      ...invoiceRows.map(r=>({type:'Sales Invoice',name:r.name,date:r.posting_date}))]
      .sort((a,b)=>String(b.date).localeCompare(String(a.date)) || b.name.localeCompare(a.name));
    const documents=all.slice(offset,offset+20);
    for (let i=0; i<documents.length; i+=4) {
      items.push(...await Promise.all(documents.slice(i,i+4).map(async row=>{
        const doc = await this.erp.get(row.type,row.name);
        requireValue(doc.docstatus === 1 && (row.type === 'Sales Invoice' && patient && doc.patient === patient.name ||
          identity.customers?.includes(doc.customer) || row.type === 'Sales Invoice' && await this.checkoutTracking.owns(user,doc)), 'Order not found',404);
        const shipment = row.type === 'Sales Invoice' ? await this.invoiceShipment(doc,{optional:true}) : null;
        return orderDetails({...doc,doctype:row.type},patient,this.productImage,
          row.type === 'Sales Invoice' ? trackingSummary(doc,shipment) : null,
          await invoiceKit(this.erp,doc,this.productImage,this.appId === 'seedfit' ? this.productCatalog : undefined));
      })));
    }
    return {items:items.sort((a,b)=>String(b.date).localeCompare(String(a.date))),
      nextCursor: all.length > offset+20 ? offset + 20 : null};
  }
  async invoiceShipment(invoice, {optional = false} = {}) {
    if (!this.shipmentCapability || this.shipmentCapability.until < Date.now()) {
      this.shipmentCapability = {until:Date.now()+300_000,
        ready:this.erp.maybe('DocType','Shipment Tracking Shipment').then(Boolean).catch(()=>false)};
    }
    if (!await this.shipmentCapability.ready) return null;
    let shipment;
    try {
      const rows = await this.erp.list('Shipment Tracking Shipment',{sales_invoice:invoice.name},['name'],{limit:2});
      if (rows.length !== 1) return null;
      shipment = await this.erp.get('Shipment Tracking Shipment',rows[0].name);
    } catch (error) {
      // Optional shipment access must not hide an already authorized invoice.
      // Keep ownership mismatches and all other failures visible.
      if (optional && error.code === 'erp_request_failed' && error.upstreamStatus === 403) return null;
      throw error;
    }
    requireValue(shipment.sales_invoice === invoice.name && (!shipment.patient || shipment.patient === invoice.patient) &&
      (!shipment.customer || shipment.customer === invoice.customer) &&
      (!invoice.si_shipkia_shipment || invoice.si_shipkia_shipment === shipment.name) &&
      (!invoice.si_shipkia_order_id || invoice.si_shipkia_order_id === shipment.shipkia_order_id),
      'Shipment not available',404);
    return shipment;
  }
  async ownedInvoice(user, id) {
    const identity=await this.identity(user);
    const invoice = await this.erp.get('Sales Invoice', id);
    requireValue((identity.patient && invoice.patient === identity.patient || identity.customers?.includes(invoice.customer) ||
      await this.checkoutTracking.owns(user,invoice)) && invoice.docstatus === 1, 'Invoice not found', 404);
    const patient = identity.patient ? await this.erp.get('Patient',identity.patient) : null;
    return {invoice,patient};
  }
  async invoice(user, id, pdf = false) {
    const {invoice,patient} = await this.ownedInvoice(user,id);
    if (pdf) return this.erp.request(`/api/method/frappe.utils.print_format.download_pdf?${new URLSearchParams({doctype:'Sales Invoice',name:id,format:'Standard',no_letterhead:'0'})}`, {raw:true});
    return orderDetails({...invoice,doctype:'Sales Invoice'},patient,this.productImage,
      trackingSummary(invoice,await this.invoiceShipment(invoice,{optional:true})),await invoiceKit(this.erp,invoice,this.productImage,this.appId === 'seedfit' ? this.productCatalog : undefined));
  }
  async refreshInvoiceTracking(user, id) {
    // Authorize before querying tracking or triggering a carrier refresh.
    const {invoice} = await this.ownedInvoice(user,id);
    let shipment;
    try { shipment = await this.invoiceShipment(invoice); }
    catch (error) {
      if (error.code === 'erp_request_failed' && error.upstreamStatus === 403) {
        return {tracking:trackingSummary(invoice,null),refreshState:'unavailable'};
      }
      throw error;
    }
    if (!shipment) return {tracking:trackingSummary(invoice,null),refreshState:'not_available'};
    try {
      const settings = await this.erp.method('shipment_tracking.api.tracking.get_tracking_ui_settings');
      if (!settings?.enable_manual_tracking_refresh || !shipment.shipkia_order_id) {
        return {tracking:trackingSummary(invoice,shipment),refreshState:'saved'};
      }
      await this.erp.method('shipment_tracking.api.tracking.sync_tracking_for_invoice',{invoice_name:id},true);
      const updated = await this.invoiceShipment(invoice);
      return {tracking:trackingSummary(invoice,updated),refreshState:'updated'};
    } catch {
      return {tracking:trackingSummary(invoice,shipment),refreshState:'unavailable'};
    }
  }

  async upload(user, body) {
    const identity = await this.identity(user);
    const isProfile = body.purpose !== 'treatment';
    const parent = isProfile ? await this.erp.get('Mobile App User', identity.erpUser) : null;
    requireValue(['image/jpeg','image/png','image/webp'].includes(body.mimeType), 'Only JPEG, PNG and WebP images are allowed');
    const bytes = Buffer.from(text(body.base64, 12_000_000), 'base64');
    requireValue(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, 'Image must be under 8 MB');
    const valid = body.mimeType === 'image/jpeg' ? bytes.subarray(0,3).equals(Buffer.from([255,216,255])) :
      body.mimeType === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
      bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
    requireValue(valid, 'File contents do not match the image type');
    const form = new FormData(); const ext = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[body.mimeType];
    const uploadName = `${randomUUID()}.${ext}`;
    form.append('file', new Blob([bytes], {type:body.mimeType}), uploadName);
    form.append('is_private',isProfile ? '0' : '1'); form.append('doctype','Mobile App User'); form.append('docname',identity.erpUser);
    let uploaded;
    try {
      uploaded = await this.erp.request('/api/method/upload_file', {method:'POST',body:form,timeoutMs:50000});
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      // An ERP upload can commit before its response arrives. Reconcile this
      // exact upload once; never blindly POST a second file after a timeout.
      const matches = await this.erp.list('File', {file_name:uploadName,
        attached_to_doctype:'Mobile App User',attached_to_name:identity.erpUser}, ['name'], {limit:2});
      if (matches.length !== 1) throw error;
      uploaded = matches[0];
    }
    const file = await this.erp.get('File', uploaded.name);
    requireValue(file.attached_to_doctype === 'Mobile App User' && file.attached_to_name === identity.erpUser,
      'Uploaded file does not belong to your profile', 409);
    requireValue(file.file_url?.startsWith('s3://') || (isProfile && publicImageUrl(this.erp,file)),
      isProfile ? 'ERP did not save a supported profile image.' : 'ERP S3 upload is not enabled. Please contact the clinic.',
      503, isProfile ? 'image_storage_unavailable' : 's3_required');
    if (isProfile) {
      // Keep the ERP Desk avatar in sync. Passing modified rejects an overwrite
      // if clinic staff changed this document while the file was uploading.
      // Public profile photos use their stable ERP path; S3 photos retain the
      // ERP download route, never an expiring signed URL.
      const image = publicImageUrl(this.erp,file) ? file.file_url :
        `/api/method/frappe.handler.download_file?${new URLSearchParams({file_url:file.file_url})}`;
      await this.erp.update('Mobile App User', identity.erpUser,
        {image, ...(parent.modified ? {modified:parent.modified} : {})});
    }
    return {fileId:file.name};
  }
  async file(user, id) {
    const identity = await this.identity(user);
    const file = await this.erp.get('File', id);
    requireValue(file.attached_to_doctype === 'Mobile App User' && file.attached_to_name === identity.erpUser, 'File not found',404);
    const publicUrl = publicImageUrl(this.erp,file);
    if (publicUrl) return {url:publicUrl,expiresIn:300};
    requireValue(file.file_url?.startsWith('s3://'), 'File is not available',404);
    const signed = await this.erp.method(this.s3PresignMethod, {file_url:file.file_url,expires:300});
    const url = typeof signed === 'string' ? signed : signed?.url;
    requireValue(url?.startsWith('https://'), 'File is temporarily unavailable',503);
    return {url,expiresIn:300};
  }
  async habits(user) {
    return await this.records.read(user.id,'habits','self') || {data:null,revision:0};
  }
  habitOrders(user,appId,offset) { return habitOrders(this,user,appId,offset); }
  erpHabitTracker(user,appId) { return getErpHabitTracker(this,user,appId); }
  saveErpHabitTracker(user,body,appId) { return saveErpHabitTracker(this,user,body,appId); }
  habitPrescriptions(user,appId) { return habitPrescriptions(this,user,appId); }
  async saveHabits(user, body) {
    const incoming = object(body.data); const old = await this.habits(user);
    requireValue(body.revision === old.revision,'Habits changed on another device. Refresh and try again.',409,'revision_conflict');
    requireValue(Array.isArray(incoming.habits) && incoming.habits.length <= 100, 'Invalid habits');
    object(incoming.dailyCompliance);
    // Preserve historical entries. Only today's entry can be edited; imported legacy history is separate.
    const today = day();
    const daily = {...old.data?.dailyCompliance};
    if (incoming.dailyCompliance[today]) daily[today] = incoming.dailyCompliance[today];
    const data = {...incoming, userId:user.id, dailyCompliance:daily, rewards:old.data?.rewards || [],
      currentStreak:0, longestStreak:old.data?.longestStreak || 0, lastUpdated:new Date().toISOString()};
    const ids = incoming.habits.filter(h => h.isActive !== false).map(h => h.id);
    let streak = 0;
    const cursor = new Date(`${today}T12:00:00Z`);
    if (!isPerfectDay(daily[today],ids)) cursor.setUTCDate(cursor.getUTCDate()-1);
    while (isPerfectDay(daily[cursor.toISOString().slice(0,10)],ids)) {
      streak++; cursor.setUTCDate(cursor.getUTCDate()-1);
    }
    data.currentStreak = streak; data.longestStreak = Math.max(streak,data.longestStreak);
    // Eligibility uses the server-approved plan, never a client-created plan or client streak count.
    let persisted = await this.records.write(user.id,'habits','self',data,body.revision);
    const plan = await this.records.read(user.id,'habit_plan','self');
    if (streak >= 30 && plan?.data?.habitIds?.length && JSON.stringify([...plan.data.habitIds].sort()) === JSON.stringify([...ids].sort()) && this.rewardIssuer) {
      const cycle = `${cursor.toISOString().slice(0,10)}-${Math.floor(streak/30)}`;
      const key = recordName(user.id,'reward',cycle);
      let reward = await this.records.read(user.id,'reward',key);
      if (!reward) reward = await this.records.write(user.id,'reward',key,{id:key,code:`${this.appId === 'seedfit' ? 'SEEDFIT' : 'SIYA'}${key.slice(0,16).toUpperCase()}`,state:'pending',
        createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90*86400000).toISOString()},0);
      if (reward.data.state !== 'issued') {
        try { await this.rewardIssuer(user,reward.data); }
        catch { return {...persisted,rewardPending:true}; }
        reward = await this.records.write(user.id,'reward',key,{...reward.data,state:'issued'},reward.revision);
      }
      if (!data.rewards.some(r => r.id === key)) data.rewards.push({id:key,couponCode:reward.data.code,discountPercent:5,
        earnedAt:reward.data.createdAt,expiresAt:reward.data.expiresAt,isUsed:false,streakDays:30});
    }
    if (data.rewards.length !== (old.data?.rewards || []).length) {
      persisted = await this.records.write(user.id,'habits','self',data,persisted.revision);
    }
    return persisted;
  }
}
