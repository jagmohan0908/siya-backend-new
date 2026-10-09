import {object,requireValue} from './errors.mjs';
import {assessmentApp} from './assessments.mjs';
import {habitDay,habitOrders} from './invoice-habits.mjs';
import {isPerfectDay} from './habits.mjs';
import {recordName} from './store.mjs';

async function context(service,user,appId) {
  const app=assessmentApp(appId);
  const identity=await service.identity(user);
  const patient=await service.patient(user);
  const parent=await service.erp.get('Mobile App User',identity.erpUser);
  const rows=parent.custom_habit_trackers || [];
  const matches=rows.filter(r=>r.app===app && r.patient===patient.name);
  requireValue(matches.length<=1,'Please ask the clinic to review duplicate habit trackers.',409);
  const row=matches[0];
  const legacy=!row && appId==='siya-ayurveda' ? await service.records.read(user.id,'habits','self') : null;
  const previous=row ? (typeof row.payload==='string'?JSON.parse(row.payload):row.payload) : legacy?.data;
  return {app,patient,parent,rows,row,previous:previous || {},revision:Number(row?.revision || 0)};
}

async function purchases(service,user,appId) {
  const orders=[];
  let cursor=0;
  do {
    const page=await habitOrders(service,user,appId,cursor);
    orders.push(...page.items);cursor=page.nextCursor;
  } while(cursor!=null);
  const items=new Map();
  for(const order of orders) for(const product of order.items) {
    if(items.has(product.code)) continue;
    const item=await service.erp.get('Item',product.code);
    const frequency=['onceDaily','twiceDaily','twiceWeekly'].includes(item.custom_mobile_habit_frequency)
      ? item.custom_mobile_habit_frequency : 'onceDaily';
    items.set(product.code,{id:item.custom_mobile_habit_id || `erp:${encodeURIComponent(product.code)}`,
      frequency,instructions:item.custom_mobile_habit_frequency ?
        ({onceDaily:'Use once a day',twiceDaily:'Use twice a day (morning & evening)',twiceWeekly:'Use twice a week'})[frequency]
        : 'Follow your prescription or product instructions',
    });
  }
  for(const order of orders) order.items=order.items.map(p=>({...p,...items.get(p.code)}));
  const active=new Map();
  for(const order of orders) for(const item of order.items) if(item.canTrack) {
    requireValue(!active.has(item.id) || active.get(item.id).code===item.code,
      'Two products share the same habit ID. Please ask the clinic to review their setup.',409);
    active.set(item.id,item);
  }
  return {orders,products:[...active.values()]};
}

function tracker(user,old,products) {
  const today=habitDay();
  const dailyCompliance={...old.dailyCompliance};
  if(dailyCompliance[today]) {
    const ids=new Set(products.map(p=>p.id));
    const times=new Set(products.flatMap(p=>p.frequency==='twiceDaily'?[`${p.id}_morning`,`${p.id}_evening`]:
      p.frequency==='twiceWeekly'?[`${p.id}_use1`,`${p.id}_use2`]:[]));
    dailyCompliance[today]={...dailyCompliance[today],
      completedHabits:Object.fromEntries(Object.entries(dailyCompliance[today].completedHabits || {}).filter(([id])=>ids.has(id))),
      completedHabitTimes:Object.fromEntries(Object.entries(dailyCompliance[today].completedHabitTimes || {}).filter(([id])=>times.has(id)))};
  }
  return {...old,userId:user.id,
    habits:products.map((p,index)=>({id:p.id,name:p.name,description:p.instructions,
      type:'medicine',icon:'',isActive:true,order:index})),
    dailyCompliance,rewards:old.rewards || [],
    currentStreak:old.currentStreak || 0,longestStreak:old.longestStreak || 0,
    createdAt:old.createdAt || new Date().toISOString(),lastUpdated:old.lastUpdated || new Date().toISOString()};
}

export async function getErpHabitTracker(service,user,appId) {
  const ctx=await context(service,user,appId);
  const {orders,products}=await purchases(service,user,appId);
  return {orders,data:tracker(user,ctx.previous,products),revision:ctx.revision,today:habitDay()};
}

