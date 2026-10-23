import {requireValue,text} from './errors.mjs';
import {assessmentApp} from './assessments.mjs';

const statuses={open:'Open',in_progress:'In Progress',waiting_for_customer:'Waiting for Customer',resolved:'Resolved',closed:'Closed'};
const priorities={low:'Low',medium:'Medium',high:'High',urgent:'Urgent'};
const now=()=>new Date(Date.now()+19800000).toISOString().slice(0,23).replace('T',' ');
const iso=value=>value ? /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : value.replace(' ','T')+'+05:30' : null;
const escape=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
export const plain=value=>String(value || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'')
  .replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi,'\n').replace(/<[^>]*>/g,'')
  .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g,m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[m]).trim();
function paging(query={}) {
  const page=Number(query.page || 1),limit=Number(query.limit || 50);
  requireValue(Number.isSafeInteger(page) && page>0 && page<=2000 && Number.isSafeInteger(limit) && limit>0 && limit<=100,'Invalid page');
  return {offset:(page-1)*limit,limit};
}
const ticketDto=d=>({id:d.name,ticket_number:d.ticket_number || d.name,user_id:d.user_id,
  user_name:d.user_name || d.customer_name || '',user_email:d.user_email || d.email || '',user_phone:d.user_phone || d.phone || '',
  subject:d.subject,description:plain(d.description),status:Object.keys(statuses).find(k=>statuses[k]===d.status) || 'open',
  priority:(d.priority || 'Medium').toLowerCase(),category:d.category || '',assigned_to_name:d.assigned_to_name || '',
  created_at:iso(d.creation),updated_at:iso(d.modified),resolved_at:iso(d.resolved_at),closed_at:iso(d.closed_at)});
const messageDto=d=>({id:d.name,ticket_id:d.ticket,sender_type:d.sender_type==='Agent'?'agent':'user',
  sender_id:d.sender_type==='User'?d.sender_id:null,sender_name:d.sender_name || (d.sender_type==='Agent'?'Support team':'You'),
  message:plain(d.message),attachments:[],is_read:!!d.is_read,read_at:iso(d.read_at),
  created_at:iso(d.timestamp || d.creation),updated_at:iso(d.modified)});

export class SupportTickets {
  constructor(service) { this.service=service;this.erp=service.erp; }
  ownerId(user,appId) { return appId==='seedfit'?`seedfit:${user.id}`:user.id; }
  ownerFilter(user,appId) { return appId==='seedfit'?['in',[this.ownerId(user,appId),user.id]]:user.id; }
  async owned(user,appId,id) {
    const app=assessmentApp(appId);
    const doc=await this.erp.get('Support Ticket',id);
    requireValue([user.id,this.ownerId(user,appId)].includes(doc.user_id) && doc.custom_mobile_app===app,'Ticket not found',404);
    return doc;
  }
  async list(user,appId,query={}) {
    const filters={user_id:this.ownerFilter(user,appId),custom_mobile_app:assessmentApp(appId)};
    if(query.status) { requireValue(statuses[query.status],'Invalid status');filters.status=statuses[query.status]; }
    const options=paging(query);
    const rows=await this.erp.list('Support Ticket',filters,['name'],{...options,order:'creation desc, name desc'});
    const items=[];
    for(let i=0;i<rows.length;i+=4) {
      const batch=await Promise.all(rows.slice(i,i+4).map(async row=>
        ticketDto(await this.owned(user,appId,row.name))));
      items.push(...batch);
    }
    return {items};
  }
  async create(user,appId,body) {
    const app=assessmentApp(appId);
    const subject=text(body.subject,140),description=text(body.description,10000);
    requireValue(subject && description,'Subject and description are required');
    const priority=priorities[body.priority || 'medium'];requireValue(priority,'Invalid priority');
    const identity=await this.service.identity(user);
    const parent=await this.erp.get('Mobile App User',identity.erpUser);
    const name=text(body.user_name || parent.full_name || parent.first_name || 'App user',140);
    const email=text(body.user_email || parent.email || '',140),phone=text(body.user_phone || parent.phone || '',40);
    // Match the namespaced Mobile App User identity used by the Frappe inbox.
    const doc=await this.erp.create('Support Ticket',{naming_series:'ST-.YYYY.-',user_id:this.ownerId(user,appId),
      custom_mobile_app:app,custom_mobile_app_user:identity.erpUser,
      customer_name:name,user_name:name,email,user_email:email,phone,user_phone:phone,
      subject,description:escape(description),status:'Open',priority,category:text(body.category || 'General',100)});
    return {ticket:ticketDto(doc)};
  }
  async messages(user,appId,id,query={}) {
    const ticket=await this.owned(user,appId,id);
    const filters={ticket:id};
    if(query.since) {
      const date=new Date(query.since);requireValue(Number.isFinite(date.getTime()),'Invalid message date');
      // Include the boundary second; the app deduplicates by message ID.
      filters.timestamp=['>=',new Date(date.getTime()+19800000).toISOString().slice(0,19).replace('T',' ')];
    }
    const items=await this.erp.list('Support Ticket Message',filters,
      ['name','ticket','sender_type','sender_id','sender_name','message','is_read','read_at','timestamp','creation','modified'],
      {...paging(query),order:query.since?'timestamp asc, creation asc, name asc':'timestamp desc, creation desc, name desc'});
    requireValue(items.every(m=>m.ticket===id),'Ticket messages unavailable',503);
    return {ticket:ticketDto(ticket),messages:items.map(messageDto)};
  }
  async send(user,appId,id,body) {
    const ticket=await this.owned(user,appId,id);
    requireValue(ticket.status!=='Closed','This ticket is closed. Please create a new ticket.',409);
    const message=text(body.message,10000);requireValue(message,'Message is required');
    requireValue(!body.attachments?.length,'Attachments are not supported in mobile ticket chat yet');
    const doc=await this.erp.create('Support Ticket Message',{ticket:id,sender_type:'User',sender_id:user.id,
      sender_name:ticket.user_name || 'App user',message:escape(message),timestamp:now(),is_read:0});
    return {message:messageDto(doc)};
  }
  async close(user,appId,id,body) {
    const doc=await this.owned(user,appId,id);
    requireValue(body.status==='closed','Only closing your own ticket is allowed');
    if(doc.status==='Closed') return {ticket:ticketDto(doc)};
    return {ticket:ticketDto(await this.erp.update('Support Ticket',id,{status:'Closed',closed_at:now(),modified:doc.modified}))};
  }
  async read(user,appId,id,body) {
    await this.owned(user,appId,id);
    requireValue(Array.isArray(body.message_ids) && body.message_ids.length<=100 && body.message_ids.every(i=>typeof i==='string'),'Message IDs are required');
    const rows=[];
    for(const name of new Set(body.message_ids)) {
      const doc=await this.erp.get('Support Ticket Message',name);
      requireValue(doc.ticket===id,'Message not found',404);
      if(doc.sender_type==='Agent' && !doc.is_read) rows.push(doc);
    }
    for(const doc of rows) await this.erp.update('Support Ticket Message',doc.name,{is_read:1,read_at:now(),modified:doc.modified});
    return {ok:true};
  }
}
