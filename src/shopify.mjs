import {requireValue} from './errors.mjs';
export function createRewardIssuer({domain, adminToken, version = '2026-07', fetcher = fetch}) {
  if (!adminToken) return undefined;
  async function query(query, variables) {
    const response = await fetcher(`https://${domain}/admin/api/${version}/graphql.json`, {
      method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':adminToken},
      body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(15000),redirect:'error',
    });
    requireValue(response.ok,'Reward service is temporarily unavailable',503);
    const result = await response.json();
    requireValue(!result.errors,'Reward service is temporarily unavailable',503);
    return result.data;
  }
  return async (user, reward) => {
    const existing = await query('query Reward($code: String!) { codeDiscountNodeByCode(code: $code) { id } }',{code:reward.code});
    if (existing.codeDiscountNodeByCode) return;
    const result = await query('mutation Reward($input: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { code } } }',{
      input:{title:`Habit reward ${reward.id}`,code:reward.code,startsAt:reward.createdAt,endsAt:reward.expiresAt,
        context:{customers:{add:[user.id]}},customerGets:{value:{percentage:0.05},items:{all:true}},
        usageLimit:1,appliesOncePerCustomer:true,combinesWith:{orderDiscounts:false,productDiscounts:false,shippingDiscounts:false}},
    });
    requireValue(result.discountCodeBasicCreate?.codeDiscountNode?.id && !result.discountCodeBasicCreate.userErrors?.length,
      'Reward could not be issued. Your progress has been retained.',503,'reward_pending');
  };
}
