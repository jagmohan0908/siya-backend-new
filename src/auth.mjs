import {ApiError, requireValue} from './errors.mjs';

// Identity is obtained from Shopify, never from a phone/email/customer ID supplied by Flutter.
export function createAuthenticator({domain, storefrontToken, version = '2026-07', fetcher = fetch}) {
  requireValue(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain || ''), 'Set SHOPIFY_DOMAIN to the store myshopify.com hostname');
  requireValue(storefrontToken, 'Set SHOPIFY_STOREFRONT_TOKEN');
  return async function authenticate(header) {
    const match = /^Bearer ([^\s]{10,4096})$/.exec(header || '');
    requireValue(match, 'Please sign in again', 401, 'unauthenticated');
    const response = await fetcher(`https://${domain}/api/${version}/graphql.json`, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': storefrontToken},
      body: JSON.stringify({query: 'query MobileIdentity($token: String!) { customer(customerAccessToken: $token) { id firstName lastName email phone } }', variables: {token: match[1]}}),
      signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new ApiError(503, 'identity_unavailable', 'Sign-in verification is temporarily unavailable');
    const data = await response.json();
    const customer = data.data?.customer;
    requireValue(customer?.id?.startsWith('gid://shopify/Customer/'), 'Please sign in again', 401, 'unauthenticated');
    return {id: customer.id, email: customer.email || '', phone: customer.phone || '',
      name: [customer.firstName, customer.lastName].filter(Boolean).join(' ')};
  };
}
