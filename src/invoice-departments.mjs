// ERP invoice department is the app boundary, independent of patient ownership.
const departments = Object.freeze({
  seedfit: Object.freeze(['Varicocele', 'EDPME', 'Dr health', 'Seed.fit']),
  'siya-ayurveda': Object.freeze([
    'Skin/Fertility/Liver/IBS', 'Siya OPD', 'Arthritis', 'Siya Essentials', 'Siya Ayurveda',
  ]),
});

export const invoiceDepartments = appId => [...(departments[appId] || [])];
export const invoiceDepartmentFilter = appId => ({
  sr_si_patient_department: ['in', invoiceDepartments(appId)],
});
export const invoiceMatchesDepartment = (appId, invoice) =>
  (departments[appId] || []).includes(invoice?.sr_si_patient_department);
