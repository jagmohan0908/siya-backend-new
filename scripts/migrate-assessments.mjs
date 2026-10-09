import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Erp} from '../src/erp.mjs';
import {Assessments} from '../src/assessments.mjs';
import {setupAssessmentSchema} from './assessment-schema.mjs';

const erp = new Erp({url:process.env.ERP_URL,token:process.env.ERP_TOKEN});
const assessments = new Assessments(erp);
const rows = await assessments.legacyRows();
const backup = process.argv[2] ? resolve(process.argv[2]) :
  join(tmpdir(),`mobile-assessments-backup-${Date.now()}.json`);
// Write a private backup before any ERP mutation. Never put this file in Git.
await writeFile(backup,JSON.stringify({savedAt:new Date().toISOString(),records:rows},null,2),{flag:'wx',mode:0o600});
console.log(`Legacy backup: ${backup}`);
await setupAssessmentSchema(erp);
const migrated = await assessments.migrateRows(rows);
console.log(JSON.stringify({migrated,legacyRecordsRetained:rows.length}));
