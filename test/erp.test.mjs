import test from 'node:test';
import assert from 'node:assert/strict';
import {Erp} from '../src/erp.mjs';

test('ERP failures retain only a safe upstream status for optional capabilities',async()=>{
  const erp=new Erp({url:'https://erp.example.com',token:'test-token',fetcher:async()=>
    Response.json({exc_type:'PermissionError',exception:'PRIVATE TRACE'},{status:403})});
  await assert.rejects(erp.list('Shipment Tracking Shipment'),error=>{
    assert.equal(error.status,502);assert.equal(error.code,'erp_request_failed');
    assert.equal(error.upstreamStatus,403);
    assert.ok(!JSON.stringify(error).includes('PRIVATE TRACE'));
    return true;
  });
});

test('ngrok ERP JSON requests bypass the browser warning and retain authentication', async () => {
  const erp = new Erp({url:'https://emission-stable-jackknife.ngrok-free.dev/',token:'test-token',
    fetcher:async (url,options) => {
      assert.equal(url,'https://emission-stable-jackknife.ngrok-free.dev/api/method/ping?');
      assert.equal(options.headers['ngrok-skip-browser-warning'],'1');
      assert.equal(options.headers.Authorization,'token test-token');
      assert.equal(options.redirect,'error');
      return Response.json({message:'pong'});
    }});
  assert.equal(await erp.method('ping'),'pong');
});

test('ngrok file uploads preserve multipart boundaries and PDF responses stay binary', async () => {
  const form = new FormData();
  form.append('file',new Blob(['test']), 'test.txt');
  const erp = new Erp({url:'https://emission-stable-jackknife.ngrok-free.dev',token:'test-token',
    fetcher:async (_,options) => {
      assert.equal(options.headers['ngrok-skip-browser-warning'],'1');
      if (options.method === 'POST') {
        assert.equal(options.body,form);
        assert.equal(options.headers['Content-Type'],undefined);
        return Response.json({message:{name:'file-id'}});
      }
      return new Response('pdf-content',{headers:{'Content-Type':'application/pdf'}});
    }});
  assert.equal((await erp.request('/api/method/upload_file',{method:'POST',body:form})).name,'file-id');
  assert.equal(await (await erp.request('/invoice',{raw:true})).text(),'pdf-content');
});

test('ordinary ERP hosts do not receive a tunnel-specific header', async () => {
  const erp = new Erp({url:'https://erp.example.com',token:'test-token',
    fetcher:async (_,options) => {
      assert.equal(options.headers['ngrok-skip-browser-warning'],undefined);
      return Response.json({message:'pong'});
    }});
  await erp.method('ping');
});
