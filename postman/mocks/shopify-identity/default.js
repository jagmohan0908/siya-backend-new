const http=require('http');
http.createServer((req,res)=>{
 const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
 if(req.method!=='POST'||req.url!=='/api/2026-07/graphql.json')return send(501,{error:'Not modeled'});
 const token=req.body?.variables?.token;
 if(token==='synthetic-throttled')return send(200,{errors:[{message:'Throttled',extensions:{code:'THROTTLED'}}]});
 if(token==='synthetic-partial')return send(200,{data:{customer:null},errors:[{message:'Unavailable'}]});
 if(token==='synthetic-missing')return send(200,{data:{}});
 if(token==='synthetic-unavailable')return send(503,{error:'Unavailable'});
 if(token==='synthetic-html'){res.writeHead(200,{'content-type':'text/html'});return res.end('<html>Proxy error</html>');}
 if(token==='synthetic-expired')return send(200,{data:{customer:null}});
 if(token!=='synthetic-valid')return send(501,{error:'Scenario not modeled'});
 return send(200,{data:{customer:{id:'gid://shopify/Customer/123',phone:'+919311003366'}}});
}).listen(process.env.PORT||4500);
