# Invoice department separation

Orders use `Sales Invoice.sr_si_patient_department` in addition to existing customer ownership.

- Seedfit: Varicocele, EDPME, Dr health, Seed.fit.
- Siya Ayurveda: Skin/Fertility/Liver/IBS, Siya OPD, Arthritis, Siya Essentials, Siya Ayurveda.

Blank, unknown and other-app departments are excluded. The ERP filter runs before pagination on both patient/customer and tracked-purchase queries. The full document is checked again for list rendering, invoice details, PDF downloads and shipment refresh. Knowing an invoice ID or sharing a patient does not override the department boundary. The department does not establish customer ownership.

Legacy Sales Orders have no invoice department on the current ERP and are not listed independently; their submitted Sales Invoice becomes eligible after classification. No Flutter or ERP source change is required. This change does not configure checkout tracking or assign diet charts.

## Verification (2026-10-29)

- Department regression tests cover all nine values, missing values, shared patients, ownership, purchase grants, direct details/PDF/tracking and three-page pagination.
- The full local backend test suite passed.
- `node scripts/test-invoice-departments-simulation.mjs` runs real backend HTTP routes and the real ERP HTTP client against the existing Postman purchase-access simulation. Both apps return 45 matching invoices across three pages and reject foreign/blank departments and an unrelated patient. The synthetic identity is fixed for this filtering test; it does not test production sign-in.
- `node scripts/test-purchase-access-simulation.mjs` still passes the existing tracked-purchase eligibility and revocation checks.
- Live read-only ERP queries returned ERP/26/035659 (Seed.fit) only for Seedfit and ERP/26/035138 (Siya Ayurveda) only for Siya. SINV-26-00102 has no department and matched neither.
- No production backend deployment or device UI verification has been performed for this change.

Run the simulation with `postman simulation run postman/simulations/purchase-access.sim.yaml --port 4913 --no-history --output ndjson`, then run the two scripts above. Node fetch uses the configured local route URL because this client does not configure a forward proxy.
