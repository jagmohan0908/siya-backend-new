# Diet and habit access after checkout

The Orders, Diet and habit purchase screens recognize invoices explicitly tracked to the authenticated app account, even when checkout created an invoice under a different ERP Patient. Existing patient-linked purchases and manually assigned encounter diets remain supported.

`purchase-invoices.mjs` validates the existing account, store and brand purchase grants, checks submitted invoices, and includes credit notes against those invoices when calculating diet eligibility. It does not relink Patients or expose another patient's encounters or prescriptions. Diet PDF downloads repeat the same eligibility check. Overlapping patient and tracked invoices are counted once; fully returned items do not grant automatic diet access or habit tracking.

No Flutter API contract, ERP schema, checkout or n8n change is required. Applies to both brands through their existing isolated purchase records. Product-based charts require exact Diet Chart item mappings. Habit check-in storage still requires the user's linked patient profile.

Verification: `node --test test/*.test.mjs` and the commands in `postman/simulations/purchase-access.context.md`.
