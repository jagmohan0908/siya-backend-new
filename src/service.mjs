import {randomUUID} from 'node:crypto';
import {ApiError, object, requireValue, text} from './errors.mjs';
import {Records, SerialQueue, recordName} from './store.mjs';
import {isPerfectDay} from './habits.mjs';

const day = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
const statuses = {Pending: 'pending', Approved: 'confirmed', Confirmed: 'confirmed', 'Checked In': 'checked_in', Completed: 'completed', Cancelled: 'cancelled'};
export const appointmentStatus = value => statuses[value] || 'pending';
const cleanProfile = data => Object.fromEntries(['name','gender','dateOfBirth','height','weight'].filter(k => data[k] != null).map(k => [k, text(String(data[k]), 150)]));
const patientGenders = new Set(['Male','Female','Other','Prefer not to say','Non-Conforming','Genderqueer','Transgender']);
const appointmentDepartment = 'Skin/Fertility/Liver/IBS';
const appDoctorTags = new Map([['siya-ayurveda', 'Siya Ayurveda'], ['seedfit', 'Seedfit']]);
const doctorTag = appId => {
  requireValue(appDoctorTags.has(appId), 'Unknown app ID',400,'invalid_app');
  return appDoctorTags.get(appId);
};

export class MobileService {
  constructor({erp, webhookUrl, webhookSecret, fetcher = fetch, rewardIssuer, payments,
    s3PresignMethod = 'sriaas_clinic.api.s3.presign.get_presigned_url'}) {
    Object.assign(this, {erp, webhookUrl, webhookSecret, fetcher, rewardIssuer, payments, s3PresignMethod});
    this.records = new Records(erp); this.queue = new SerialQueue();
  }
  async identity(user) {
    let record = await this.records.read(user.id, 'identity', 'self');
    if (record) return record.data;
    // Only stable, verified external IDs may attach an existing ERP account.
    const ids = [user.id, user.id.split('/').at(-1)];
    let matches = await this.erp.list('Mobile App User', {external_id: ['in', ids]}, ['name'], {limit: 2});
    requireValue(matches.length < 2, 'Your account needs to be linked by the clinic', 409, 'identity_link_required');
    const parent = matches.length ? await this.erp.get('Mobile App User', matches[0].name) :
      await this.erp.create('Mobile App User', {external_id: user.id, full_name: user.name, phone: user.phone, is_active: 1});
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
    }, ['name','file_url'], {limit: 1}) : [];
    const image = files.find(file => file.file_url?.startsWith('s3://'));
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
    const fee = doc.op_consulting_charge;
    requireValue(fee !== null && fee !== undefined && fee !== '' && Number.isFinite(Number(fee)) && Number(fee) >= 0,
      'The clinic needs to configure this doctor\'s consultation charge.',503,'doctor_fee_unavailable');
    const qualification = doc.sr_qualification || '';
    const opd = Number(doc.custom_accept_opd_appointments ?? 1) === 1;
    const online = Number(doc.custom_accept_online_appointments) === 1;
    return {id:doc.name, name:doc.practitioner_name || doc.name,
      specialization:qualification || doc.department || '', qualification,
      imageUrl:doc.image ? `/v1/doctors/${encodeURIComponent(doc.name)}/photo?app=${encodeURIComponent(appId)}&v=${encodeURIComponent(doc.modified || doc.image)}` : '',
      consultationFee:Math.round(Number(fee)*100)/100, isFreeConsultation:Number(fee) === 0,
      about:doc.custom_about_doctor || '', isAvailable:opd || online,
      acceptsOpdAppointments:opd, acceptsOnlineAppointments:online,
      availableDays:[...new Set((row.schedules || []).flatMap(s=>s.days))].map(v=>v.slice(0,3)),
      nextAvailableSlot:'', expertise:(doc.sr_diseases || []).map(d=>d.disease).filter(Boolean),
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
      requireValue(file.attached_to_doctype==='Siya Mobile Record' && file.attached_to_name===recordName('system','review_assets','indian-illustrations')
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
    requireValue(body.consultationFee == null || Number(body.consultationFee) === profile.consultationFee,
      'The consultation charge has changed. Refresh the doctor details before booking.',409,'doctor_fee_changed');
    requireValue(profile.consultationFee === 0 || this.payments?.keyId, 'Payments are temporarily unavailable. No payment was taken.', 503, 'payment_setup_required');
    requireValue(profile.consultationFee === 0 || prepare, 'Prepare your appointment payment first',409);
    const date = text(body.appointmentDate).slice(0,10);
    const time = text(body.time, 8);
    const reservationName = `SIYA-${recordName(user.id, 'appointment', id).slice(0,32)}`;
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
      duration: slot.duration, status: 'Pending', consultation_type: mode, patient_name: patientName,
      mobile_number: patientPhone, email: user.email,
      payload_json: JSON.stringify({source: 'siya-mobile-api', appId, id, patientGender, department: appointmentDepartment}),
    });
    const saved = {id, appId, doctorId: doctor, doctorName: profile.name,
      doctorImage: profile.imageUrl, specialization: profile.specialization, appointmentDate: date, time,
      timeSlot: `${String(Number(time.slice(0,2)) % 12 || 12).padStart(2,'0')}:${time.slice(3,5)} ${Number(time.slice(0,2)) < 12 ? 'AM' : 'PM'}`,
      consultationType: mode, patientName, patientPhone, patientEmail: user.email,
      patientGender, department: appointmentDepartment,
      symptoms: text(body.symptoms || '', 4000), consultationFee: profile.consultationFee, status: 'pending',
      createdAt: new Date().toISOString(), paymentStatus: profile.consultationFee === 0 ? 'free' : 'pending', paymentId: profile.consultationFee === 0 ? `FREE-${id}` : null,
      reservation: reservationName, bookingSyncPending: true, deliveryState: 'not_sent'};
    const record = await this.records.write(user.id, 'appointment', id, saved, 0);
    return prepare ? this.paymentOrder(user,record) : this.deliverAppointment(user,record,body.paymentId);
  }
  async paymentOrder(user, record) {
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
      meetingLink: encounter.google_meet_link || null, bookingSyncPending: false, encounterSyncPending: false, deliveryState: 'acknowledged'};
    await this.erp.update('Mobile App Appointment', data.reservation, {patient_encounter: encounter.name,modified:reservation.modified});
    // Do not automatically grant access to a historical patient matched by phone inside n8n.
    // An existing explicit account->Patient mapping remains the authority for records/invoices.
    const saved = await this.records.write(user.id, 'appointment', data.id, data, record.revision);
    return saved.data;
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
    if (record.data.reservation) {
      const reservation = await this.bookingReservation(user, record.data);
      record = {...record,data:this.reservationBookingData(reservation,record.data)};
    }
    if (record.data.erpEncounterId) {
      const enc = await this.erp.get('Patient Encounter', record.data.erpEncounterId);
      return {...record.data, status: this.encounterBookingStatus(enc, record.data), meetingLink: enc.google_meet_link || record.data.meetingLink};
    }
    if (record.data.deliveryState === 'sent') {
      const matches = await this.erp.list('Patient Encounter', {sr_notes: ['like', `%External appointment ID: ${record.data.id}%`]}, ['name'], {limit: 2});
      if (matches.length === 1) return this.attachEncounter(user, record, matches[0].name);
    }
    return record.data;
  }
  async appointments(user) {
    const rows = await this.records.list(user.id, 'appointment');
    const items = [];
    for (const row of rows) items.push(await this.refreshAppointment(user, row));
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
  async treatment(user, body) {
    const id = text(body.id, 100); object(body.answers);
    requireValue(/^[a-zA-Z0-9-]{16,100}$/.test(id), 'Invalid assessment ID');
    const prior = await this.records.read(user.id, 'treatment', id);
    if (prior) return prior;
    const identity = await this.identity(user);
    return this.records.write(user.id, 'treatment', id, {id, patient: identity.patient, questionnaireVersion: text(body.questionnaireVersion, 100),
      answers: body.answers, result: body.result || {}, createdAt: new Date().toISOString()}, 0);
  }
  async patient(user) {
    const {patient} = await this.identity(user);
    requireValue(patient, 'Please ask the clinic to link your patient record to your account.', 409, 'patient_link_required');
    return this.erp.get('Patient', patient);
  }
  async diets(user) {
    const patient = await this.patient(user);
    const links = await this.erp.list('Patient Encounter', {patient: patient.name, docstatus: ['<',2], diet_chart: ['is','set']},
      ['name','diet_chart','encounter_date'], {limit: 50});
    const items = [];
    for (const link of links) {
      const chart = await this.erp.get('Diet Chart', link.diet_chart);
      items.push({id: link.name, date: link.encounter_date, title: chart.diet_chart_name,
        instructions: chart.instructions, allowedFoods: chart.allowed_foods, restrictedFoods: chart.restricted_foods});
    }
    return {items};
  }
  async orders(user, offset = 0) {
    const patient = await this.patient(user);
    const identity = await this.identity(user);
    // Patient-scoped invoices prevent a shared Customer from exposing another family member's care.
    const rows = await this.erp.list('Sales Invoice', identity.customers?.length ? {docstatus:1} : {patient: patient.name, docstatus: 1},
      ['name','posting_date','grand_total','currency','status','outstanding_amount','is_return','return_against',
        'sr_si_order_source','si_shipkia_shipment_status','si_shipkia_awb_number'], {offset, limit: 21, order: 'posting_date desc, name desc',
        ...(identity.customers?.length ? {orFilters:[['patient','=',patient.name],['customer','in',identity.customers]]} : {})});
    const orders = identity.customers?.length ? await this.erp.list('Sales Order', {customer:['in',identity.customers],docstatus:1,per_billed:['<',100]},
      ['name','transaction_date','grand_total','currency','status'], {offset,limit:21,order:'transaction_date desc, name desc'}) : [];
    return {items: [...orders.slice(0,20).map(r => ({id:r.name,date:r.transaction_date,total:r.grand_total,currency:r.currency,
      documentType:'Sales Order',paymentStatus:'Awaiting invoice',deliveryStatus:r.status})), ...rows.slice(0,20).map(r => ({id: r.name, date: r.posting_date, total: r.grand_total, currency: r.currency,
      documentType:'Sales Invoice',
      paymentStatus: r.status, outstanding: r.outstanding_amount, isReturn: Boolean(r.is_return), returnAgainst: r.return_against,
      source: r.sr_si_order_source, deliveryStatus: r.si_shipkia_shipment_status, trackingNumber: r.si_shipkia_awb_number}))],
      nextCursor: rows.length > 20 || orders.length > 20 ? offset + 20 : null};
  }
  async invoice(user, id, pdf = false) {
    const patient = await this.patient(user);
    const identity=await this.identity(user);
    const invoice = await this.erp.get('Sales Invoice', id);
    requireValue((invoice.patient === patient.name || identity.customers?.includes(invoice.customer)) && invoice.docstatus === 1, 'Invoice not found', 404);
    if (pdf) return this.erp.request(`/api/method/frappe.utils.print_format.download_pdf?${new URLSearchParams({doctype:'Sales Invoice',name:id,format:'Standard',no_letterhead:'0'})}`, {raw:true});
    return {id: invoice.name, date: invoice.posting_date, currency: invoice.currency, total: invoice.grand_total,
      paymentStatus: invoice.status, outstanding: invoice.outstanding_amount, isReturn: Boolean(invoice.is_return),
      items: invoice.items.map(i => ({name:i.item_name,quantity:i.qty,rate:i.rate,total:i.amount}))};
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
    form.append('is_private','1'); form.append('doctype','Mobile App User'); form.append('docname',identity.erpUser);
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
    requireValue(file.file_url?.startsWith('s3://'), 'ERP S3 upload is not enabled. Please contact the clinic.', 503, 's3_required');
    if (isProfile) {
      // Keep the ERP Desk avatar in sync. Passing modified rejects an overwrite
      // if clinic staff changed this document while the file was uploading.
      // Desk needs an HTTP image URL. This stable ERP route uses the logged-in
      // ERP session to serve the private S3 file; never store an expiring link.
      const image = `/api/method/frappe.handler.download_file?${new URLSearchParams({file_url:file.file_url})}`;
      await this.erp.update('Mobile App User', identity.erpUser,
        {image, ...(parent.modified ? {modified:parent.modified} : {})});
    }
    return {fileId:file.name};
  }
  async file(user, id) {
    const identity = await this.identity(user);
    const file = await this.erp.get('File', id);
    requireValue(file.attached_to_doctype === 'Mobile App User' && file.attached_to_name === identity.erpUser, 'File not found',404);
    requireValue(file.file_url?.startsWith('s3://'), 'File is not available',404);
    const signed = await this.erp.method(this.s3PresignMethod, {file_url:file.file_url,expires:300});
    const url = typeof signed === 'string' ? signed : signed?.url;
    requireValue(url?.startsWith('https://'), 'File is temporarily unavailable',503);
    return {url,expiresIn:300};
  }
  async habits(user) {
    return await this.records.read(user.id,'habits','self') || {data:null,revision:0};
  }
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
      if (!reward) reward = await this.records.write(user.id,'reward',key,{id:key,code:`SIYA${key.slice(0,16).toUpperCase()}`,state:'pending',
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
