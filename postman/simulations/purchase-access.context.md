# Purchase access verification

Run `postman simulation run postman/simulations/purchase-access.sim.yaml --port 4913 --no-history --output ndjson`, then `node scripts/test-purchase-access-simulation.mjs`.

The real backend HTTP routes, app sessions, purchase grants, diet/PDF and habit services use synthetic Frappe HTTP records. The app Patient and invoice Patient deliberately differ. No live customer or ERP writes are made. The script checks purchase eligibility and its revocation, not a production deployment or device rendering. Unsupported ERP types return 501 so missing mock coverage cannot pass as an empty list.
