import {ApiError} from './errors.mjs';

export class Erp {
  constructor({url, token, fetcher = fetch}) {
    this.url = url.replace(/\/$/, ''); this.token = token; this.fetcher = fetcher;
    this.isNgrok = new URL(this.url).hostname.endsWith('.ngrok-free.dev');
  }
  async request(path, {method = 'GET', body, raw = false, timeoutMs = 25000} = {}) {
    const response = await this.fetcher(`${this.url}${path}`, {
      method, headers: {Authorization: `token ${this.token}`, ...(this.isNgrok ? {'ngrok-skip-browser-warning':'1'} : {}), ...(body instanceof FormData ? {} : {'Content-Type': 'application/json'})},
      body: body == null ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) {
      // Never relay ERP stack traces, request bodies or credentials to the app.
      const error = await response.json().catch(() => ({}));
      if (error.exc_type === 'TimestampMismatchError' || error.exc_type === 'DuplicateEntryError') {
        throw new ApiError(409,'revision_conflict','This record changed. Refresh and try again.');
      }
      const status = response.status === 404 ? 404 : response.status === 409 ? 409 : response.status === 413 ? 413 : 502;
      throw new ApiError(status, 'erp_request_failed', response.status === 413 ? 'Image is too large. Please choose a smaller image.' : `ERP could not complete the request (${response.status})`);
    }
    if (raw) return response;
    const result = await response.json();
    return result.data ?? result.message;
  }
  method(name, args = {}, write = false) {
    const path = `/api/method/${name}`;
    return write ? this.request(path, {method: 'POST', body: args}) : this.request(`${path}?${new URLSearchParams(args)}`);
  }
  list(type, filters = {}, fields = ['name'], {offset = 0, limit = 50, order = 'creation desc', orFilters} = {}) {
    return this.request(`/api/resource/${encodeURIComponent(type)}?${new URLSearchParams({
      filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_start: String(offset),
      limit_page_length: String(limit), order_by: order,
      ...(orFilters ? {or_filters:JSON.stringify(orFilters)} : {}),
    })}`);
  }
  get(type, name) { return this.request(`/api/resource/${encodeURIComponent(type)}/${encodeURIComponent(name)}`); }
  create(type, data) { return this.request(`/api/resource/${encodeURIComponent(type)}`, {method: 'POST', body: data}); }
  update(type, name, data) { return this.request(`/api/resource/${encodeURIComponent(type)}/${encodeURIComponent(name)}`, {method: 'PUT', body: data}); }
  async maybe(type, name) {
    try { return await this.get(type, name); } catch (e) { if (e.status === 404) return null; throw e; }
  }
}
