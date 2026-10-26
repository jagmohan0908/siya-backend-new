// Recover missing links from the authenticated store identity, never from
// booking/profile request bodies or a customer ID supplied by the app.
export function indianMobile(value) {
  const digits = String(value || '').replace(/[\s()+.-]/g, '');
  const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(national) ? national : null;
}

export async function recoverPatientLink(erp, user, parent, cached, appId) {
  // A removed, previously approved link is not an invitation to relink it.
  if (cached?.patient || (parent.profiles || []).some(row => row.patient_id)) return parent;
  const phone = indianMobile(user.phone);
  if (!phone || indianMobile(parent.phone) !== phone) return parent;
  const variants = [phone, `91${phone}`, `+91${phone}`, `+91 ${phone}`, `91 ${phone}`];
  const matches = await erp.list('Patient', {mobile: ['in', variants]}, ['name', 'mobile'], {limit: 2});
  if (matches.length !== 1 || indianMobile(matches[0].mobile) !== phone) return parent;
  const patient = await erp.get('Patient', matches[0].name);
  if (Number(patient.disabled) === 1 || indianMobile(patient.mobile) !== phone) return parent;

  // Do not attach a patient's records to a second account in the same app.
  // ERP patients may legitimately be shared by the same person across brands;
  // app identities and their profile tables remain separate.
  const accounts = await erp.list('Mobile App User', {phone: ['in', variants]}, ['name', 'external_id'], {limit: 20});
  if (accounts.length === 20) return parent;
  for (const account of accounts) {
    if (account.name === parent.name) continue;
    const sameApp = appId === 'seedfit' ? String(account.external_id).startsWith('seedfit:')
      : /^gid:\/\/shopify\/Customer\/\d+$/.test(account.external_id || '') || /^\d+$/.test(account.external_id || '');
    // Even two currently unlinked accounts are ambiguous. Blocking both also
    // prevents concurrent requests from claiming the same patient.
    if (sameApp) return parent;
  }

  // Reload before writing so concurrent Desk changes are not overwritten.
  const current = await (erp.fresh ? erp.fresh('Mobile App User', parent.name) : erp.get('Mobile App User', parent.name));
  if (current.external_id !== parent.external_id || indianMobile(current.phone) !== phone ||
      (current.profiles || []).some(row => row.patient_id)) return current;
  const profiles = current.profiles || [];
  const eligible = profiles.filter(row => indianMobile(row.phone) === phone);
  if (profiles.length && eligible.length !== 1) return current;
  const linked = eligible.length ? profiles.map(row => row === eligible[0] ? {...row, patient_id: patient.name} : row)
    : [{profile_name: patient.patient_name || user.name || 'My profile', phone: user.phone, patient_id: patient.name}];
  return erp.update('Mobile App User', current.name, {profiles: linked, modified: current.modified});
}
