import test from 'node:test';
import assert from 'node:assert/strict';
import {AppsScriptMeet,realMeetLink} from '../src/appointment-meet.mjs';

const booking={id:'test-booking',appointmentDate:'2030-10-15',time:'10:30:00',patientName:'Test Patient',doctorName:'Test Doctor'};
const link='https://meet.google.com/abc-defg-hij';

test('the backend calls the existing script once and follows its result with GET',async()=>{
  const calls=[];
  const provider=new AppsScriptMeet({fetcher:async(url,options)=>{
    calls.push({url,...options});
    return calls.length===1 ? new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?result=test'}})
      : Response.json({status:'success',meetingLink:link});
  }});
  assert.equal(await provider.create(booking),link);
  assert.equal(calls[0].method,'POST');assert.equal(calls[1].method,'GET');
  const payload=JSON.parse(calls[0].body);
  assert.equal(payload.id,booking.id);assert.equal(payload.appointmentDate,'15 Oct 2030');assert.equal(payload.timeSlot,'10:30 AM');
  assert.equal(calls[1].body,undefined);assert.equal(calls[1].headers,undefined);
});

test('provider errors, placeholder links and non-Google redirects never become meeting links',async()=>{
  for(const value of ['https://meet.google.com/new','https://meet.google.com.evil.test/abc-defg-hij','javascript:alert(1)','http://meet.google.com/abc-defg-hij']) {
    assert.equal(realMeetLink(value),null);
    const provider=new AppsScriptMeet({fetcher:async()=>Response.json({status:'success',meetingLink:value})});
    await assert.rejects(provider.create(booking),{code:'meet_provider_unavailable'});
  }
  let calls=0;
  const provider=new AppsScriptMeet({fetcher:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://evil.test'}});}});
  await assert.rejects(provider.create(booking),{code:'meet_provider_unavailable'});assert.equal(calls,1);
});
