export async function setupHabitSchema(erp) {
  if(!await erp.maybe('DocType','Mobile App Habit Tracker Item')) await erp.create('DocType',{
    name:'Mobile App Habit Tracker Item',module:'Custom',custom:1,istable:1,
    fields:[
      {fieldname:'app',label:'App',fieldtype:'Select',options:'Siya Ayurveda\nSeedfit',reqd:1,in_list_view:1},
      {fieldname:'patient',label:'Patient',fieldtype:'Link',options:'Patient',reqd:1,in_list_view:1},
      {fieldname:'last_updated',label:'Last Updated (UTC)',fieldtype:'Data',in_list_view:1},
      {fieldname:'current_streak',label:'Current Streak',fieldtype:'Int',read_only:1,in_list_view:1},
      {fieldname:'revision',label:'Revision',fieldtype:'Int',read_only:1},
      {fieldname:'payload',label:'Habit Tracker Data',fieldtype:'JSON',reqd:1,read_only:1},
    ],
  });
  for(const [dt,fields] of [
    ['Item Group Template',[
      {fieldname:'custom_shopify_product_id',label:'Shopify Product ID',fieldtype:'Data',insert_after:'description',
        description:'Optional catalogue product for the existing Order Next Kit button.'},
      {fieldname:'custom_mobile_image_url',label:'Mobile Kit Image',fieldtype:'Data',insert_after:'custom_shopify_product_id',
        description:'Optional Shopify CDN image for this kit.'},
    ]],
    ['Mobile App User',[
      {fieldname:'custom_habit_tracker_tab',label:'Habit Tracker',fieldtype:'Tab Break',insert_after:'engagement_items'},
      {fieldname:'custom_habit_trackers',label:'Habit Tracker',fieldtype:'Table',options:'Mobile App Habit Tracker Item',insert_after:'custom_habit_tracker_tab',read_only:1},
    ]],
    ['Item',[
      {fieldname:'custom_mobile_habit_frequency',label:'Mobile Habit Check-ins',fieldtype:'Select',
        options:'\nonceDaily\ntwiceDaily\ntwiceWeekly',insert_after:'description',
        description:'Check-in pattern for the existing mobile habit tracker. Leave blank for as-directed logging; this is not a prescription.'},
      {fieldname:'custom_mobile_habit_id',label:'Previous Mobile Habit ID',fieldtype:'Data',insert_after:'custom_mobile_habit_frequency',
        description:'Optional exact identifier from the previous tracker, for retaining its history.'},
    ]],
  ]) for(const field of fields) {
    if(!await erp.maybe('Custom Field',`${dt}-${field.fieldname}`)) await erp.create('Custom Field',{dt,...field});
  }
}
