import {requireValue} from './errors.mjs';
import {recordName} from './store.mjs';

export const assessmentType = 'Mobile App Assessment';
const apps = new Map([['siya-ayurveda','Siya Ayurveda'],['seedfit','Seedfit']]);
export function assessmentApp(appId) {
  requireValue(apps.has(appId),'Unknown app ID',400,'invalid_app');
  return apps.get(appId);
}
export const assessmentKey = (account,appId,id) => recordName(account,`assessment:${appId}`,id);
const payload = doc => typeof doc.payload === 'string' ? JSON.parse(doc.payload) : doc.payload;

export class Assessments {
  constructor(erp) { this.erp = erp; }
  decode(doc,account,appId) {
    const data = payload(doc);
    requireValue(doc.account === account && doc.app === assessmentApp(appId) &&
      data?.appId === appId && data.id === doc.assessment_id,
      'Assessment not found',404);
    return {data,revision:Number(doc.revision || 1),modified:doc.modified};
  }
  async read(account,appId,id) {
    assessmentApp(appId);
    const doc = await this.erp.maybe(assessmentType,assessmentKey(account,appId,id));
    return doc ? this.decode(doc,account,appId) : null;
  }
  async create(account,appId,data,{legacySource='',revision=1}={}) {
    const app = assessmentApp(appId);
    requireValue(typeof account === 'string' && account.length > 0 &&
      typeof data.id === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(data.id),
      'Invalid assessment identity');
    const old = await this.read(account,appId,data.id);
    if (old) return old;
    const saved = {...data,appId};
    const fields = {record_key:assessmentKey(account,appId,data.id),app,account,
      assessment_id:data.id,patient:data.patient || null,
      questionnaire_version:data.questionnaireVersion || '',
      concern:data.answers?.selected_disease || data.result?.disease || '',
      submitted_at:data.createdAt || '',payload:JSON.stringify(saved),
      revision,legacy_source:legacySource || null};
    try {
      return this.decode(await this.erp.create(assessmentType,fields),account,appId);
    } catch (error) {
      // A retry or concurrent migration may have already created this exact record.
      if (error.status !== 409) throw error;
      const existing = await this.read(account,appId,data.id);
      if (!existing) throw error;
      return existing;
    }
  }
  async legacyRows(account) {
    const rows = [];
    for (let offset=0;;offset+=100) {
      const page = await this.erp.list('Siya Mobile Record',
        {kind:'treatment',...(account ? {account} : {})},
        ['name','account','kind','payload','revision'],{offset,limit:100,order:'name asc'});
      rows.push(...page);
      if (page.length < 100) return rows;
    }
  }
  async migrateRows(rows,{account,appId}={}) {
    if (appId !== undefined) assessmentApp(appId);
    let migrated = 0;
    for (const row of rows) {
      requireValue(row.kind === 'treatment' && (!account || row.account === account),
        'Invalid legacy assessment owner',404);
      const data = payload(row);
      // Historical unlabeled records were produced by the Siya app.
      const sourceApp = data.appId ?? 'siya-ayurveda';
      assessmentApp(sourceApp);
      if (appId !== undefined && sourceApp !== appId) continue;
      await this.create(row.account,sourceApp,data,
        {legacySource:row.name,revision:Number(row.revision || 1)});
      migrated++;
    }
    return migrated;
  }
  async migrateLegacy(account,appId) {
    assessmentApp(appId);
    return this.migrateRows(await this.legacyRows(account),{account,appId});
  }
  async list(account,appId) {
    const app = assessmentApp(appId);
    // Covers writes by an older backend during a rolling deployment; originals stay intact.
    await this.migrateLegacy(account,appId);
    const rows = await this.erp.list(assessmentType,{account,app},
      ['name','account','app','assessment_id','payload','revision','modified'],{limit:50,order:'submitted_at desc, name desc'});
    return rows.map(doc=>this.decode(doc,account,appId));
  }
}
