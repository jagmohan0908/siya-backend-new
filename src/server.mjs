import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {Erp} from './erp.mjs';
import {createAuthenticator} from './auth.mjs';
import {MobileService} from './service.mjs';
import {createRewardIssuer} from './shopify.mjs';
import {Razorpay} from './payments.mjs';
import {ApiError, requireValue} from './errors.mjs';

async function readBody(req) {
  requireValue((req.headers['content-type'] || '').startsWith('application/json'), 'Use application/json',415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; requireValue(size <= 12_000_000,'Request too large',413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new ApiError(400,'invalid_json','Invalid JSON'); }
}

export function createApi({service, authenticate, origins = [], allowBookings = false}) {
  const limits = new Map();
  const server = createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    try {
      const origin = req.headers.origin;
      if (origin) {
        requireValue(origins.includes(origin),'Origin not allowed',403);
        res.setHeader('Access-Control-Allow-Origin',origin); res.setHeader('Vary','Origin');
        res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');
        res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const now = Date.now();
      if (limits.size > 10000) for (const [key,value] of limits) if (value.until < now) limits.delete(key);
      const ip = req.socket.remoteAddress; let bucket = limits.get(ip);
      if (!bucket || bucket.until < now) { bucket = {count:0,until:now+60000}; limits.set(ip,bucket); }
      requireValue(++bucket.count <= 120,'Too many requests. Please try again shortly.',429);
      const url = new URL(req.url,'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      let result;
      if (req.method === 'GET' && url.pathname === '/health') result = {ok:true,version:1};
      else if (req.method === 'GET' && url.pathname === '/v1/doctors') result = await service.doctors();
      else if (req.method === 'GET' && url.pathname === '/v1/review-avatars') result = await service.reviewAvatars();
      else if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'doctors' && parts[3] === 'slots') {
        result = await service.availability(parts[2],url.searchParams.get('date') || '');
      } else {
        const user = await authenticate(req.headers.authorization);
        const body = ['POST','PUT'].includes(req.method) ? await readBody(req) : {};
        result = await service.queue.run(user.id,async () => {
          const route = `${req.method} ${url.pathname}`;
          if (route === 'GET /v1/profile') return service.profile(user);
          if (route === 'PUT /v1/profile') return service.saveProfile(user,body);
          if (route === 'GET /v1/appointments') return service.appointments(user);
          if (route === 'POST /v1/appointments' || route === 'POST /v1/appointment-orders') {
            requireValue(allowBookings,'Appointment booking is temporarily unavailable. No payment was taken.',503,'booking_setup_required');
            return service.createAppointment(user,body,route.endsWith('/appointment-orders'));
          }
          if (req.method === 'POST' && parts[1] === 'appointments' && parts[3] === 'requests') return service.appointmentChange(user,parts[2],body);
          if (route === 'GET /v1/treatments') return {items:await service.records.list(user.id,'treatment')};
          if (route === 'POST /v1/treatments') return service.treatment(user,body);
          if (route === 'GET /v1/diets') return service.diets(user);
          if (route === 'GET /v1/habits') return service.habits(user);
          if (route === 'PUT /v1/habits') return service.saveHabits(user,body);
          if (route === 'POST /v1/files') return service.upload(user,body);
          if (req.method === 'GET' && parts[1] === 'files' && parts.length === 3) return service.file(user,parts[2]);
          if (route === 'GET /v1/orders') {
            const offset = Number(url.searchParams.get('cursor') || 0);
            requireValue(Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000,'Invalid cursor');
            return service.orders(user,offset);
          }
          if (req.method === 'GET' && parts[1] === 'invoices' && parts.length >= 3) return service.invoice(user,parts[2],parts[3] === 'pdf');
          throw new ApiError(404,'not_found','Endpoint not found');
        });
      }
      if (result instanceof Response) {
        res.setHeader('Content-Type','application/pdf');
        res.end(Buffer.from(await result.arrayBuffer())); return;
      }
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = error instanceof ApiError ? error.status : 503;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({error:{code:error instanceof ApiError ? error.code : 'temporarily_unavailable',
        message:error instanceof ApiError ? error.message : 'Service is temporarily unavailable. Please try again.'}}));
      // No request bodies, tokens or medical details in logs.
      console.error(JSON.stringify({event:'request_failed',status:res.statusCode,code:error.code || 'internal'}));
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireValue(process.env.ERP_URL?.startsWith('https://') && process.env.ERP_TOKEN,'Configure ERP_URL and ERP_TOKEN');
  const erp = new Erp({url:process.env.ERP_URL,token:process.env.ERP_TOKEN});
  const doctorPolicy = JSON.parse(await readFile(new URL('../doctor-policy.json',import.meta.url),'utf8'));
  const service = new MobileService({erp,doctorPolicy,webhookUrl:process.env.APPOINTMENT_WEBHOOK_URL,
    s3PresignMethod:process.env.S3_PRESIGN_METHOD,
    payments:new Razorpay({keyId:process.env.RAZORPAY_KEY_ID,keySecret:process.env.RAZORPAY_KEY_SECRET}),
    webhookSecret:process.env.APPOINTMENT_WEBHOOK_SECRET,rewardIssuer:createRewardIssuer({domain:process.env.SHOPIFY_DOMAIN,adminToken:process.env.SHOPIFY_ADMIN_TOKEN})});
  const server = createApi({service,authenticate:createAuthenticator({domain:process.env.SHOPIFY_DOMAIN,storefrontToken:process.env.SHOPIFY_STOREFRONT_TOKEN}),
    allowBookings:process.env.BOOKINGS_ENABLED === 'true',
    origins:(process.env.CORS_ORIGINS || '').split(',').filter(Boolean)});
  server.listen(Number(process.env.PORT || 8787),process.env.HOST || '127.0.0.1',() => console.log('Siya mobile API listening'));
}
