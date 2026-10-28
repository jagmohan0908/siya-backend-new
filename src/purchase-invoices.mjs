// Purchase access uses the same account/brand grants as Orders. It never links
// another Patient or grants access to that patient's encounters/prescriptions.
export async function trackedInvoices(service, user, {returns = false} = {}) {
  const ids = await service.checkoutTracking.ids(user);
  const invoices = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    for (let offset = 0; ; offset += 100) {
      const rows = await service.erp.list('Sales Invoice',
        {docstatus:1, shopify_order_id:['in', ids.slice(i,i+50)]}, ['name'],
        {offset,limit:100,order:'name asc'});
      for (let j = 0; j < rows.length; j += 4) {
        const docs = await Promise.all(rows.slice(j,j+4).map(row => service.erp.get('Sales Invoice',row.name)));
        for (const doc of docs) {
          if (doc.docstatus === 1 && !doc.is_return && await service.checkoutTracking.owns(user,doc)) {
            invoices.set(doc.name,doc);
          }
        }
      }
      if (rows.length < 100) break;
    }
  }
  if (returns) for (const invoice of [...invoices.values()]) {
    for (let offset = 0; ; offset += 100) {
      const rows = await service.erp.list('Sales Invoice',
        {docstatus:1,is_return:1,return_against:invoice.name},['name'],{offset,limit:100,order:'name asc'});
      for (let j = 0; j < rows.length; j += 4) {
        const docs = await Promise.all(rows.slice(j,j+4).map(row => service.erp.get('Sales Invoice',row.name)));
        for (const doc of docs) if (doc.docstatus === 1 && doc.is_return && doc.return_against === invoice.name) {
          invoices.set(doc.name,doc);
        }
      }
      if (rows.length < 100) break;
    }
  }
  return [...invoices.values()];
}
