import {createHash} from 'node:crypto';
import {requireValue} from './errors.mjs';

export const recordName = (account, kind, key) => createHash('sha256').update(JSON.stringify([account, kind, key])).digest('hex');
export class Records {
  constructor(erp) { this.erp = erp; }
  async read(account, kind, key) {
    const doc = await this.erp.maybe('Siya Mobile Record', recordName(account, kind, key));
    if (!doc) return null;
    requireValue(doc.account === account && doc.kind === kind, 'Record not found', 404);
    return {data: JSON.parse(doc.payload || '{}'), revision: Number(doc.revision || 0), modified: doc.modified};
  }
  async write(account, kind, key, data, revision) {
    const name = recordName(account, kind, key);
    const old = await this.read(account, kind, key);
    requireValue(revision === (old?.revision || 0), 'This record changed on another device. Refresh and try again.', 409, 'revision_conflict');
    const fields = {record_key: name, account, kind, payload: JSON.stringify(data), revision: revision + 1};
    if (old) await this.erp.update('Siya Mobile Record', name, {...fields, modified: old.modified});
    else await this.erp.create('Siya Mobile Record', fields);
    return {data, revision: revision + 1};
  }
  async list(account, kind, offset = 0) {
    const rows = await this.erp.list('Siya Mobile Record', {account, kind}, ['name', 'payload', 'revision'], {offset, limit: 50});
    return rows.map(row => ({data: JSON.parse(row.payload), revision: row.revision}));
  }
}

// Serialize writes for one authenticated customer. Run one API process (documented).
export class SerialQueue {
  constructor() { this.pending = new Map(); }
  async run(key, action) {
    const previous = this.pending.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.pending.set(key, next);
    try { return await next; } finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }
}
