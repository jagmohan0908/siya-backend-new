# Checkout ownership contract

Fastrr checkout and the existing order-creation integration stay unchanged.
Checkout phone/contact details are never proof of ownership of the app account.

`POST /v1/checkout-intents?app=siya-ayurveda` requires the existing authenticated
Shopify customer session. Body: `{"items":[{"variantId":"123","quantity":1}]}`.
The backend ignores any client account, patient, phone or order ownership claim.
Response when enabled: `{"enabled":true,"attributes":{"_mobile_checkout_reference":"<opaque reference>"}}`.
When rollout is disabled: `{"enabled":false}`. The app passes attributes through
Fastrr `cartAttributes` with `encodingRequired: true`. No identity or token goes
in these attributes. A reference is valid for an order created within 24 hours,
and can be consumed by only one Shopify order. Failed preparation is retryable.

`POST /v1/shopify-order-created?app=siya-ayurveda` accepts Shopify's `orders/create`
notification. It verifies HMAC-SHA256 against the **original request bytes**, the
store domain, topic, issued reference, time and cart quantities before recording
an order-specific grant. Repeated notifications are idempotent; failed ERP writes
return non-2xx so delivery can retry. Unknown or conflicting references fail closed.
Orders without a reference are acknowledged without linking any account.

ERP invoices become available to the original login through exact
`shopify_order_id` matches after the existing integration creates them. These
grants apply to Orders, invoice details, invoice PDFs and shipment tracking only.
They never grant access to the recipient's Patient, diet, habits or treatment.
Legacy orders without a reference cannot be safely backfilled from phone numbers.

Configuration, independently for each store:

- `CHECKOUT_TRACKING_ENABLED=true` after the notification subscription is working.
- `SHOPIFY_ORDER_WEBHOOK_SECRET`: secret used by Shopify to sign that subscription.
- `SHOPIFY_DOMAIN`: exact `*.myshopify.com` shop domain, already used for login.
- Seedfit uses the same variables with the `SEEDFIT_` prefix and `?app=seedfit`.

Subscribe an additional **Order creation / JSON** notification to the new endpoint;
keep existing n8n notifications. Do not put secrets in app code or commit them.
Enable only after a live test confirms Fastrr preserves the attribute in Shopify.
The historical test invoice cannot be automatically recovered by this future-order
tracking alone. Do not add sample phone numbers or one-off ownership exceptions.
