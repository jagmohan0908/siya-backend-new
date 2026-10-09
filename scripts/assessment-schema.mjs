import {assessmentType} from '../src/assessments.mjs';

export async function setupAssessmentSchema(erp) {
  if (await erp.maybe('DocType',assessmentType)) return false;
  await erp.create('DocType',{
    name:assessmentType,module:'Custom',custom:1,autoname:'field:record_key',track_changes:1,
    fields:[
      {fieldname:'record_key',label:'Record Key',fieldtype:'Data',reqd:1,unique:1,read_only:1},
      {fieldname:'app',label:'App',fieldtype:'Select',options:'Siya Ayurveda\nSeedfit',reqd:1,in_list_view:1,in_standard_filter:1},
      {fieldname:'account',label:'Verified Shopify Customer',fieldtype:'Data',reqd:1,search_index:1},
      {fieldname:'patient',label:'Patient',fieldtype:'Link',options:'Patient',in_list_view:1},
      {fieldname:'assessment_id',label:'Assessment ID',fieldtype:'Data',reqd:1,read_only:1},
      {fieldname:'concern',label:'Concern',fieldtype:'Data',in_list_view:1},
      {fieldname:'questionnaire_version',label:'Questionnaire Version',fieldtype:'Data'},
      {fieldname:'submitted_at',label:'Submitted At (UTC)',fieldtype:'Data',in_list_view:1},
      {fieldname:'payload',label:'Answers and Result',fieldtype:'JSON',reqd:1},
      {fieldname:'revision',label:'Revision',fieldtype:'Int',reqd:1,read_only:1},
      {fieldname:'legacy_source',label:'Original Mobile Record',fieldtype:'Link',options:'Siya Mobile Record',read_only:1},
    ],
    permissions:[{role:'System Manager',read:1,write:1,create:1,delete:1}],
  });
  return true;
}
