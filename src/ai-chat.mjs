import {requireValue,text} from './errors.mjs';
import {assessmentApp} from './assessments.mjs';
import {recordName} from './store.mjs';

export class AiChat {
  constructor(service) { this.service=service; }
  async call(user,appId,action,body={}) {
    assessmentApp(appId);
    requireValue(['open_session','get_messages','send_message','escalate'].includes(action),'Invalid AI action');
    const identity=await this.service.identity(user);
    const args={external_id:identity.erpUser,app_id:appId};
    if(action!=='open_session') {
      args.conversation=text(body.conversation,140);requireValue(args.conversation,'Conversation is required');
    }
    if(action==='get_messages') {
      if(body.after) args.after=text(body.after,140);
      args.limit=100;
    }
    if(action==='send_message') {
      args.message=text(body.message,4000);requireValue(args.message,'Message is required');
      const key=text(body.client_message_id,150);requireValue(key,'Message ID is required');
      args.client_message_id=recordName(user.id,`ai:${appId}:${args.conversation}`,key);
    }
    const result=await this.service.erp.method(`sriaas_clinic.api.mobile_app_ai.${action}`,args,action!=='get_messages');
    requireValue(result?.success===true && result.data,'AI chat is temporarily unavailable. Please try again.',502);
    const data=result.data;
    if(action==='open_session') requireValue(data.conversation_id,'AI conversation could not be opened',502);
    if(args.conversation && data.conversation_id) requireValue(data.conversation_id===args.conversation,'Unexpected AI conversation',502);
    if(action==='send_message') requireValue(data.message_id,'Message was not confirmed. Please retry.',502);
    return {data};
  }
}
