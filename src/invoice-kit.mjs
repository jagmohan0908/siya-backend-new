export async function invoiceKit(erp,invoice,productImage=async()=> '',productCatalog) {
  if(!invoice.item_group_template) return null;
  const template=await erp.get('Item Group Template',invoice.item_group_template);
  if (productCatalog) {
    // Shared ERP templates can contain IDs from another Shopify store.
    // Reorder actions and photos must resolve in this app's own catalogue.
    const product=await productCatalog({item_name:template.template_name || template.name});
    return {id:template.name,name:template.template_name || template.name,
      shopifyProductId:product.shopifyProductId || '',imageUrl:product.imageUrl || ''};
  }
  let image='';
  try {
    const url=new URL(template.custom_mobile_image_url);
    if(url.protocol==='https:' && url.hostname==='cdn.shopify.com' && !url.username && !url.password) image=url.href;
  } catch {}
  return {id:template.name,name:template.template_name || template.name,
    shopifyProductId:/^gid:\/\/shopify\/Product\/\d+$/.test(template.custom_shopify_product_id || '') ? template.custom_shopify_product_id : '',
    imageUrl:image || await productImage({item_name:template.template_name || template.name})};
}
