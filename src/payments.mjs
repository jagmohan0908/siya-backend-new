import {requireValue} from './errors.mjs';
export class Razorpay {
  constructor({keyId,keySecret,fetcher=fetch}) { Object.assign(this,{keyId,keySecret,fetcher}); }
  async request(path,body) {
    requireValue(this.keyId && this.keySecret,'Payments are temporarily unavailable. No payment was taken.',503,'payment_setup_required');
    const response=await this.fetcher(`https://api.razorpay.com/v1/${path}`,{
      method:body?'POST':'GET',headers:{Authorization:`Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000),redirect:'error'});
    requireValue(response.ok,'Payment could not be verified. Please contact the clinic before paying again.',503,'payment_verification_pending');
    return response.json();
  }
  async create(user,appointment) {
    return this.request('orders',{amount:Math.round(appointment.consultationFee*100),currency:'INR',receipt:appointment.id.slice(0,40),
      notes:{mobile_account:user.id,appointment_id:appointment.id}});
  }
  async verify(user,appointment,paymentId) {
    requireValue(/^pay_[a-zA-Z0-9]+$/.test(paymentId || ''),'Payment reference is required');
    const payment=await this.request(`payments/${paymentId}`);
    const order=await this.request(`orders/${appointment.paymentOrderId}`);
    requireValue(payment.order_id===appointment.paymentOrderId && payment.amount===Math.round(appointment.consultationFee*100) && payment.currency==='INR'
      && payment.status==='captured' && !payment.amount_refunded && order.notes?.mobile_account===user.id && order.notes?.appointment_id===appointment.id,
      'Payment is not confirmed for this appointment. Please contact the clinic.',409,'payment_not_verified');
    return payment;
  }
}
