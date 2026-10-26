import {randomBytes, createHmac, timingSafeEqual} from 'node:crypto';
import {requireValue} from './errors.mjs';

export const checkoutAttribute = '_mobile_checkout_reference';
const ledger = '@checkout-tracking';
const tokenPattern = /^[a-f0-9]{64}$/;
const orderId = value => (typeof value !== 'number' || Number.isSafeInteger(value)) && /^\d{1,20}$/.test(String(value ?? '')) ? String(value) : '';
const appBrands = {'siya-ayurveda':'Siya Ayurveda',seedfit:'Seedfit'};

// These records authorize purchases only. Never use them to select a Patient.
export class CheckoutTracking {
  constructor(service, {domain = '', secret = '', enabled = false, now = () => Date.now()} = {}) {
    Object.assign(this, {service, domain:domain.toLowerCase(), secret, enabled, now});
    this.records = service.records;
  }
  async begin(user, body) {
    // Explicit rollout flag: an unconfigured deployment preserves existing checkout.
    if (!this.enabled) return {enabled:false};
    requireValue(this.secret && this.domain,'Order tracking is not configured',503,'checkout_tracking_unavailable');
    requireValue(Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 100,'Invalid cart');
    const items = {};
    for (const item of body.items) {
      const id = orderId(item.variantId);
      requireValue(id && Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 1000,'Invalid cart item');
      items[id] = (items[id] || 0) + item.quantity;
    }
    const reference = randomBytes(32).toString('hex');
    await this.records.write(ledger,'checkout-intent',reference,{
      account:user.id,appId:this.service.appId,items,createdAt:this.now(),expiresAt:this.now()+86400000,
    },0);
    return {enabled:true,attributes:{[checkoutAttribute]:reference}};
  }
  verify(raw, headers) {
    requireValue(this.secret && this.domain,'Order tracking is not configured',503,'checkout_tracking_unavailable');
    const signature = String(headers['x-shopify-hmac-sha256'] || '');
    const expected = createHmac('sha256',this.secret).update(raw).digest();
    const actual = Buffer.from(signature,'base64');
    requireValue(actual.length === expected.length && timingSafeEqual(actual,expected),'Invalid order notification',401,'invalid_webhook');
    requireValue(headers['x-shopify-shop-domain']?.toLowerCase() === this.domain &&
      headers['x-shopify-topic'] === 'orders/create','Invalid order notification',401,'invalid_webhook');
    let order;
    try { order=JSON.parse(raw.toString('utf8')); } catch { requireValue(false,'Invalid JSON'); }
    requireValue(order && typeof order === 'object' && !Array.isArray(order),'Invalid order notification');
    return order;
  }
  async receive(raw, headers) {
    const order = this.verify(raw,headers);
    const references = [...new Set([
      ...(Array.isArray(order.note_attributes) ? order.note_attributes : []),
      ...(Array.isArray(order.line_items) ? order.line_items.flatMap(item=>Array.isArray(item.properties) ? item.properties : []) : []),
    ].filter(item=>item?.name === checkoutAttribute).map(item=>item.value))];
    if (!references.length) return {ok:true,tracked:false};
    requireValue(references.length === 1 && tokenPattern.test(references[0]),'Invalid checkout reference',400,'invalid_checkout_reference');
    const reference=references[0], id=orderId(order.id);
    requireValue(id,'Invalid order ID');
    // Queue both deliveries and app reads under the authenticated intent owner.
    const found = await this.records.read(ledger,'checkout-intent',reference);
    requireValue(found?.data?.account && found.data.appId === this.service.appId,'Unknown checkout reference',400,'invalid_checkout_reference');
    return this.service.queue.run(found.data.account,async()=>{
      const intent = await this.records.read(ledger,'checkout-intent',reference);
      const data = intent.data, created = Date.parse(order.created_at);
      requireValue(Number.isFinite(created) && created >= data.createdAt-60000 && created <= data.expiresAt,
        'Order is outside this checkout session',400,'invalid_checkout_reference');
      requireValue(!data.orderId || data.orderId === id,'Checkout already belongs to another order',409,'checkout_already_used');
      const actual = {};
      for (const item of order.line_items || []) {
        const variant=orderId(item.variant_id);
        if (variant && Number.isSafeInteger(item.quantity) && item.quantity > 0) actual[variant]=(actual[variant] || 0)+item.quantity;
      }
      requireValue(Object.entries(data.items).every(([variant,quantity])=>actual[variant] === quantity),
        'Order does not match this checkout',400,'checkout_cart_mismatch');
      // The global claim prevents a second intent/account claiming the same order.
      const claim = await this.records.read(ledger,'checkout-order',id);
      requireValue(!claim || claim.data.account === data.account && claim.data.reference === reference,
        'Order already belongs to another checkout',409,'order_already_claimed');
      if (!claim) await this.records.write(ledger,'checkout-order',id,{account:data.account,reference},0);
      if (!data.orderId) await this.records.write(ledger,'checkout-intent',reference,{...data,orderId:id},intent.revision);
      const grant=await this.records.read(data.account,'order-owner',id);
      if (!grant) await this.records.write(data.account,'order-owner',id,{
        orderId:id,appId:this.service.appId,shopDomain:this.domain,createdAt:order.created_at,
      },0);
      return {ok:true,tracked:true};
    });
  }
  valid(grant) {
    return grant?.appId === this.service.appId && grant.shopDomain === this.domain && orderId(grant.orderId);
  }
  async ids(user) {
    const ids=[];
    for (let offset=0;;offset+=50) {
      const rows=await this.records.list(user.id,'order-owner',offset);
      ids.push(...rows.map(row=>this.valid(row.data)).filter(Boolean));
      if (rows.length < 50) break;
    }
    return [...new Set(ids)];
  }
  brandMatches(invoice) {
    return !invoice.custom_app_brand || invoice.custom_app_brand === appBrands[this.service.appId];
  }
  async owns(user, invoice) {
    const id=orderId(invoice.shopify_order_id);
    if (!id || !this.brandMatches(invoice)) return false;
    return Boolean(this.valid((await this.records.read(user.id,'order-owner',id))?.data));
  }
}
