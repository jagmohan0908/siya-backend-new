export async function setupSupportSchema(erp) {
  for(const field of [
    {fieldname:'custom_mobile_app',label:'Mobile App',fieldtype:'Select',options:'\nSiya Ayurveda\nSeedfit',insert_after:'user_id',in_list_view:1,in_standard_filter:1},
    {fieldname:'custom_mobile_app_user',label:'Mobile App User',fieldtype:'Link',options:'Mobile App User',insert_after:'custom_mobile_app'},
  ]) if(!await erp.maybe('Custom Field',`Support Ticket-${field.fieldname}`)) {
    await erp.create('Custom Field',{dt:'Support Ticket',...field});
  }
}
