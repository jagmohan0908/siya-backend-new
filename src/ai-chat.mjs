import {createHash} from 'node:crypto';
import {requireValue,text} from './errors.mjs';
import {assessmentApp} from './assessments.mjs';
import {recordName} from './store.mjs';

const channels={'siya-ayurveda':'Siya Ayurveda Patient App',seedfit:'Seedfit Patient App'};
// Matches WA Chat Hub mobile_account_identity.identity_key, including Python's ensure_ascii.
export const mobileContactKey=(account,user,profile)=>createHash('sha256')
  .update(JSON.stringify([account,user,profile]).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))).digest('hex');
const visible=['Inbound','Outbound'];
const fields=['name','conversation','direction','sender_type','content_type','body','media_url','delivery_status','creation'];
const dto=r=>({id:String(r.name),sender_type:r.sender_type || (r.direction==='Inbound'?'Customer':'Agent'),
  content_type:r.content_type || 'Text',message:r.body || '',media_url:r.media_url || '',
  delivery_status:r.delivery_status || '',created_at:r.creation,cards:[]});

export class AiChat {
  constructor(service) { this.service=service;this.erp=service.erp; }
  async context(user,appId) {
    assessmentApp(appId);
    const identity=await this.service.identity(user);
    const parent=await this.erp.get('Mobile App User',identity.erpUser);
    requireValue(Number(parent.is_active)===1,'Your app account is inactive',403);
    const profiles=parent.profiles || [];
    requireValue(profiles.length<=1,'Please select a patient profile with the care team before using chat.',409,'chat_profile_required');
    const profile=String(profiles[0]?.name || '');
    const account=await this.erp.get('Chat Channel Account',channels[appId]);
    requireValue(account.channel_type==='Mobile App' && Number(account.is_active)===1,'AI chat is temporarily unavailable.',503);
    const key=mobileContactKey(account.name,parent.name,profile);
    return {parent,account,profile,key,contactName:'mobile-'+key};
  }
  async contact(ctx) {
    let contact=await this.erp.maybe('Chat Contact',ctx.contactName);
    if(!contact) {
      try { contact=await this.erp.create('Chat Contact',{
        mobile_account_key:ctx.key,mobile_channel_account:ctx.account.name,
        mobile_app_user:ctx.parent.name,mobile_profile_id:ctx.profile,
        display_name:ctx.parent.full_name || 'App user',
        // Mobile account identity has no routable phone and does not verify a Patient.
      }); } catch(error) {
        contact=await this.erp.maybe('Chat Contact',ctx.contactName);if(!contact)throw error;
      }
    }
    this.assertContact(contact,ctx);return contact;
  }
  assertContact(contact,ctx) {
    requireValue(String(contact.name)===ctx.contactName && contact.mobile_account_key===ctx.key &&
      contact.mobile_channel_account===ctx.account.name && contact.mobile_app_user===ctx.parent.name &&
      (contact.mobile_profile_id || '')===ctx.profile && !contact.phone_number,'Chat not found',404);
  }
  async owned(id,ctx) {
    // Dev masks contact references in document responses. Verify membership with
    // an exact server-side filter using the authenticated account's known key.
    const matches=await this.erp.list('Chat Conversation',{name:String(id),channel_account:ctx.account.name,contact:ctx.contactName},['name'],{limit:1});
    requireValue(matches.length===1,'Chat not found',404);
    const convo=await this.erp.get('Chat Conversation',id);
    requireValue(convo.channel_account===ctx.account.name,'Chat not found',404);
    this.assertContact(await this.erp.get('Chat Contact',ctx.contactName),ctx);return convo;
  }
  async messages(convo,after) {
    const filters={conversation:String(convo.name),direction:['in',visible]};
    let cursor;
    if(after) {
      cursor=await this.erp.get('Chat Message',after);
      requireValue(String(cursor.conversation)===String(convo.name) && visible.includes(cursor.direction),'Message not found',404);
      filters.creation=['>=',cursor.creation];
    }
    const rows=await this.erp.list('Chat Message',filters,fields,{limit:200,order:after?'creation asc, name asc':'creation desc, name desc'});
    requireValue(rows.every(r=>String(r.conversation)===String(convo.name) && visible.includes(r.direction)),'Unexpected chat response',502);
    const sorted=after?rows:rows.reverse();
    // Include the cursor's timestamp boundary; the app deduplicates message IDs.
    return sorted.filter(r=>String(r.name)!==String(cursor?.name)).map(dto);
  }
  async payload(convo,after) {
    const settings=await this.erp.get('WA Chat Hub Settings','WA Chat Hub Settings');
    return {conversation_id:String(convo.name),status:convo.status,identity_status:convo.identity_status || 'Unverified',
      profile_required:false,ai_ready:!!(settings.enable_ai_autopilot && settings.autopilot_mode==='Limited Auto Reply' && settings.service_user),
      messages:await this.messages(convo,after)};
  }
  async call(user,appId,action,body={}) {
    requireValue(['open_session','new_session','get_messages','send_message','escalate'].includes(action),'Invalid AI action');
    const ctx=await this.context(user,appId);
    if(action==='open_session') {
      await this.contact(ctx);
      const rows=await this.erp.list('Chat Conversation',{channel_account:ctx.account.name,contact:ctx.contactName},['name'],{limit:1,order:'creation desc, name desc'});
      const convo=rows.length?await this.owned(rows[0].name,ctx):await this.erp.create('Chat Conversation',{
        channel_account:ctx.account.name,contact:ctx.contactName,status:'Open'});
      return {data:await this.payload(convo)};
    }
    const id=text(body.conversation,140);requireValue(id,'Conversation is required');
    const convo=await this.owned(id,ctx);
    if(action==='get_messages')return {data:await this.payload(convo,body.after?text(body.after,140):undefined)};
    if(action==='new_session') {
      const rows=await this.erp.list('Chat Conversation',{custom_mobile_previous_chat:id,channel_account:ctx.account.name,contact:ctx.contactName},['name'],{limit:1});
      let fresh;
      if(rows.length) fresh=await this.owned(rows[0].name,ctx);
      else try {fresh=await this.erp.create('Chat Conversation',{
        channel_account:ctx.account.name,contact:ctx.contactName,status:'Open',custom_mobile_previous_chat:id});
      } catch(error) {
        const retry=await this.erp.list('Chat Conversation',{custom_mobile_previous_chat:id,channel_account:ctx.account.name,contact:ctx.contactName},['name'],{limit:1});
        if(!retry.length)throw error;fresh=await this.owned(retry[0].name,ctx);
      }
      requireValue(String(fresh.name)!==id,'Could not start a new chat',502);
      return {data:await this.payload(fresh)};
    }
    if(action==='send_message') {
      requireValue(!convo.conversation_stopped && !['Closed','Resolved'].includes(convo.status),'Start a new chat to send a message.',409);
      const message=text(body.message,4000),client=text(body.client_message_id,150);
      requireValue(message && client,'Message and message ID are required');
      const key=recordName(user.id,`ai:${appId}:${id}`,client);
      const filters={conversation:id,provider_name:'Mobile App',provider_message_id:key,direction:'Inbound'};
      let rows=await this.erp.list('Chat Message',filters,['name','body'],{limit:1});
      const duplicate=rows.length>0;let saved=rows[0];
      if(!saved) try {saved=await this.erp.create('Chat Message',{
        conversation:id,direction:'Inbound',sender_type:'Customer',content_type:'Text',body:message,
        provider_name:'Mobile App',provider_message_id:key,dedupe_key:key,delivery_status:'Received'});
      } catch(error) {rows=await this.erp.list('Chat Message',filters,['name','body'],{limit:1});if(!rows.length)throw error;saved=rows[0];}
      requireValue(saved.body===message,'This message ID was already used. Please send a new message.',409);
      return {data:{conversation_id:id,message_id:String(saved.name),duplicate}};
    }
    const subject=`Care-team request: ${id}`;
    const existing=await this.erp.list('Support Ticket',{user_id:user.id,custom_mobile_app:assessmentApp(appId),subject,category:'AI Chat Care Team',status:['not in',['Resolved','Closed']]},['name','ticket_number'],{limit:1});
    if(existing.length)return {data:{ticket:existing[0].name,ticket_number:existing[0].ticket_number || existing[0].name,created:false}};
    const messages=await this.messages(convo);
    const result=await this.service.support.create(user,appId,{subject,category:'AI Chat Care Team',
      description:`Conversation: ${id}\n\n`+messages.slice(-30).map(m=>`${m.sender_type}: ${m.message}`).join('\n').slice(0,9000)});
    return {data:{ticket:result.ticket.id,ticket_number:result.ticket.ticket_number,created:true}};
  }
}
