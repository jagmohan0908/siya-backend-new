import assert from 'node:assert/strict';
import {Erp} from '../src/erp.mjs';
import {MobileService} from '../src/service.mjs';
import {createApi} from '../src/server.mjs';

const base=process.env.PURCHASE_SIMULATION_URL || 'http://127.0.0.1:4913';
const docs={'Patient':{'PAT-SHARED':{name:'PAT-SHARED'}},'Sales Invoice':{},'DocType':{},'Siya Mobile Record':{}};
for(let i=0;i<45;i++) for(const [prefix,department] of [['SEED','Seed.fit'],['SIYA','Siya Ayurveda'],['BLANK','']]) {
  const name=`${prefix}-${String(i).padStart(3,'0')}`;
  docs['Sales Invoice'][name]={name,patient:'PAT-SHARED',sr_si_patient_department:department,
    docstatus:1,posting_date:'2026-10-29',items:[]};
}
docs['Sales Invoice']['OTHER-PAT']={...docs['Sales Invoice']['SEED-000'],name:'OTHER-PAT',patient:'PAT-OTHER'};
const seeded=await fetch(base+'/erp/test/seed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(docs)});
assert.equal(seeded.status,200);
const erp=new Erp({url:base+'/erp',token:'synthetic-only'});
const services=Object.fromEntries(['seedfit','siya-ayurveda'].map(appId=>{
  const service=new MobileService({erp,appId});
  // Fixed synthetic identity isolates invoice filtering; production identity code is unchanged.
  service.identity=async()=>({patient:'PAT-SHARED',customers:[]});
  return [appId,service];
}));
const api=createApi({tenants:appId=>({service:services[appId],authenticate:async auth=>{
  assert.equal(auth,'Bearer synthetic-'+appId);return {id:'synthetic-account'};
}})});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const call=(app,path,method='GET')=>fetch(`http://127.0.0.1:${api.address().port}${path}${path.includes('?')?'&':'?'}app=${app}`,
  {method,headers:{Authorization:'Bearer synthetic-'+app,'Content-Type':'application/json'},
    ...(method==='POST'?{body:'{}'}:{})});
try {
  for(const [app,prefix,other] of [['seedfit','SEED','SIYA'],['siya-ayurveda','SIYA','SEED']]) {
    let cursor=0;const ids=[];
    do {
      const response=await call(app,`/v1/orders?cursor=${cursor}`);assert.equal(response.status,200);
      const page=await response.json();ids.push(...page.items.map(i=>i.id));cursor=page.nextCursor;
    }while(cursor!==null);
    assert.equal(ids.length,45);assert.equal(new Set(ids).size,45);assert.ok(ids.every(id=>id.startsWith(prefix)));
    assert.equal((await call(app,`/v1/invoices/${prefix}-000`)).status,200);
    const pdf=await call(app,`/v1/invoices/${prefix}-000/pdf`);assert.equal(pdf.status,200);assert.match(await pdf.text(),/^%PDF-/);
    for(const id of [`${other}-000`,'BLANK-000','OTHER-PAT']) {
      assert.equal((await call(app,`/v1/invoices/${id}`)).status,404);
      assert.equal((await call(app,`/v1/invoices/${id}/pdf`)).status,404);
      assert.equal((await call(app,`/v1/invoices/${id}/tracking`,'POST')).status,404);
    }
    console.log(`PASS ${app}: 45 matching invoices across 3 pages; foreign/blank departments and unrelated patient denied on details/PDF/tracking`);
  }
} finally {await new Promise(r=>api.close(r));}
