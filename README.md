# Siya mobile API — staged ERP migration

This service mediates Flutter → ERPNext. ERP remains the business database; the
service has no separate patient database. Shopify continues to own catalog,
checkout, login-token verification, and issued discount codes. ERP File records
own S3 attachment metadata. n8n remains responsible for appointment automation.

**This is a staged implementation, not a completed production cutover.** Debug/IDE
builds default to `https://siya-backend-new.onrender.com` so a normal restart does
not switch profile uploads back to Supabase. Release/profile builds still require
`--dart-define=MOBILE_API_BASE_URL=https://siya-backend-new.onrender.com` for the
staged API. An explicit empty define selects the legacy build for comparison.
Configured builds never silently fall back to Shopify/Supabase for ERP records.
The reference `mobile_app` ERP source has not been modified.

## Repository layout

This standalone repository was extracted from `mobile_backend/` in
`jagmohan0908/siyaayurveda_app` at commit `99004f18837f7c02c3998dcb34e0f522bd6289ed`.
The Flutter app remains in that separate repository. Backend deployment changes
belong in this repository; changes here do not automatically update the old copy.

## Render development deployment

Connect `jagmohan0908/siya-backend-new` as a new Render Web Service, or use its
`render.yaml` with New > Blueprint. Use a separate development service so the
existing backend keeps running. The supplied Blueprint uses the free plan for
development and manual deployments.

For a manually created Web Service:

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Root directory | Leave blank (backend is at the repository root) |
| Runtime | Node |
| Build command | `npm test` |
| Start command | `npm start` |
| Health check path | `/health` |

Set `NODE_VERSION=22`, `HOST=0.0.0.0`, `BOOKINGS_ENABLED=false`,
`ERP_URL=https://dev-sr.butest.tech`, plus `ERP_TOKEN`, `SHOPIFY_DOMAIN`, and
`SHOPIFY_STOREFRONT_TOKEN` in Render's Environment settings. `ERP_TOKEN` is
`api_key:api_secret` without a `token ` prefix. The Shopify domain must be the
`your-store.myshopify.com` hostname. Let Render supply `PORT`.

The real local `.env` is not included in this repository. Transfer its settings
directly into Render, not into tracked files. Add optional webhook, Razorpay test,
Shopify Admin, and browser CORS settings from `.env.example` when those features
are ready for testing. Keep booking writes disabled until the release
prerequisites below are resolved. `/health` only checks that the process is up.

After deployment, verify `/health` and `/v1/doctors`, then test authenticated flows
with a reviewed test patient. Use the resulting HTTPS URL as the Flutter build's
`MOBILE_API_BASE_URL` in the app repository. No Render database is required: ERP
remains the database. This deployment does not complete production migration.

