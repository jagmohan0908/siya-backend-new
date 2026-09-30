export class ApiError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, {status, code}); }
}
export function requireValue(condition, message, status = 400, code = 'invalid_request') {
  if (!condition) throw new ApiError(status, code, message);
}
export function object(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
  return value;
}
export function text(value, max = 500) {
  requireValue(typeof value === 'string' && value.length <= max, 'Invalid text value');
  return value.trim();
}
