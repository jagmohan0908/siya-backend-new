import {createHash, randomBytes} from 'node:crypto';
import {requireValue} from './errors.mjs';

const day = 86_400_000;
const ledger = '@app-sessions';
const tokenPattern = /^ma1\.[a-f0-9]{64}$/;
const key = token => createHash('sha256').update(token).digest('hex');

// Shopify verifies the existing login exchange once. ERP requests subsequently
// use an opaque app session, independent of checkout-side Shopify token changes.
// Only a digest is stored in ERP; neither phone nor an account ID is a credential.
export class AppSessions {
  constructor({records, queue, appId, now = () => Date.now()}) {
    Object.assign(this, {records, queue, appId, now});
  }
  isSession(header) { return /^Bearer ma1\./.test(header || ''); }
  token(header) {
    const token = /^Bearer (\S+)$/.exec(header || '')?.[1];
    requireValue(tokenPattern.test(token || ''), 'Please sign in again', 401, 'unauthenticated');
    return token;
  }
  async issue(user, erpUser = null) {
    requireValue(typeof user?.id === 'string' && user.id.length > 0, 'Please sign in again', 401, 'unauthenticated');
    const token = `ma1.${randomBytes(32).toString('hex')}`;
    const now = this.now();
    const identity = Object.fromEntries(['id','phone','email','name'].map(field => [field, String(user[field] || '')]));
    const data = {appId:this.appId, user:identity, erpUser, issuedAt:now, lastSeenAt:now,
      expiresAt:now + 30*day, absoluteExpiresAt:now + 180*day, revoked:false};
    await this.records.write(ledger, 'app-session', key(token), data, 0);
    return {token, accountId:identity.id, expiresAt:new Date(data.expiresAt).toISOString()};
  }
  async use(header, revoke = false) {
    const token = this.token(header);
    return this.queue.run(`app-session:${key(token)}`, async () => {
      const record = await this.records.read(ledger, 'app-session', key(token));
      const data = record?.data, now = this.now();
      requireValue(data && data.appId === this.appId && data.user?.id && !data.revoked &&
        Number.isFinite(data.expiresAt) && Number.isFinite(data.absoluteExpiresAt) &&
        now < data.expiresAt && now < data.absoluteExpiresAt,
        'Please sign in again', 401, 'unauthenticated');
      if (data.erpUser && !revoke) {
        const parent = await this.records.erp.get('Mobile App User',data.erpUser);
        const ids = this.appId === 'siya-ayurveda' ? [data.user.id,data.user.id.split('/').at(-1)]
          : [`${this.appId}:${data.user.id}`];
        requireValue(ids.includes(parent.external_id) && Number(parent.is_active ?? 1) === 1,
          'This app account is not available. Please contact support.',403,'account_unavailable');
      }
      // Idle expiry extends once daily; the absolute lifetime remains bounded.
      if (revoke || now - data.lastSeenAt >= day) {
        await this.records.write(ledger, 'app-session', key(token), {...data,
          revoked:revoke, lastSeenAt:now, expiresAt:Math.min(now + 30*day, data.absoluteExpiresAt)}, record.revision);
      }
      return {...data.user};
    });
  }
}
