# App sessions and ERP records

The existing OTP/login exchange stays unchanged. After Shopify verifies that
login, the app exchanges its Storefront token once for an independent mobile API
session. Subsequent ERP requests do not call Shopify for authentication.

## HTTP contract

- `POST /v1/session?app=siya-ayurveda` (or `seedfit`): Authorization Bearer with a
  valid Storefront customer token, JSON `{}`. Returns `token`, `accountId`,
  `expiresAt`. Client-supplied account IDs/phone numbers are not trusted.
- ERP endpoints accept the returned `ma1.` bearer. Older clients can continue
  using Storefront tokens while the new build is rolled out.
- `GET /v1/session`: returns `accountId` after validating the current session.
- `POST /v1/session/logout`, JSON `{}`: revokes the current app session.
- Invalid, revoked or expired credentials return 401. Shopify verification
  failures return 503. ERP outages are service errors, not instructions to
  erase the signed-in account.

Sessions use 256-bit random tokens. Only their SHA-256 digests and verified
identity are stored in the existing Siya Mobile Record doctype, separately per
brand. No ERP schema change, server secret or additional hosting is required.
The encrypted app user store holds the bearer, bound to backend URL, brand and
account. Active sessions extend a 30-day idle lifetime once daily, up to a
180-day absolute lifetime; logout revokes one device. Old revoked Shopify
tokens cannot be used to create a new session.

## Profile and order connection

Profile reconciliation runs on authenticated ERP reads. An unlinked account
can attach a unique active Patient whose number matches the verified login
identity, including a Patient created later by an invoice or appointment.
An explicit clinic unlink is preserved. Duplicate/ambiguous phone matches
do not grant access to unrelated medical histories.

Signed order notifications separately associate a purchase with the account
that initiated checkout. A different delivery number does not transfer the
app login, or automatically grant clinical access to the recipient's profile.

## Rollout

Deploy the backend before the new Flutter build. No n8n/checkout/ERP app source
changes are needed. A still-valid existing login migrates automatically; an
already-invalid login must sign in once to establish its first app session.
Do not restore access by issuing tokens from an unverified phone/account ID.

Run `node --test test/app-sessions.test.mjs test/patient-link.test.mjs` and the
Flutter session/client/restore tests. `test-app-session-simulation.mjs` tests
the real HTTP API against the local identity simulation; it does not establish
that a live mobile release has been installed.
