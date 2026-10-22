// Only fixed route templates and known error classes belong in operational logs.
// Never log raw URLs, query strings, document IDs, bodies, headers or tracebacks.
const apiRoutes = [
  '/', '/health', '/v1/doctors', '/v1/doctors/:id/photo', '/v1/doctors/:id/slots',
  '/v1/review-avatars', '/v1/profile', '/v1/appointments', '/v1/appointment-orders',
  '/v1/appointments/:id/requests', '/v1/treatments', '/v1/diets', '/v1/diets/:id/pdf',
  '/v1/habit-orders', '/v1/habit-tracker', '/v1/habit-prescriptions', '/v1/habits',
  '/v1/files', '/v1/files/:id', '/v1/orders', '/v1/invoices/:id',
  '/v1/invoices/:id/pdf', '/v1/invoices/:id/tracking',
  '/v1/ai-chat/session', '/v1/ai-chat/new-session', '/v1/ai-chat/messages',
  '/v1/ai-chat/escalate', '/v1/support-tickets', '/v1/support-tickets/:id',
  '/v1/support-tickets/:id/messages', '/v1/support-tickets/:id/read',
].map(route => [route, new RegExp('^' + route.replaceAll(':id', '[^/]+') + '$')]);

const doctypes = new Set([
  'Chat Channel Account', 'Chat Contact', 'Chat Conversation', 'Chat Message',
  'Clinic Appointment', 'Diet Chart', 'DocType', 'File', 'Healthcare Practitioner',
  'Item', 'Item Group Template', 'Mobile App Appointment', 'Mobile App User',
  'Patient', 'Patient Encounter', 'Sales Invoice', 'Sales Order', 'Shipment Tracking Shipment',
  'Siya Mobile Record', 'SR Instruction', 'Support Ticket', 'Support Ticket Message',
  'WA Chat Hub Settings',
]);
const methods = new Set([
  'ping', 'upload_file', 'frappe.handler.download_file', 'frappe.utils.print_format.download_pdf',
  'mobile_app.api.appointment_calendar.get_appointment',
  'mobile_app.api.appointment_calendar.update_appointment',
  'mobile_app.api.practitioners.availability', 'mobile_app.api.practitioners.list_doctors',
  'shipment_tracking.api.tracking.get_tracking_ui_settings',
  'shipment_tracking.api.tracking.sync_tracking_for_invoice',
]);
const exceptionTypes = new Set([
  'AuthenticationError', 'PermissionError', 'DoesNotExistError', 'ValidationError',
  'MandatoryError', 'LinkValidationError', 'TimestampMismatchError', 'DuplicateEntryError',
  'OperationalError', 'ProgrammingError', 'InternalError', 'IntegrityError',
  'QueryTimeoutError', 'QueryDeadlockError', 'DataError', 'DataTooLongError',
  'ModuleNotFoundError', 'ImportError', 'AttributeError', 'TypeError', 'ValueError', 'KeyError',
  'NameError', 'NotFound', 'RequestTokenExpiredError', 'SessionExpired', 'RateLimitExceededError',
]);

function pathname(value) {
  try { return new URL(value, 'https://diagnostic.invalid').pathname; }
  catch { return ''; }
}
export function apiRoute(value) {
  const path = pathname(value);
  return apiRoutes.find(([, pattern]) => pattern.test(path))?.[0] ?? 'unmatched';
}
export function erpRoute(value) {
  const parts = pathname(value).split('/').filter(Boolean);
  if (parts[0] !== 'api') return 'other';
  if (parts[1] === 'resource') {
    let type;
    try { type = decodeURIComponent(parts[2] || ''); } catch { return '/api/resource/:doctype'; }
    return '/api/resource/' + (doctypes.has(type) ? type : ':doctype') + (parts.length > 3 ? '/:name' : '');
  }
  if (parts[1] === 'method') {
    return '/api/method/' + (parts.length === 3 && methods.has(parts[2]) ? parts[2] : ':method');
  }
  return 'other';
}
export function httpMethod(value) {
  return ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(value) ? value : 'OTHER';
}
export function erpFailureDetails(path, method, status, exceptionType) {
  return {
    erp_route: erpRoute(path), erp_method: httpMethod(method),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? {upstream_status:status} : {}),
    upstream_exception: exceptionTypes.has(exceptionType) ? exceptionType : 'Unknown',
  };
}
export function erpTransportDetails(path, method, error) {
  return {erp_route:erpRoute(path), erp_method:httpMethod(method),
    upstream_failure:['TimeoutError','AbortError'].includes(error?.name) ? 'timeout' : 'network'};
}
