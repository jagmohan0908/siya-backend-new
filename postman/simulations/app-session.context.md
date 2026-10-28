# App-session HTTP verification

Uses the existing synthetic Shopify identity and Frappe record-storage mocks.
The real Node API, authenticator, Records and ERP HTTP client run locally.

```powershell
postman simulation run postman/simulations/app-session.sim.yaml --port 4912 --no-history --output ndjson
node scripts/test-app-session-simulation.mjs
```

Expected: one successful initial Shopify query and one rejected initial query;
intervening app-session reads/revocation use Frappe HTTP only. An established
session survives a revoked/unavailable Shopify provider. Explicit logout
persists and prevents access. No live accounts, orders or medical data are used.
This does not prove a production deploy or a device build is installed.
