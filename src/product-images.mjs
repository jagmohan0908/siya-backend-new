// Shopify supplies catalogue images and reorder IDs; quantities and prices stay in ERP.
export function createProductImages(options) {
  const lookup=createProductCatalog(options);
  return async item=>(await lookup(item)).imageUrl;
}

export function createProductCatalog({domain, storefrontToken, version = '2026-07', fetcher = fetch}) {
  const empty=()=>({imageUrl:'',shopifyProductId:''});
  if (!domain || !storefrontToken) return async () => empty();
  let catalog = [], expires = 0, pending;
  const normalize = value => String(value || '').trim().toLowerCase();
  const safeImage = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'cdn.shopify.com' ? url.href : ''; }
    catch { return ''; }
  };
  async function load() {
    if (Date.now() < expires) return catalog;
    if (pending) return pending;
    pending = (async () => {
      const products = []; let after = null;
      for (let page = 0; page < 20; page++) {
        const response = await fetcher(`https://${domain}/api/${version}/graphql.json`, {
          method:'POST', headers:{'Content-Type':'application/json','X-Shopify-Storefront-Access-Token':storefrontToken},
          body:JSON.stringify({query:`query InvoiceImages($after: String) {
            products(first: 100, after: $after) { nodes { id title featuredImage { url }
              variants(first: 100) { nodes { sku image { url } } }
            } pageInfo { hasNextPage endCursor } }
          }`,variables:{after}}), signal:AbortSignal.timeout(10000),redirect:'error',
        });
        if (!response.ok) throw Error('Catalogue unavailable');
        const body = await response.json();
        if (body.errors || !body.data?.products) throw Error('Catalogue unavailable');
        products.push(...body.data.products.nodes);
        if (!body.data.products.pageInfo.hasNextPage) break;
        after = body.data.products.pageInfo.endCursor;
      }
      catalog = products; expires = Date.now() + 5*60_000;
      return catalog;
    })().catch(() => {
      // A missing photo must never prevent access to a patient's invoices.
      expires = Date.now() + 30_000; return catalog;
    }).finally(() => { pending = null; });
    return pending;
  }
  return async item => {
    const products = await load();
    const code = normalize(item.item_code);
    const matches = products.flatMap(p => (p.variants?.nodes || [])
      .filter(v => code && normalize(v.sku) === code)
      .map(v => ({imageUrl:safeImage(v.image?.url || p.featuredImage?.url),
        shopifyProductId:/^gid:\/\/shopify\/Product\/\d+$/.test(p.id || '') ? p.id : ''})));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return empty(); // Ambiguous SKUs need catalogue correction.
    const titles = products.filter(p => normalize(p.title) === normalize(item.item_name));
    return titles.length === 1 ? {imageUrl:safeImage(titles[0].featuredImage?.url),
      shopifyProductId:/^gid:\/\/shopify\/Product\/\d+$/.test(titles[0].id || '') ? titles[0].id : ''} : empty();
  };
}
