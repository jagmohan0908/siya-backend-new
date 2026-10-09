const value = (...values) => values.find(v => v !== false && v !== null && v !== undefined && String(v).trim() !== '') || '';
const secureUrl = url => {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : ''; }
  catch { return ''; }
};

export function trackingSummary(invoice, shipment) {
  const number = value(shipment?.shipkia_awb_number,invoice.si_shipkia_awb_number);
  const status = value(shipment?.shipkia_status,invoice.si_shipkia_status,invoice.si_shipkia_shipment_status);
  if (!shipment && !number && !status) return null;
  return {
    number, status, courier:value(shipment?.delivery_partner,invoice.si_shipkia_delivery_partner),
    estimatedDelivery:value(shipment?.shipkia_estimated_delivery,invoice.si_shipkia_estimated_delivery),
    deliveredOn:value(shipment?.shipkia_delivered_on,invoice.si_shipkia_delivered_on),
    updatedAt:value(shipment?.last_synced_on),
    url:secureUrl(invoice.si_shipkia_tracking_url),
    events:(shipment?.events || []).map(e=>({date:e.date_time,status:e.status,detail:e.detail,location:e.location}))
      .sort((a,b)=>String(b.date || '').localeCompare(String(a.date || ''))),
  };
}

export async function orderDetails(invoice, patient, productImage, tracking = null, kit = null) {
  const invoicePatient = invoice.patient === patient?.name;
  return {
    id:invoice.name,documentType:invoice.doctype || 'Sales Invoice',kit,
    date:invoice.posting_date || invoice.transaction_date,currency:invoice.currency,total:invoice.grand_total,
    subtotal:invoice.net_total ?? invoice.total,taxes:invoice.total_taxes_and_charges || 0,
    discount:invoice.discount_amount || 0,rounding:invoice.rounding_adjustment || 0,
    paymentStatus:invoice.doctype === 'Sales Order' ? 'Awaiting invoice' : invoice.status,
    outstanding:invoice.outstanding_amount,isReturn:Boolean(invoice.is_return),returnAgainst:invoice.return_against,
    source:invoice.sr_si_order_source,deliveryStatus:tracking?.status || undefined,trackingNumber:tracking?.number || undefined,
    patient:{name:value(invoice.patient_name,invoicePatient && patient.patient_name),
      id:value(invoice.sr_si_patient_id,invoicePatient && patient.sr_patient_id,invoice.patient),
      recordId:invoice.patient || '',phone:value(invoice.contact_mobile,invoice.sr_si_mobile,invoicePatient && patient.mobile)},
    items:await Promise.all((invoice.items || []).map(async item=>({code:item.item_code,name:item.item_name || item.item_code,
      quantity:item.qty,unit:item.uom,rate:item.rate,total:item.amount,imageUrl:await productImage(item)}))),
    tracking,
  };
}
