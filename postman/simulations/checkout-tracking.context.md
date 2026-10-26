# Simulation context ? checkout-tracking

Generated and exercised 2026-10-26.

## Purpose

Exercises the real mobile HTTP API and Erp HTTP client against a local Frappe
record-store simulation. See `../mocks/checkout-erp/default.js` for the modeled
REST envelope, missing documents and unique record keys.

## Execution

From `mobile_backend`, in separate terminals:

```sh
postman simulation run postman/simulations/checkout-tracking.sim.yaml --port 4918 --output ndjson
node scripts/test-checkout-simulation.mjs
```

Stop the simulation with Ctrl+C. The runner resets only its local mock state.
Set `SIMULATION_ERP_URL` if the simulation uses a different address.

## Assumptions

- Port 4918 must be available. Mock state is namespaced with `checkout-erp:`.
- This models Frappe record persistence, not live permissions or validation hooks.
- Shopify deliveries are signed local fixtures based on its documented order
  notification fields. This does not establish that Fastrr preserves attributes
  through a live purchase, or that Shopify has subscribed to our endpoint.
- Live checkout metadata and notification delivery still need a merchant test.

## Observations

<!-- begin:observations -->
- 2026-10-26: The ERP member received real GET/POST/PUT requests. A simulated
  grant-write failure returned 502; retry recovered the grant, a duplicate
  notification did not duplicate ownership, and another account saw no grant.
<!-- end:observations -->

## What didn?t work

- Hosted Postman webhook capture requires sign-in here. Local simulation works
  without it; no production customer data was sent to a hosted capture URL.