export async function saveErpHabitTracker(service,user,body,appId) {
  const ctx=await context(service,user,appId);
  requireValue(body.revision===ctx.revision,'Habits changed on another device. Refresh and try again.',409,'revision_conflict');
  const today=habitDay();
  requireValue(body.date===today,'The day changed. Refresh and try again.',409,'day_changed');
  const {orders,products}=await purchases(service,user,appId);
  const incoming=object(body.data);
  const entry=object(object(incoming.dailyCompliance)[today]);
  const completed=object(entry.completedHabits || {});
  const times=object(entry.completedHabitTimes || {});
  const allowed=new Set(products.map(p=>p.id));
  const allowedTimes=new Set(products.flatMap(p=>p.frequency==='twiceDaily'
    ? [`${p.id}_morning`,`${p.id}_evening`] : p.frequency==='twiceWeekly' ? [`${p.id}_use1`,`${p.id}_use2`] : []));
  requireValue(Object.entries(completed).every(([id,v])=>allowed.has(id) && typeof v==='boolean') &&
    Object.entries(times).every(([id,v])=>allowedTimes.has(id) && typeof v==='boolean'),'Only purchased products can be tracked');
  const data=tracker(user,ctx.previous,products);
  const normalized=Object.fromEntries(products.map(p=>[p.id,p.frequency==='twiceDaily'
    ? times[`${p.id}_morning`]===true && times[`${p.id}_evening`]===true
    : p.frequency==='twiceWeekly' ? times[`${p.id}_use1`]===true && times[`${p.id}_use2`]===true : completed[p.id]===true]));
  const daily=products.filter(p=>p.frequency!=='twiceWeekly');
  data.dailyCompliance={...data.dailyCompliance,[today]:{date:`${today}T00:00:00`,
    completedHabits:normalized,completedHabitTimes:times,notes:{},
    complianceScore:daily.length?daily.filter(p=>normalized[p.id]).length/daily.length:0,
    lastUpdated:new Date().toISOString()}};
  const ids=products.map(p=>p.id);
  const frequencies=Object.fromEntries(products.map(p=>[p.id,p.frequency]));
  const cursor=new Date(`${today}T12:00:00Z`);
  if(!isPerfectDay(data.dailyCompliance[today],ids,frequencies)) cursor.setUTCDate(cursor.getUTCDate()-1);
  let streak=0;
  while(isPerfectDay(data.dailyCompliance[cursor.toISOString().slice(0,10)],ids,frequencies)) {
    streak++;cursor.setUTCDate(cursor.getUTCDate()-1);
  }
  data.currentStreak=streak;data.longestStreak=Math.max(streak,data.longestStreak);
  data.lastUpdated=new Date().toISOString();
  const saved={...ctx.row,app:ctx.app,patient:ctx.patient.name,revision:ctx.revision+1,
    current_streak:streak,last_updated:data.lastUpdated,payload:JSON.stringify(data)};
  const rows=ctx.row?ctx.rows.map(r=>r.app===ctx.app && r.patient===ctx.patient.name?saved:r):[...ctx.rows,saved];
  await service.erp.update('Mobile App User',ctx.parent.name,{custom_habit_trackers:rows,modified:ctx.parent.modified});
  // Keep the existing approved-plan reward contract; never accept a client code
  // or streak. Progress remains saved if Shopify cannot issue the code yet.
  const plan=await service.records.read(user.id,appId==='siya-ayurveda'?'habit_plan':`habit_plan:${appId}`,'self');
  if(streak>=30 && plan?.data?.habitIds?.length &&
    JSON.stringify([...plan.data.habitIds].sort())===JSON.stringify([...ids].sort()) && service.rewardIssuer) {
    const cycle=`${cursor.toISOString().slice(0,10)}-${Math.floor(streak/30)}`;
    const kind=appId==='siya-ayurveda'?'reward':`reward:${appId}`;
    const key=recordName(user.id,kind,cycle);
    let reward=await service.records.read(user.id,kind,key);
    if(!reward) reward=await service.records.write(user.id,kind,key,{id:key,
      code:`${appId==='seedfit'?'SEED':'SIYA'}${key.slice(0,16).toUpperCase()}`,state:'pending',
      createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90*86400000).toISOString()},0);
    if(reward.data.state!=='issued') {
      try { await service.rewardIssuer(user,reward.data); }
      catch { return {data,revision:saved.revision,orders,today,rewardPending:true}; }
      reward=await service.records.write(user.id,kind,key,{...reward.data,state:'issued'},reward.revision);
    }
    if(!data.rewards.some(r=>r.id===key)) {
      data.rewards.push({id:key,couponCode:reward.data.code,discountPercent:5,earnedAt:reward.data.createdAt,
        expiresAt:reward.data.expiresAt,isUsed:false,streakDays:30});
      const fresh=await service.erp.get('Mobile App User',ctx.parent.name);
      const latest=fresh.custom_habit_trackers.find(r=>r.app===ctx.app && r.patient===ctx.patient.name);
      requireValue(latest?.revision===saved.revision,'Habits changed. Refresh and try again.',409,'revision_conflict');
      saved.revision++;
      await service.erp.update('Mobile App User',fresh.name,{modified:fresh.modified,
        custom_habit_trackers:fresh.custom_habit_trackers.map(r=>r===latest?{...r,revision:saved.revision,payload:JSON.stringify(data)}:r)});
    }
  }
  return {data,revision:saved.revision,orders,today};
}
