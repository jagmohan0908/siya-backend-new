import {createAuthenticator} from './auth.mjs';
import {MobileService} from './service.mjs';
import {createRewardIssuer} from './shopify.mjs';
import {Razorpay} from './payments.mjs';
import {AppsScriptMeet} from './appointment-meet.mjs';
import {createProductCatalog} from './product-images.mjs';
import {createChatProductSearch} from './chat-products.mjs';
import {requireValue} from './errors.mjs';

// A single deployment serves both apps. Never authenticate a Seedfit request
// with Siya's credentials, even when Seedfit configuration is incomplete.
export function createTenants({erp, env = process.env, fetcher = fetch}) {
  const cache = new Map();
  return appId => {
    requireValue(['siya-ayurveda','seedfit'].includes(appId),'Unknown app ID',400,'invalid_app');
    if (cache.has(appId)) return cache.get(appId);
    const seed = appId === 'seedfit';
    const read = key => env[seed ? `SEEDFIT_${key}` : key];
    const domain = read('SHOPIFY_DOMAIN'), storefrontToken = read('SHOPIFY_STOREFRONT_TOKEN');
    requireValue(domain && storefrontToken,'This app connection is not configured yet.',503,'app_setup_required');
    // Sharing ERP does not imply sharing Shopify, payment accounts, or automation.
    const catalog = createProductCatalog({domain,storefrontToken,fetcher});
    const service = new MobileService({erp,appId,fetcher,
      webhookUrl:read('APPOINTMENT_WEBHOOK_URL'),webhookSecret:read('APPOINTMENT_WEBHOOK_SECRET'),
      s3PresignMethod:env.S3_PRESIGN_METHOD,
      productCatalog:catalog,productImage:async item=>(await catalog(item)).imageUrl,
      chatProducts:createChatProductSearch({domain,storefrontToken,fetcher,appId}),
      payments:new Razorpay({keyId:read('RAZORPAY_KEY_ID'),keySecret:read('RAZORPAY_KEY_SECRET'),fetcher}),
      meetings:new AppsScriptMeet({url:seed ? (read('GOOGLE_MEET_SCRIPT_URL') || '') : read('GOOGLE_MEET_SCRIPT_URL'),fetcher}),
      rewardIssuer:createRewardIssuer({domain,adminToken:read('SHOPIFY_ADMIN_TOKEN'),fetcher})});
    const tenant={service,authenticate:createAuthenticator({domain,storefrontToken,fetcher}),
      allowBookings:read('BOOKINGS_ENABLED')==='true'};
    cache.set(appId,tenant);
    return tenant;
  };
}
