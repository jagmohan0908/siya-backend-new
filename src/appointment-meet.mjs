import {ApiError, requireValue} from './errors.mjs';

// Existing Google Apps Script deployment used by Siya's original app.
export const existingMeetScriptUrl = 'https://script.google.com/macros/s/AKfycby5PebObNPnBhkmHsp7wPVa57ocYGxGKzMmzVB4kZ8AETc-MiNMbsXdzeCy933HwFdj/exec';

export function realMeetLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'meet.google.com' &&
      !url.username && !url.password && !url.port && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname)
      ? url.href : null;
  } catch { return null; }
}

export class AppsScriptMeet {
  constructor({url = existingMeetScriptUrl, fetcher = fetch} = {}) {
    Object.assign(this,{url,fetcher});
  }
  get configured() { return Boolean(this.url); }
  async create(data) {
    const start = new Date(`${data.appointmentDate}T${data.time}+05:30`);
    requireValue(Number.isFinite(start.getTime()),'Invalid meeting date.',400,'meet_date_invalid');
    const date = new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'Asia/Kolkata'}).format(start);
    const time = new Intl.DateTimeFormat('en-US',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Kolkata'}).format(start);
    let url = new URL(this.url);
    requireValue(url.protocol === 'https:' && url.hostname === 'script.google.com' && !url.username && !url.password && !url.port,
      'Configure the Google Meet Apps Script URL.',503,'meet_setup_required');
    let method = 'POST';
    const body = JSON.stringify({id:data.id,appointmentDate:date,timeSlot:time,
      patientName:data.patientName,doctorName:data.doctorName});
    const signal = AbortSignal.timeout(20000);
    for (let redirects=0;redirects<4;redirects++) {
      const response = await this.fetcher(url.href,{method,redirect:'manual',signal,
        ...(method === 'POST' ? {headers:{'Content-Type':'application/json'},body} : {})});
      if ([301,302,303].includes(response.status)) {
        const location = response.headers.get('location');
        requireValue(location,'Meet service returned an invalid redirect.',503,'meet_provider_unavailable');
        url = new URL(location,url);
        requireValue(url.protocol === 'https:' && ['script.google.com','script.googleusercontent.com'].includes(url.hostname)
          && !url.username && !url.password && !url.port,'Meet service redirected outside Google.',503,'meet_provider_unavailable');
        // Apps Script serves the POST result through a GET redirect. Never POST again.
        method = 'GET';
        continue;
      }
      requireValue(response.ok,'The Meet service did not complete the request.',503,'meet_provider_unavailable');
      const result = await response.json().catch(()=>null);
      const link = result?.status === 'success' ? realMeetLink(result.meetingLink) : null;
      requireValue(link,'The Meet service did not return a valid meeting link.',503,'meet_provider_unavailable');
      return link;
    }
    throw new ApiError(503,'meet_provider_unavailable','The Meet service redirected too many times.');
  }
}

// The legacy script has no verified idempotency/lookup contract. Persist intent
// before POST; an ambiguous timeout is never automatically replayed.
export async function prepareAppointmentMeet(service,user,data,encounter,reservation) {
  if (!service.meetings || data.consultationType !== 'video' || data.status !== 'confirmed' ||
      !['Confirmed','Rescheduled'].includes(reservation.status) ||
      !(data.consultationFee === 0 ? data.paymentStatus === 'free' : data.paymentStatus === 'paid')) return data;
  requireValue(reservation.booking_id === data.id && String(reservation.appointment_date).slice(0,10) === data.appointmentDate &&
    String(reservation.appointment_time).slice(0,5) === data.time.slice(0,5),
    'Appointment details changed. Refresh before creating the meeting.',409,'unverified_reservation');
  const existing = realMeetLink(encounter?.google_meet_link);
  if (encounter) requireValue(encounter.docstatus !== 2 && encounter.sr_encounter_place === 'Online' &&
    (encounter.pe_practitioner || encounter.practitioner) === data.doctorId &&
    (!data.erpPatientId || encounter.patient === data.erpPatientId) &&
    (!encounter.pe_appointment_date || String(encounter.pe_appointment_date).slice(0,10) === data.appointmentDate) &&
    (!encounter.pe_appointment_time || String(encounter.pe_appointment_time).slice(0,5) === data.time.slice(0,5)) &&
    (encounter.sr_notes || '').split(/\r?\n/).some(line => line.trim() === `External appointment ID: ${data.id}`) &&
    reservation.patient_encounter === encounter.name,
    'Clinic appointment does not match this booking.',409,'unverified_encounter');
  let journal = await service.records.read(user.id,'appointment_meet',data.id);
  if (encounter && !existing && journal?.data.state === 'synced') {
    return {...data,meetingLink:null,meetingState:'needs_review'};
  }
  let link = existing || realMeetLink(journal?.data.link);
  if (!link) {
    if (journal) return {...data,meetingLink:null,meetingState:'needs_review'};
    if (!service.meetings.configured) return {...data,meetingLink:null,meetingState:'setup_required'};
    if (new Date(`${data.appointmentDate}T${data.time}+05:30`).getTime() <= Date.now()) return data;
    journal = await service.records.write(user.id,'appointment_meet',data.id,{
      state:'requested',requestedAt:new Date().toISOString(),reservation:reservation.name,
    },0);
    try {
      link = await service.meetings.create(data);
      requireValue(realMeetLink(link),'Invalid meeting link.',503,'meet_provider_unavailable');
      journal = await service.records.write(user.id,'appointment_meet',data.id,{
        ...journal.data,link,state:'generated',
      },journal.revision);
    } catch {
      return {...data,meetingLink:null,meetingState:'needs_review'};
    }
  }
  try {
    // ERP remains the source the app reads. Do not return the provider result
    // until the saved document has been read back successfully.
    if (encounter && encounter.google_meet_link !== link) {
      await service.erp.update('Patient Encounter',encounter.name,{google_meet_link:link,modified:encounter.modified});
      encounter = await service.erp.get('Patient Encounter',encounter.name);
      requireValue(encounter.google_meet_link === link,'Meeting save is pending.',503,'meet_save_pending');
    }
    if (reservation.consultation_type !== link || reservation.google_meet_link !== link || Number(reservation.is_online) !== 1) {
      const current = await service.bookingReservation(user,data);
      await service.erp.update('Mobile App Appointment',reservation.name,{
        consultation_type:link,is_online:1,google_meet_link:link,modified:current.modified,
      });
    }
    const saved = await service.bookingReservation(user,data);
    requireValue(saved.google_meet_link === link && Number(saved.is_online) === 1,
      'Meeting save is pending.',503,'meet_save_pending');
    const state = encounter ? 'synced' : 'reservation_saved';
    if (journal && (journal.data.state !== state || journal.data.link !== link)) {
      await service.records.write(user.id,'appointment_meet',data.id,{...journal.data,link,state},journal.revision);
    }
    return {...data,meetingLink:encounter ? encounter.google_meet_link : saved.google_meet_link,meetingState:'ready'};
  } catch {
    return {...data,meetingLink:null,meetingState:'saving'};
  }
}
