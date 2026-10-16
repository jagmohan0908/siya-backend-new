// Public catalogue matching only. No chat text or patient details leave for Shopify.
const norm=s=>String(s || '').toLowerCase().normalize('NFKC');
const groups=[['acne','pimple','pimples','मुंहासे'],['hair','dandruff','बाल'],['vitiligo','leucoderma','सफेद दाग'],['psoriasis','सोरायसिस']];
// Generic service words also occur in product titles (e.g. "fertility support").
// They must not turn a support/availability question into product recommendations.
const stop=new Set('siya ayurveda seedfit seed fit product products treatment kit for with and the cream oil tablets shampoo buy price show tell please recommend want need hai mujhe chahiye best support available availability confirm help chat agent customer team test testing integration hello thanks thank'.split(' '));
const privateOrUsage=/\b(order|orders|invoice|tracking|shipment|awb|delivery|prescription|dose|dosage|take|usage|apply|safe|pregnan\w*|breastfeed\w*|child|children|baby|reaction|irritation|swelling|burning|side effects?|allerg\w*|kitni|kitna|lagana|refund|cancel|return)\b|how (?:do i |to )?use|kaise (?:lu|lun|le|lena|lag|use)|कैसे|खुराक|(?:no|don't|do not) (?:show |recommend )?products/i;
const clean=s=>String(s || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
export function safeProductCard(c, appId = 'siya-ayurveda') {
  if(c?.type!=='product' || !/^gid:\/\/shopify\/Product\/\d+$/.test(c.product_id || ''))return null;
  let url,image;
  try{url=new URL(c.url);image=c.image_url?new URL(c.image_url):null}catch{return null}
  const hosts = appId === 'seedfit' ? ['seed.fit','www.seed.fit'] : appId === 'siya-ayurveda' ? ['siyaayurveda.com','www.siyaayurveda.com'] : [];
  if(url.protocol!=='https:' || !hosts.includes(url.hostname) || url.username || url.password || url.port || !/^\/products\/[a-z0-9-]+$/.test(url.pathname))return null;
  const price=String(c.price??'');if(!/^\d+(?:\.\d+)?$/.test(price) || !/^[A-Z]{3}$/.test(c.currency || ''))return null;
  return {type:'product',product_id:c.product_id,title:clean(c.title).slice(0,200),description:clean(c.description).slice(0,240),
    image_url:image?.protocol==='https:' && image.hostname==='cdn.shopify.com' && !image.username && !image.password && !image.port?image.href:'',
    price,currency:c.currency,available:c.available===true,url:url.href};
}
export function createChatProductSearch({domain,storefrontToken,fetcher=fetch, appId: configuredApp = 'siya-ayurveda'}) {
  let products=[],expires=0,pending;
  async function load() {
    if(Date.now()<expires)return products;
    if(pending)return pending;
    pending=(async()=>{
      const all=[];let after=null;const deadline=Date.now()+10000;
      for(let page=0;page<20;page++) {
        const remaining=deadline-Date.now();if(remaining<=0)throw Error('Catalogue timeout');
        const r=await fetcher(`https://${domain}/api/2026-07/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Storefront-Access-Token':storefrontToken},
          body:JSON.stringify({query:`query ChatCatalogue($after:String) { products(first:100,after:$after) {
            nodes { id title handle description tags productType availableForSale featuredImage { url }
              priceRange { minVariantPrice { amount currencyCode } } }
            pageInfo { hasNextPage endCursor } } }`,variables:{after}}),signal:AbortSignal.timeout(Math.min(8000,remaining)),redirect:'error'});
        if(!r.ok)throw Error('Catalogue unavailable');const b=await r.json();
        if(b.errors || !b.data?.products)throw Error('Catalogue unavailable');
        all.push(...b.data.products.nodes);
        if(!b.data.products.pageInfo.hasNextPage)break;
        after=b.data.products.pageInfo.endCursor;
      }
      products=all;expires=Date.now()+300000;return products;
    })().catch(()=>{products=[];expires=Date.now()+15000;return []}).finally(()=>{pending=null});
    return pending;
  }
  return async(message,appId)=>{
    // Seedfit must have its own catalogue integration; never borrow Siya's store.
    if(appId!==configuredApp || !domain || !storefrontToken || privateOrUsage.test(message))return [];
    const text=norm(message),tokens=text.match(/[a-z0-9]{4,}/g)?.filter(t=>!stop.has(t)) || [];
    const concerns=groups.filter(g=>g.some(w=>new RegExp('(?:^|[^a-z])'+w+'(?:$|[^a-z])','u').test(text)));
    if(!tokens.length && !concerns.length)return [];
    const found=(await load()).map(p=>{
      const title=norm(p.title),haystack=norm([p.title,p.productType,...(p.tags||[])].join(' '));
      const score=concerns.reduce((n,g)=>n+(g.some(w=>haystack.includes(w))?10:0),0)+tokens.filter(t=>title.includes(t)).length;
      return {p,score};
    }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score || a.p.title.localeCompare(b.p.title));
    return found.slice(0,3).map(({p})=>safeProductCard({type:'product',product_id:p.id,title:p.title,description:p.description,
      image_url:p.featuredImage?.url || '',url:`https://${appId === 'seedfit' ? 'seed.fit' : 'siyaayurveda.com'}/products/${p.handle}`,
      price:p.priceRange?.minVariantPrice?.amount,currency:p.priceRange?.minVariantPrice?.currencyCode,available:p.availableForSale},appId)).filter(Boolean);
  };
}
