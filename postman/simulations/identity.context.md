# Identity failure classification

Local mock of the existing Storefront customer query contract. No owner-published mock or credentials used.

From mobile_backend, run:

```powershell
postman simulation run postman/simulations/identity.sim.yaml --port 4911 --no-history --output ndjson
node scripts/test-identity-simulation.mjs
```

Seven synthetic HTTP scenarios verify that only explicit customer:null without GraphQL errors returns 401; provider failures remain retryable 503s. No live customer token is used. Check the simulation log for seven POSTs to /api/2026-07/graphql.json.
