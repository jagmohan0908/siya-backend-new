export async function setupAiChatSchema(erp) {
  if(!await erp.maybe('DocType','Mobile App AI Message')) await erp.create('DocType',{
    name:'Mobile App AI Message',module:'Custom',custom:1,istable:1,
    fields:[
      {fieldname:'sender_type',label:'Sender',fieldtype:'Select',options:'Customer\nAI\nSystem',reqd:1,in_list_view:1},
      {fieldname:'message',label:'Message',fieldtype:'Long Text',reqd:1,in_list_view:1},
      {fieldname:'created_at',label:'Sent At',fieldtype:'Datetime',reqd:1,in_list_view:1},
      {fieldname:'client_message_id',label:'Retry ID',fieldtype:'Data',read_only:1},
    ]
  });
  if(!await erp.maybe('DocType','Mobile App AI Chat')) await erp.create('DocType',{
    name:'Mobile App AI Chat',module:'Custom',custom:1,autoname:'field:record_key',track_changes:0,
    fields:[
      {fieldname:'record_key',label:'Conversation ID',fieldtype:'Data',reqd:1,unique:1,read_only:1},
      {fieldname:'app',label:'App',fieldtype:'Select',options:'Siya Ayurveda\nSeedfit',reqd:1,in_list_view:1,in_standard_filter:1},
      {fieldname:'mobile_app_user',label:'Mobile App User',fieldtype:'Link',options:'Mobile App User',reqd:1,in_list_view:1},
      {fieldname:'account',label:'Verified Customer',fieldtype:'Data',reqd:1,read_only:1},
      {fieldname:'support_ticket',label:'Care-team Ticket',fieldtype:'Link',options:'Support Ticket',in_list_view:1},
      {fieldname:'messages',label:'Chat History',fieldtype:'Table',options:'Mobile App AI Message'},
    ],
    permissions:[{role:'System Manager',read:1,write:1,create:1,delete:1}]
  });
}
