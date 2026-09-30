# Validation record — 2026-09-30

This file distinguishes implemented/tested paths from a live production migration.

## Profile photo synchronization follow-up

- Backend suite: 32 tests passed, including ERP photo replacement/removal,
  attachment ownership, app-to-ERP photo updates, treatment isolation, S3 failure,
  concurrent parent edits, correct signing method, and upload timeout recovery.
- Flutter suite: 25 tests passed. Three new widget tests verify visible/foreground
  refresh, app resume, disabled/hidden screens, and non-overlapping request recovery.
- Updated Android debug APK built successfully against the Render URL. Changed
  Dart files analyzed without errors; existing warnings/style notices remain.
- Live dev test used a separate synthetic Mobile App User, not the customer's
  profile. S3 image download returned 200; selecting/removing the ERP image was
  reflected by the backend profile response. A subsequent app-style upload
  completed in about 40 seconds and updated the ERP image route and app File ID.
- The stable ERP sidebar image route returned 200 with credentials and 403 to
  an unauthenticated request. The original signing path referenced an app absent
  from dev; the installed `sriaas_clinic.api.s3.presign.get_presigned_url` was
  verified and configured as the default.
- These live checks exercised the new backend code locally against dev ERP.
  They do not assert that Render has deployed this new commit or that a phone
  running an older APK has the refresh changes.
- The first upload committed after its 25-second timeout. Later testing used a
  50-second upload timeout. Synthetic cleanup initially timed out/returned 500;
  any remaining fixture uses account
  `integration-test:profile-photo-82bd36d5-93dc-4980-a155-bd3321502694`.

The earlier staged-migration results below are retained as historical context;
the photo follow-up above supersedes their unverified S3-download status.

This standalone repository contains the backend and its 24-test suite. The
backend suite was rerun successfully after extraction. Flutter and live ERP
results below describe the earlier integration checks in the app repository;
they are not claims that this Render deployment has already been tested live.
The standalone server entrypoint also passed a local environment-based startup
check with `HOST=0.0.0.0` and an assigned port: `/health` returned 200 and an
unauthenticated `/v1/profile` request returned 401. That check used placeholder
provider credentials and made no external provider requests.

## Completed checks

- Node backend suite: 24 tests passed. Covers verified identity, token rejection,
  ownership boundaries, stale writes, queue recovery, uncertain webhook delivery,
  booking idempotency, ERP status mapping, fixed server pricing, existing clinic
  occupancy, assessment idempotency, private-file ownership, invalid image content,
  invoice access, protected profile fields, Razorpay capture/amount/order ownership,
  repeated payment-order preparation, daily versus weekly habit frequency, and
  the default-disabled booking write gate.
- Full Flutter suite: 22 tests passed, including Approved and Checked In
  regression cases and three ERP screen widget tests for diet content,
  separate billing/shipping states and patient-link errors.
- Changed Dart files analyzed without compilation errors. Existing lint warnings
  remain in legacy files (unused imports/fields, null assertions, and style rules).
- An Android debug APK with the emulator backend URL compiled successfully.
- Local backend health and live ERP doctor listing passed. Two configured doctors
  returned, Megha fee 0, timezone Asia/Kolkata.
- Dev ERP authentication, doctor schedules, availability, additive DocType creation,
  synthetic record create/read/update, stale-revision rejection, and cross-account
  key isolation passed.

## Not yet verified live

- Successful authenticated app login → full clinical/billing history: needs a
  representative test customer with a reviewed Patient/Customer mapping.
- Actual paid checkout and discount issuance/redemption: test keys/Admin discount
  credentials are not configured. Automated tests use injected provider responses.
- Actual appointment webhook/video flow: needs confirmation of a dev-only webhook.
  No real appointment, Meet invitation, customer notification, payment, or discount
  was created during these tests.
- Concurrent bookings from every ERP channel: existing ERP does not apply the same
  reservation transaction to all those channels; see README release prerequisites.
- A live simultaneous record-update test timed out for both requests. Atomic ERP
  concurrency validation is therefore unverified; do not interpret the local
  mocked concurrency tests as proof of live ERP transaction behavior.
- File upload/S3: the original large PNG received HTTP 413. Optimized JPEGs were
  produced; the subsequent dev upload timed out. S3 success has not been claimed.
  The `review_assets` ERP record was created; its upload state needs reconciliation.
- Synthetic `kind=smoke`, `account=integration-test:*` record cleanup timed out on
  both REST DELETE and `frappe.client.delete`. The record contains only synthetic
  numeric test data. Do not delete any real patient records to clear it.
- Bulk legacy data migration, offline habit merging, reward redemption sync and
  abandoned payment reservation expiry remain production-cutover prerequisites.

The existing ERP app source and production app configuration were not changed.
The new custom DocType and synthetic/asset records were added only to dev ERP.
