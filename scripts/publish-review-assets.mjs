import {readFile} from 'node:fs/promises';
import {Erp} from '../src/erp.mjs';
import {Records,recordName} from '../src/store.mjs';
import {requireValue} from '../src/errors.mjs';
const erp=new Erp({url:process.env.ERP_URL,token:process.env.ERP_TOKEN});
const records=new Records(erp);const name=recordName('system','review_assets','indian-illustrations');
let record=await records.read('system','review_assets','indian-illustrations');
if (!record) record=await records.write('system','review_assets','indian-illustrations',{},0);
for (const gender of ['man','woman']) {
  if (record.data[gender]) continue;
  const matches=await erp.list('File',{attached_to_doctype:'Siya Mobile Record',attached_to_name:name,file_name:`indian_review_${gender}.jpg`},['name','file_url'],{limit:2});
  if (matches.length) {
    requireValue(matches[0].file_url?.startsWith('s3://'),'An existing upload has not reached S3. Check ERP S3 configuration before retrying.',503);
    record=await records.write('system','review_assets','indian-illustrations',{...record.data,[gender]:matches[0].name},record.revision);
    console.log(`Reconciled ${gender} illustration`);continue;
  }
  const bytes=await readFile(new URL(`../assets/images/indian_review_${gender}.jpg`,import.meta.url));
  const form=new FormData();
  form.append('file',new Blob([bytes],{type:'image/jpeg'}),`indian_review_${gender}.jpg`);
  form.append('is_private','0');form.append('doctype','Siya Mobile Record');form.append('docname',name);
  const uploaded=await erp.request('/api/method/upload_file',{method:'POST',body:form});
  const file=await erp.get('File',uploaded.name);
  requireValue(file.file_url?.startsWith('s3://'),'ERP did not move the file to S3; check ERP S3 configuration',503);
  record=await records.write('system','review_assets','indian-illustrations',{...record.data,[gender]:file.name},record.revision);
  console.log(`Published ${gender} illustration to ERP/S3`);
}