References: [Render Web Services](https://render.com/docs/web-services),
[Blueprint configuration](https://render.com/docs/blueprint-spec).

## Running locally

Requires Node 22.13+; no npm runtime dependencies. Copy `.env.example` to `.env`
and configure server secrets locally. `.env` is ignored by Git and Docker.

```powershell
cd siya-backend-new
npm run setup:erp
npm start
```

`setup:erp` adds one custom DocType, **Siya Mobile Record**, restricted to System
Manager. It never changes existing ERP DocTypes or app source. Before production,
use a dedicated integration user with only the required ERP permissions.

Run behind TLS, with one service process during the staged rollout. Restrict web
origins with `CORS_ORIGINS`. Use the native app's Shopify customer access token as
`Authorization: Bearer …`; the backend verifies it with Shopify. Do not use a
phone number, Supabase email-exchange token, or the literal `shiprocket_session`
as authentication. Customer Account API tokens need a separate verified adapter
before that login mode can use this backend.

```powershell
flutter run --dart-define=MOBILE_API_BASE_URL=http://10.0.2.2:8787
```

The local HTTP exception is restricted to localhost and the Android emulator.
Use HTTPS for a remotely hosted backend. Never include ERP, Razorpay secret, or
Shopify Admin credentials in Dart defines or the APK.

## Implemented routes

| Route | Behavior |
| --- | --- |
| `GET /health` | Process health; not a claim that all integrations are ready |
| `GET /v1/doctors` | ERP practitioner profiles, charges, online eligibility, diseases and schedule days |
| `GET /v1/doctors/:id/slots?date=YYYY-MM-DD` | ERP capacity plus conservative filtering of existing Clinic Appointments |
| `GET /v1/review-avatars` | Signed URLs for the fixed, public Indian illustration asset records |
| `GET /v1/profile`, `PUT /v1/profile` | Customer-scoped profile with optimistic revision checks |
| `POST /v1/appointment-orders` | Reserve a slot, persist the booking, create a server-priced Razorpay order |
| `POST /v1/appointments`, `GET /v1/appointments` | Create/reconcile bookings and retrieve current ERP status/Meet link |
| `POST /v1/appointments/:id/requests` | Cancel in ERP with verified readback; rescheduling remains a clinic review request |
| `GET /v1/diets` | Patient encounter charts and diet charts matched to purchased ERP items |
| `GET /v1/diets/:id/pdf` | Download an assigned diet chart PDF after verifying patient access |
| `POST /v1/treatments`, `GET /v1/treatments` | Versioned questionnaire, answers, result text and attachment references |
| `GET /v1/habits`, `PUT /v1/habits` | ERP tracker persistence; today's entries, server-calculated streak, revision conflicts |
| `POST /v1/files`, `GET /v1/files/:id` | Private image upload through ERP File→S3; ownership checked before signing |
| `GET /v1/orders?cursor=0` | Submitted Sales Invoices/credit notes and explicitly authorized unbilled Sales Orders |
| `GET /v1/invoices/:id`, `GET /v1/invoices/:id/pdf` | Ownership-checked invoice details and PDF |

Normal versioned writes use `{ "data": {…}, "revision": 0 }`. A stale save returns
409 and must be refreshed, not silently overwritten. The ERP `modified` timestamp
is also supplied on updates for Frappe's server-side concurrency check.

## Identity and historical patient linking

A verified Shopify customer ID maps to an ERP Mobile App User. An existing single
Patient link on that user's profiles can be reused. **Phone/email matching alone
does not grant access to clinical history or invoices.** Unlinked accounts can
save app records but receive `patient_link_required` for clinical/billing history.

The operator-only `scripts/link-patient.mjs` validates a reviewed mapping. Set
`SHOPIFY_CUSTOMER_ID` to the full customer GID and `ERP_PATIENT_ID` to the ERP
patient. It defaults to dry run. Set `APPLY_LINK=1` to save. Setting
`AUTHORIZE_CUSTOMER_INVOICES=1` additionally authorizes that patient's Customer
account, including invoices without a Patient field and unbilled Sales Orders.
Do this only when ownership of that entire Customer account is established.
Run mapping/migration operations during a maintenance window.

No bulk phone-based migration has been performed. Existing Hive, Sheets and
Supabase records remain in place. Their reviewed ownership mapping and import
are prerequisites to a production cutover. Family profiles with multiple Patients
need an explicit profile selector/mapping before exposing their historical data.

## Booking and automation contract

`id` is a stable UUID reused across payment preparation, payment completion and
retries. ERP reservations are deterministic per account/UUID. Paid appointments
require Razorpay order ownership, amount, INR currency, captured status, and no
refund. The service records webhook intent before POST and never blindly repeats
an uncertain delivery. It reconciles the encounter by the unique external ID in
`sr_notes` when the app retrieves appointments.

Configure a **dev-only** `APPOINTMENT_WEBHOOK_URL` for testing. The current app's
`appointment_eternity` URL was deliberately not copied into the local dev env
because its target ERP/environment has not been confirmed. An optional
`APPOINTMENT_WEBHOOK_SECRET` is sent as `X-Mobile-Webhook-Secret`.
Appointment writes also require `BOOKINGS_ENABLED=true`; leave it false until
the deployment checks below pass. This prevents accidentally enabling bookings
by merely configuring an API URL or webhook.

The webhook receives the booking ID, stable ERP doctor ID, reservation reference,
patient/contact information, fee, payment reference/status and consultation mode.
Free bookings are automatically confirmed after the Mobile App Appointment is
saved and read back as Confirmed in Frappe. Paid bookings require verified payment
capture first. A confirmed response includes `reservation`, `status: confirmed`,
and `bookingSyncPending: false`; the app displays "Booking confirmed" and
"Your appointment is confirmed. Our team will contact you soon."

Encounter synchronization is separate (`encounterSyncPending: true` until linked).
The webhook must return the saved Patient Encounter (single object or one-item
array), retain `External appointment ID: <id>` in `sr_notes`, and persist the video
Meet link in ERP's `google_meet_link`. The backend rereads that encounter before
linking it. A newly created Pending encounter does not downgrade a confirmed
reservation. Clinic cancellation, check-in and completion remain distinct states.
A webhook timeout does not undo a confirmed reservation or trigger another POST.
Failed or unverified Frappe saves still show verification pending in the app.

Before enabling live appointment writes, finish these deployment checks:

- All ERP booking channels must share capacity validation/locking. The current
  ERP Mobile App Appointment hook locks mobile reservations; the additional
  Clinic Appointment read here is **not atomic with simultaneous staff bookings**.
  A shared ERP transaction/validation hook is still needed for all channels.
- Configure abandoned-payment hold expiry and recovery of payment-order timeouts.
  This staging service retains uncertain reservations for reconciliation instead
  of releasing a potentially paid appointment or charging again.
- Confirm the n8n workflow uses stable ERP doctor IDs, preserves reservation links,
  creates a video link once, and can reconcile a response lost after commit.
- Cancellation uses `mobile_app.api.appointment_calendar` to cancel the owned
  reservation and matching Patient Encounter, including its linked Clinic Appointment.
  The integration account needs permission to cancel through that API. Successful
  responses have `status: Completed` and the verified cancelled `appointment`;
  failed/partial operations can be retried with the same request ID. Late encounters
  are cancelled during history reconciliation. Payment refunds are not automated.
- Have the clinic process pending reschedule `appointment_request` records.

## Habit rewards

The backend ignores client-supplied reward codes and streak counts. A clinic-owned
`habit_plan` record for the account must contain the approved `habitIds` before
automatic reward issuance. `SHOPIFY_ADMIN_TOKEN` needs discount read/write scopes.
After 30 days the backend creates a deterministic, customer-restricted 5% code,
one use, valid 90 days. It looks up the code before retrying Shopify creation.
Progress is saved before contacting Shopify so a provider failure cannot erase it.

Daily streaks follow the app's kit frequencies and exclude weekly products.
Legacy streak/reward migration, clinical plan
assignment, redemption-status synchronization and offline event merging require
validation before enabling rewards for existing users. The app does not invent
new local discount codes when using this backend.

## Files and images

Profile photos are synchronized through **Mobile App User.image**. An app upload
updates this field after its private File reaches S3. The value is a stable ERP
download route (not an expiring S3 link), so authenticated Desk users can display
the sidebar photo. The API also accepts the raw S3 File URL selected by Desk,
checks that the File belongs to this user, and returns its File ID. Removing the
ERP image clears the app photo; old app/Supabase photo caches do not override it.

The Flutter profile refreshes when opened or resumed and every 30 seconds while
visible in the foreground. An unsaved photo selection is preserved. This is
periodic refresh, not an instantaneous push notification.

`S3_PRESIGN_METHOD` defaults to
`sriaas_clinic.api.s3.presign.get_presigned_url`, verified against dev ERP. Set it
to the installed method if another environment uses a different ERP app module.
Uploads allow 50 seconds for ERP/S3 and reconcile a timed-out request by its
unique filename and verified owner before returning an error. They never blindly
repeat the upload. Deploy the updated backend and rebuild the app for this flow.

The ERP S3 pipeline must be configured and healthy. Private app uploads are linked
to the verified Mobile App User; clients cannot provide an arbitrary ERP owner.
The API checks image magic bytes and rejects uploads that did not reach S3.
Only stable File IDs are stored; download links expire.

`scripts/publish-review-assets.mjs` publishes the two generated illustrations and
stores their File IDs in a fixed ERP record. It checks for an existing upload
before retrying. The app has bundled JPEG fallbacks. The existing example review
content is labelled **Sample review**, never presented as a verified testimonial.
Production testimonials should use consented reviewer images and approved text.

## Tests and rollout

```powershell
npm test
npm run check:dev
# Synthetic record CRUD/concurrency test; restricted to dev-sr.butest.tech:
$env:DEV_TEST_WRITES='1'
npm run check:dev
```

From the app root:

```powershell
flutter test --no-pub
flutter build apk --debug --no-pub --dart-define=MOBILE_API_BASE_URL=http://10.0.2.2:8787
```

See `TESTING.md` for observed results and live checks still blocked. Do not enable
the production Dart define until account mapping, data migration, cross-channel
booking concurrency, storage, payments, rewards, and representative invoices have
passed end-to-end tests. Rolling back the Dart define returns to the old integration;
ERP records created by the new service remain available for reconciliation.

Protocol references: [Frappe REST](https://docs.frappe.io/framework/user/en/api/rest),
[Shopify customer verification](https://shopify.dev/docs/api/storefront/latest/queries/customer),
[Shopify discount creation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/discountCodeBasicCreate),
[Razorpay payment verification](https://razorpay.com/docs/api/payments/fetch-with-id/).


## Local ERP through ngrok

The current development ERP root is `https://emission-stable-jackknife.ngrok-free.dev`.
Use that origin as `ERP_URL`, without `/app/doctor-clinical`. The Flutter app still
connects to the Render mobile API; do not put the ERP origin or token in Flutter.

Set `ERP_URL` and the **local ERP** integration account's `ERP_TOKEN` in Render's
Environment settings as well as the ignored local `.env`. A Git push does not
upload `.env` or change Render environment variables. Keep `BOOKINGS_ENABLED=false`
until the booking workflow targets this same ERP and passes its existing checks.
The local Frappe server and ngrok tunnel must both be running for Render to reach it.

Run `npm run setup:erp` on the selected ERP once to add the app's storage DocType,
then `npm run check:dev`. The smoke check allows the original dev host and this
specific ngrok host; writes still require `DEV_TEST_WRITES=1` explicitly.
The local account needs access to Healthcare Practitioner, Practitioner Schedule,
Patient Appointment, Doctor Availability Exception, Mobile App User, Mobile App
Appointment, Clinic Appointment, Siya Mobile Record, Patient, Patient Encounter,
Diet Chart, Sales Invoice, Sales Order, File, and the configured S3 signing method.
Existing doctypes retain their ERP permissions; the backend never bypasses them.

This is a different ERP database. Confirm existing account/patient links, historical
app records and S3 files before switching users; changing the URL does not migrate
these records. Point n8n's ERP connection at the same database before enabling bookings.

For ngrok hosts, API, upload and PDF requests send the documented
[`ngrok-skip-browser-warning` header](https://ngrok.com/abuse#browser-warning).
ERP authentication remains required.


Doctor details and charges are read from Healthcare Practitioner records on each
refresh and before new bookings. `op_consulting_charge` applies to consultations;
`custom_accept_opd_appointments` and `custom_accept_online_appointments` independently
control OPD and online (video/audio). The API returns `opd`, `online`, `all`, or
`none` as `availableConsultationType`, plus both boolean flags. With neither
enabled, `isAvailable` is false, slots are empty and new bookings are blocked.
Older ERP installations without the OPD field retain their previous OPD default.
The app refreshes these settings and rechecks them before booking. Active practitioners with ERP schedules/exceptions and the requesting app's disease tag appear automatically.
No static doctor price or mode policy is used. Existing paid bookings retain their
saved quote. The app retains its statistics and reviews for existing doctors.

`GET /v1/doctors/:id/photo` serves only the selected image attached to that
practitioner, via authenticated ERP download. Local ERP images and S3 images are
supported by this doctor-photo route; patient profile storage is unchanged.

## Shared doctor catalogue for Siya Ayurveda and Seedfit

Both apps use the same backend. Doctor routes and new appointment/order requests
accept `?app=siya-ayurveda` or `?app=seedfit`. The backend matches the exact
`Healthcare Practitioner.sr_diseases[].disease` value: `Siya Ayurveda` or `Seedfit`.
A practitioner with both tags appears in both apps; unrelated or untagged doctors
appear in neither. Unknown/empty app IDs are rejected. Requests without `app`
retain the Siya Ayurveda default for installed older versions.

This filter applies to lists, photos, slots and new bookings. Photo URLs carry
the app ID, and reservations/webhook payloads record `appId`. Tag changes take
effect on the next refresh; existing bookings and cancellation remain accessible.
Online eligibility and charges still come from ERP. The app selector is a public
catalogue filter, not authentication or authorization for patient records.

For Flutter, set `MOBILE_APP_ID` at build time alongside `MOBILE_API_BASE_URL`:

```text
--dart-define=MOBILE_APP_ID=siya-ayurveda
--dart-define=MOBILE_APP_ID=seedfit
```

Choose one ID for each build. This repository defaults to Siya Ayurveda. A
separate Seedfit client must send `app=seedfit` on doctor/slot/booking/order
requests and use returned photo URLs. Seedfit login configuration is separate
from this catalogue filter; the backend's existing Shopify authentication remains
unchanged and must match the store used by that client.

## Order details, product images and tracking

Order lists and invoice details include the authorized invoice's patient name,
mobile number, patient ID, every line item, totals and available shipment details.
Billing values always come from ERP. Shopify Storefront supplies images matched
by exact variant SKU, or an unambiguous exact product title. Catalogue images
are cached for five minutes; missing/ambiguous products or Shopify outages leave
a placeholder without blocking invoices. No clinical data is sent to Shopify.

`POST /v1/invoices/:id/tracking` verifies invoice ownership before consulting
`Shipment Tracking Shipment`. It refreshes through the installed
`shipment_tracking.api.tracking.sync_tracking_for_invoice` only when a shipment
exists and ERP enables manual refresh. It never creates or dispatches shipments.
A carrier failure returns the saved tracking snapshot with `refreshState:
unavailable`; absent tracking is omitted. The app reads fresh orders on entry,
resume and pull-to-refresh, and refreshes carrier tracking when opening an invoice.
The app displays billing and delivery separately and downloads the ERP invoice PDF.

### Diet charts from purchased medication

On each ERP Diet Chart, select the exact products in `custom_items` (Items) and
attach the PDF in `custom_diet_chart_pdf`. The API matches these item codes against
submitted Sales Invoices for the signed-in account's verified Patient. Drafts,
cancelled invoices, other patients and fully returned item quantities do not grant
automatic charts. Item Group Templates are not expanded by this endpoint; select
the eligible Items explicitly.

Assignments are resolved from ERP on each read, so existing purchases qualify and
mapping changes appear on refresh without changing encounters or invoice records.
Each chart appears once, with matched product names and `autoGenerated: true` for
purchase matches. An existing encounter assignment takes precedence for the same
chart and is displayed as clinic-assigned. The service selects clinic-authored
charts; it does not generate medical advice or infer a diagnosis from product names.

The app refreshes charts on opening, resuming and manual refresh, explains automatic
selection, and offers the attached PDF. Downloads recheck patient eligibility and
proxy only PDF uploads on the configured ERP host; credentials and attachment URLs
are not sent to the app. Remote/S3 PDF links need a separate supported signing flow.
