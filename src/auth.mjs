import {ApiError, requireValue} from './errors.mjs';

// Identity is obtained from Shopify, never from a phone/email/customer ID supplied by Flutter.
export function createAuthenticator({domain, storefrontToken, version = '2026-07', fetcher = fetch}) {
  requireValue(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain || ''), 'Set SHOPIFY_DOMAIN to the store myshopify.com hostname');
  requireValue(storefrontToken, 'Set SHOPIFY_STOREFRONT_TOKEN');
  return async function authenticate(header) {
    const match = /^Bearer ([^\s]{10,4096})$/.exec(header || '');
    requireValue(match, 'Please sign in again', 401, 'unauthenticated');
    let data;
    try {
      const response = await fetcher(`https://${domain}/api/${version}/graphql.json`, {
        method: 'POST', headers: {'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': storefrontToken},
        body: JSON.stringify({query: 'query MobileIdentity($token: String!) { customer(customerAccessToken: $token) { id firstName lastName email phone } }', variables: {token: match[1]}}),
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Identity provider unavailable');
      data = await response.json();
    } catch {
      throw new ApiError(503, 'identity_unavailable', 'Sign-in verification is temporarily unavailable. Please try again.');
    }
    // GraphQL can return HTTP 200 for throttling and execution failures.
    // Only an explicit null customer without errors proves an invalid session.
    if (!data?.data || !Object.hasOwn(data.data, 'customer') ||
        (Array.isArray(data.errors) ? data.errors.length > 0 : Boolean(data.errors))) {
      throw new ApiError(503, 'identity_unavailable', 'Sign-in verification is temporarily unavailable. Please try again.');
    }
    const customer = data.data.customer;
    requireValue(customer !== null, 'Please sign in again', 401, 'unauthenticated');
    if (typeof customer?.id !== 'string' || !customer.id.startsWith('gid://shopify/Customer/')) {
      throw new ApiError(503, 'identity_unavailable', 'Sign-in verification is temporarily unavailable. Please try again.');
    }
    return {id: customer.id, email: customer.email || '', phone: customer.phone || '',
      name: [customer.firstName, customer.lastName].filter(Boolean).join(' ')};
  };
}
