const http=require('http');
http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');
 const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 try {
  let docs=await pm.state.get('purchase-erp:docs') || {};
  if(u.pathname==='/test/seed'){await pm.state.set('purchase-erp:docs',req.body);return send(200,{ok:true});}
  if(u.pathname==='/api/method/frappe.handler.download_file') {res.writeHead(200,{'content-type':'application/pdf'});return res.end('%PDF-synthetic');}
  const p=u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if(p[0]!=='api'||p[1]!=='resource')return send(501,{error:'Not modeled'});
  const type=p[2],name=p[3];
  if(!Object.hasOwn(docs,type))return send(501,{error:'Type not modeled'});
  if(req.method==='GET'){
   if(name)return docs[type][name]?send(200,{data:docs[type][name]}):send(404,{exc_type:'DoesNotExistError'});
   const match=(d,k,v)=>!Array.isArray(v)?d[k]===v:v[0]==='in'?v[1].includes(d[k]):v[0]==='<'?d[k]<v[1]:v[0]==='is'?Boolean(d[k]):false;
   const filters=JSON.parse(u.searchParams.get('filters')||'{}'),or=JSON.parse(u.searchParams.get('or_filters')||'[]');
   const rows=Object.values(docs[type]).filter(d=>Object.entries(filters).every(([k,v])=>match(d,k,v))&&(!or.length||or.some(([k,op,v])=>match(d,k,op==='='?v:[op,v]))));
   const offset=Number(u.searchParams.get('limit_start')||0),limit=Number(u.searchParams.get('limit_page_length')||50);
   return send(200,{data:rows.slice(offset,offset+limit)});
  }
  if(type!=='Siya Mobile Record'||!['POST','PUT'].includes(req.method))return send(501,{error:'Write not modeled'});
  const key=name||req.body.record_key;docs[type][key]={...docs[type][key],...req.body,name:key};
  await pm.state.set('purchase-erp:docs',docs);send(200,{data:docs[type][key]});
 }catch{send(500,{error:'Mock failure'});}
}).listen(process.env.PORT||4500);
