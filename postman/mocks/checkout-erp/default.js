// Frappe REST envelope and Siya Mobile Record storage used by Records/Erp.
// This deliberately models no clinical data or checkout provider behavior.
const http = require('http');
http.createServer(async (req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  try {
    const docs=await pm.state.get('checkout-erp:records') || {};
    if(url.pathname==='/test/reset') {
      await pm.state.set('checkout-erp:records',{}); await pm.state.set('checkout-erp:fail',false); return send(200,{ok:true});
    }
    if(url.pathname==='/test/fail-grant') { await pm.state.set('checkout-erp:fail',url.searchParams.get('enabled')==='true'); return send(200,{ok:true}); }
    const parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if(parts[0]!=='api' || parts[1]!=='resource' || parts[2]!=='Siya Mobile Record') return send(501,{error:'Not modeled'});
    if(req.method==='GET' && parts[3]) return docs[parts[3]] ? send(200,{data:docs[parts[3]]}) : send(404,{exc_type:'DoesNotExistError'});
    if(req.method==='GET') {
      const filters=JSON.parse(url.searchParams.get('filters') || '{}');
      const rows=Object.values(docs).filter(doc=>Object.entries(filters).every(([key,value])=>doc[key]===value));
      const offset=Number(url.searchParams.get('limit_start') || 0),limit=Number(url.searchParams.get('limit_page_length') || 50);
      return send(200,{data:rows.slice(offset,offset+limit)});
    }
    const body=req.body;
    if(await pm.state.get('checkout-erp:fail') && body.kind==='order-owner') return send(500,{exc_type:'ValidationError'});
    const name=parts[3] || body.record_key;
    if(req.method==='POST' && docs[name]) return send(409,{exc_type:'DuplicateEntryError'});
    if(req.method==='PUT' && !docs[name]) return send(404,{exc_type:'DoesNotExistError'});
    if(!['PUT','POST'].includes(req.method)) return send(501,{error:'Not modeled'});
    docs[name]={...docs[name],...body,name,modified:new Date().toISOString()};
    await pm.state.set('checkout-erp:records',docs);
    send(200,{data:docs[name]});
  } catch {send(500,{error:'Mock failure'});}
}).listen(process.env.PORT || 4500);
