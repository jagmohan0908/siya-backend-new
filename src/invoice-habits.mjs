import {requireValue} from './errors.mjs';
import {assessmentApp} from './assessments.mjs';
import {invoiceKit} from './invoice-kit.mjs';

export const habitDay = () => new Intl.DateTimeFormat('en-CA', {
  timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',
}).format(new Date());

async function all(erp,type,filters,fields) {
  const rows=[];
  for(let offset=0;;offset+=100) {
    const page=await erp.list(type,filters,fields,{offset,limit:100,order:'name asc'});
    rows.push(...page);
    if(page.length<100) return rows;
  }
}

// Clinical tracking never grants access through a different patient's shared customer.
const owns = (doc,patient,identity) => doc.patient === patient.name ||
  (!doc.patient && identity.customers?.includes(doc.customer));

async function invoiceItems(service,doc) {
  const stockQuantity=row=>Number.isFinite(Number(row.stock_qty)) && row.stock_qty != null
    ? Math.abs(Number(row.stock_qty)) : Math.abs(Number(row.qty)) * (Number(row.conversion_factor) || 1);
  const quantities=new Map();
  for(const row of doc.items || []) {
    const qty=Number(row.qty);
    if(!row.item_code || !Number.isFinite(qty) || qty<=0) continue;
    const previous=quantities.get(row.item_code);
    if(previous) previous.quantity+=stockQuantity(row)/previous.factor;
    else quantities.set(row.item_code,{row,quantity:qty,factor:stockQuantity(row)/qty || 1,returned:0});
  }
  const returns=await all(service.erp,'Sales Invoice',{docstatus:1,is_return:1,return_against:doc.name},['name']);
  for(const ref of returns) {
    const credit=await service.erp.get('Sales Invoice',ref.name);
    if(credit.docstatus!==1 || !credit.is_return || credit.return_against!==doc.name) continue;
    for(const row of credit.items || []) {
      const item=quantities.get(row.item_code);
      if(item && Number.isFinite(Number(row.qty))) item.returned+=stockQuantity(row)/item.factor;
    }
  }
  return Promise.all([...quantities.values()].map(async ({row,quantity,returned})=>({
    id:row.item_code,code:row.item_code,name:row.item_name || row.item_code,
    quantity,remainingQuantity:Math.max(0,quantity-returned),unit:row.uom || '',
    canTrack:quantity>returned,imageUrl:await service.productImage(row),
  })));
}

async function summary(service,doc) {
  return {id:doc.name,date:doc.posting_date,paymentStatus:doc.status || '',
    kit:await invoiceKit(service.erp,doc,service.productImage),
    items:await invoiceItems(service,doc)};
}

export async function habitOrders(service,user,appId,offset=0) {
  assessmentApp(appId);
  requireValue(Number.isSafeInteger(offset) && offset>=0 && offset<=100000,'Invalid cursor');
  const patient=await service.patient(user);
  const identity=await service.identity(user);
  const rows=await service.erp.list('Sales Invoice',
    identity.customers?.length ? {docstatus:1,is_return:0} : {patient:patient.name,docstatus:1,is_return:0},
    ['name'],{offset,limit:21,order:'posting_date desc, name desc',
      ...(identity.customers?.length ? {orFilters:[['patient','=',patient.name],['customer','in',identity.customers]]} : {})});
  const items=[];
  for(let i=0;i<Math.min(rows.length,20);i+=4) {
    const batch=await Promise.all(rows.slice(i,Math.min(i+4,20)).map(async row=>{
      const doc=await service.erp.get('Sales Invoice',row.name);
      return doc.docstatus===1 && !doc.is_return && owns(doc,patient,identity) ? summary(service,doc) : null;
    }));
    items.push(...batch.filter(Boolean));
  }
  return {items,nextCursor:rows.length>20?offset+20:null};
}

// Display only actual prescription data; never infer a diagnosis, dose or doctor.
export async function habitPrescriptions(service,user,appId) {
  assessmentApp(appId);
  const patient=await service.patient(user);
  const refs=await all(service.erp,'Patient Encounter',{patient:patient.name,docstatus:['<',2]},['name']);
  const prescriptions=[];
  const instructions=new Map();
  const instruction=async name=>{
    if(!name) return '';
    if(!instructions.has(name)) instructions.set(name,service.erp.get('SR Instruction',name)
      .then(doc=>doc.sr_description || doc.sr_title || name));
    return instructions.get(name);
  };
  for(const ref of refs) {
    const doc=await service.erp.get('Patient Encounter',ref.name);
    if(doc.patient!==patient.name || doc.docstatus===2 || doc.custom_appointment_status==='Cancelled') continue;
    const groups=[];
    for(const [field,label,prefix] of [
      ['drug_prescription','Prescription','sr_ayurvedic'],
      ['sr_allopathy_drug_prescription','Allopathy','sr_allopathy'],
      ['sr_homeopathy_drug_prescription','Homeopathy','sr_homeopathy'],
    ]) {
      const rows=(doc[field] || []).filter(r=>r.drug_code || r.drug_name || r.medication || r.sr_medication_name_print);
      if(!rows.length) continue;
      groups.push({label,practitioner:doc[`${prefix}_practitioner_name`] || doc[`${prefix}_practitioner`] ||
        doc.practitioner_name || doc.practitioner || doc.pe_practitioner || '',
        registration:doc[`${prefix}_practitioner_reg`] || '',
        items:await Promise.all(rows.map(async r=>({
          name:r.sr_medication_name_print || r.drug_name || r.medication || r.drug_code,
          code:r.drug_code || '',dosage:r.dosage || '',duration:r.period || '',
          interval:r.dosage_by_interval && r.interval ? `${r.interval} ${r.interval_uom || ''}`.trim() : '',
          instructions:await instruction(r.sr_drug_instruction),comment:r.comment || '',
          imageUrl:await service.productImage({item_code:r.drug_code,item_name:r.drug_name}),
        })))});
    }
    if(groups.length) prescriptions.push({id:doc.name,date:doc.encounter_date,
      patientName:patient.patient_name || '',patientGender:patient.sex || '',
      diagnosis:(doc.diagnosis || []).map(r=>r.diagnosis).filter(Boolean).join(', '),
      groups,instructions:doc.sr_pe_instruction || ''});
  }
  return {items:prescriptions.sort((a,b)=>String(b.date).localeCompare(String(a.date)))};
}
