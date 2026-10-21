import test from 'node:test';
import assert from 'node:assert/strict';
import {MobileService} from '../src/service.mjs';
import {ApiError} from '../src/errors.mjs';
import {Erp} from '../src/erp.mjs';

test('only a Frappe missing-document response is classified as a missing reference',async()=>{
  for (const [body,missing] of [[{exc_type:'DoesNotExistError'},true],[{},false]]) {
    const erp=new Erp({url:'https://erp.test',token:'test',fetcher:async()=>Response.json(body,{status:404})});
    await assert.rejects(erp.get('Mobile App Appointment','missing'),error=>{
      assert.equal(error.missingDocument,missing);return true;
    });
  }
});

test('missing booking references remain visible for review without hiding valid bookings',async()=>{
  const service=new MobileService({erp:{}});
  const stale={id:'old',status:'confirmed',meetingLink:'https://meet.google.com/abc-defg-hij'};
  const current={id:'current',status:'confirmed'};
  service.records.list=async()=>[{data:stale},{data:current}];
  service.refreshAppointment=async(_,record)=>{
    if(record.data.id==='old')throw Object.assign(new ApiError(404,'erp_request_failed','Missing'),{missingDocument:true});
    return record.data;
  };
  const {items}=await service.appointments({id:'customer'});
  assert.equal(items.length,2);assert.deepEqual(items[1],current);
  assert.equal(items[0].bookingSyncPending,true);assert.equal(items[0].status,'pending');
  assert.equal(items[0].meetingLink,null);assert.equal(items[0].syncIssue,'erp_record_missing');
  assert.equal(stale.status,'confirmed');
});

test('history still reports ERP outages and permission failures',async()=>{
  const service=new MobileService({erp:{}});
  service.records.list=async()=>[{data:{id:'old'}}];
  for(const status of [404,403,502]) {
    service.refreshAppointment=async()=>{throw new ApiError(status,'erp_request_failed','Unavailable');};
    await assert.rejects(service.appointments({id:'customer'}),{status});
  }
});
