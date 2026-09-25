# Sprint Dinuguan — Odoo ↔ Internal Calculator: change log and deployment plan

Stories 064A, 064B, 064C, 064E, 064G, 064I, 064J, 064K, 064L from the Product User Story Tracker.
Built against the Odoo.sh **staging** build first; this document is the record for the production deployment.

Odoo instance facts that shaped the design (verified 2026-09-25 over JSON-RPC):

- Odoo 18.0 Enterprise on Odoo.sh. Studio, Subscriptions, CRM, Sales, Inventory installed.
- Python-code server actions and inbound webhooks are enabled and already in use.
- The "New Quotation" button lives on the **CRM Opportunity** form (`sale_crm.crm_case_form_view_oppor`), not on the quotation.
- The "bill generation schedule" is Odoo Subscriptions: the on-change automation *Sales Order Payment Terms Auto* (id 141) sets the Monthly plan and an end date from the payment-term name; the monthly invoice amount is the recurring order line's unit price.
- Odoo.sh **neutralises** staging builds, which deletes copied API keys. A key must be generated on the staging build itself.

## Product decisions (refinement, 2026-09-25)

| Question | Decision |
|---|---|
| Is an Odoo lead mandatory to generate a PDF? | No. With a lead id the proposal is attached; without one nothing is sent to Odoo. |
| Rep edits the customer name in the calculator | Leave the Odoo contact untouched. |
| Regenerated PDF | A **new** quotation every time. |
| Salesperson on the quotation | The signed-in calculator user (matched by email to `res.users`); falls back to the lead's salesperson. |
| Odoo down while generating | The PDF still generates; the calculator shows a warning banner. |
| BOQ "Product" column | Free text for now (the item-master mapping is story 064H, still a spike). |
| Hide "New Quotation" for | Everyone, Finance and Admin included. |
| 064E monthly figure | The calculator's own amortisation, which already nets out the down payment. |

Open for review after staging: the **quantity rules** in `InternalCalcFrontEnd/src/lib/boq.js` (counts for panels, batteries, racks, inverters, 2F rows and RSD; metres for excess cable; one lot for every bundled line), and the **product type** of the three package products (created as Goods to match the existing "Solar PV System NkWp" products, so a confirmed order raises a delivery).

## What changed

### Odoo (applied by `scripts/odoo/apply-dinuguan.mjs`, recorded in `scripts/odoo/manifests/<database>.json`)

| Story | Records | Notes |
|---|---|---|
| 064G | `product.template` × 3: *A. Solar Package*, *B. Battery Package*, *C. Misc. Materials, Labor, Services & Other Adjustments* (codes `IC-PKG-A/B/C`) | Goods, category *Solar System*, ₱1 placeholder price. Consumed by story 064D (order lines), which is still pending. |
| 064I | manual model `x_boq_line` (fields `x_name` = Prod Description, `x_sale_order_id`, `x_sequence`, `x_package`, `x_product`, `x_quantity`, `x_unit`), access rule `x_boq_line_user` (internal users), field `sale.order.x_boq_line_ids`, view *Internal Calculator: sale.order Bill of Quantities page* | A *Bill of Quantities* tab on the quotation with an editable list. |
| 064E | 19 fields `sale.order.x_calc_*` (proposal ref, generated at, financing type, net price, discount, promo, DP % and amount, tenor, rate, monthly amortisation, total due before/after DST, DST, system kWp, panels, battery kWh, inverters, calculator user), view *Internal Calculator: sale.order calculator figures page*, **rewritten code** of server action 1528 behind automation 141 | The automation now takes the tenor from `x_calc_tenor_months` (else the first number in the term name — the old test resolved "36 Months" and "60 Months" to 6, and S00048 shows that bug) and sets the single recurring line's unit price to `x_calc_monthly_amortization`. Previous code is kept in the manifest. |
| 064B | system parameter `internal_calculator.base_url`, server action *Internal Calculator: Generate Proposal* (code, returns `ir.actions.act_url` to `<base_url>/?leadId=<id>`), view *Internal Calculator: crm.lead Generate Proposal button* | Button next to New Quotation on the opportunity, hidden on leads. |
| 064L | view *Internal Calculator: crm.lead hide New Quotation* | Hides the opportunity's New Quotation button for all users. The *New* button on Sales › Quotations is untouched (decide separately). |

### Backend (`InternalCalcBackEnd`)

- `src/odooClient.js` — shared JSON-RPC transport, uid cache, stale-session retry, Odoo date helpers (extracted from the 043D service).
- `src/crmContactService.js` — now uses the shared client; behaviour unchanged.
- `src/odooQuotationService.js` — `POST /api/odoo/quotation`: verifies the Supabase JWT, reads the lead, maps the caller's email to an Odoo user, picks the payment term by tenor and the RTO plan, creates the draft `sale.order` with the `x_calc_*` figures and the BOQ rows, posts a chatter note. Tolerates databases where the custom fields do not exist yet (reports them in `warnings`).
- `server.js` — the route. `README.md` — endpoint and `ODOO_*` variables.
- `scripts/odoo/` — `apply-dinuguan.mjs`, `verify-dinuguan.mjs`, `rollback-dinuguan.mjs`, `rpc.mjs`, `manifests/`.

### Frontend (`InternalCalcFrontEnd`, v3-219)

- `src/lib/deepLink.js` — lifts `?leadId=` off the URL at import time (survives the SSO round-trip), cleans the URL.
- `src/lib/boq.js` — Bill of Quantities rows mirroring the proposal's *System package in detail* page, with quantities.
- `src/lib/odooQuotation.js` — payload builder + `pushProposalToOdoo()`.
- `src/components/OdooSyncBanner.jsx` — result banner.
- `src/components/App.jsx` — the contact record carries `leadId` (set by the Project Number search or the deep link, with an *Unlink* control); the deep link auto-runs the lookup in rep mode; after `doc.save()` the proposal is pushed and the banner shows the quotation number; the header shows *Odoo lead N*.
- `src/lib/pdfGenerator.js` — `generateProposalPdf()` returns `{ quoteRef, fileName }`.

## Environment configuration

| Where | Setting | Staging | Production |
|---|---|---|---|
| Render backend | `ODOO_URL` | `https://solvivaenergy-sh-new-erp-staging-37792153.dev.odoo.com` | `https://solvivaenergy-sh.odoo.com` |
| Render backend | `ODOO_DB` | `solvivaenergy-sh-new-erp-staging-37792153` | `solvivaenergy-solviva-odoo-v18-main-30096417` |
| Render backend | `ODOO_USER` / `ODOO_API_KEY` | admin + a key generated **on the staging build** | already set (043D) |
| Render backend | `ODOO_QUOTATION_ENABLED` | `true` **only after** the `ODOO_*` variables point at the staging build | `true` at step 2 of the production plan |
| Odoo | `internal_calculator.base_url` | `https://staging-internalcalc.solvivaenergy.com` | `https://internalcalc.solvivaenergy.com` (confirm the production hostname) |

The frontend needs no new variables: it reuses `VITE_API_BASE_URL`.

> **Why the opt-in flag exists.** On 2026-09-25 the Render staging service was found to carry the **production** Odoo credential (the read-only lead lookup had been sharing it since 043D). An authenticated staging probe therefore created quotation S00062 in production; it was deleted the same minute. The quotation route now refuses to write unless `ODOO_QUOTATION_ENABLED=true`, so re-pointing `ODOO_*` at staging and enabling the flag are two deliberate steps.

## Staging run-book

1. Generate an API key for `admin@solvivaenergy.com` on the staging build and put it in `.env.staging` (`ODOO_API_KEY=`) and in the Render staging service. **Replace all four `ODOO_*` variables on Render** (they currently point at production), then set `ODOO_QUOTATION_ENABLED=true` there.
2. Dry run, then apply:
   ```powershell
   node scripts/odoo/apply-dinuguan.mjs --env-file .env.staging --calculator-url https://staging-internalcalc.solvivaenergy.com
   node scripts/odoo/apply-dinuguan.mjs --env-file .env.staging --calculator-url https://staging-internalcalc.solvivaenergy.com --yes
   node scripts/odoo/verify-dinuguan.mjs --env-file .env.staging --lead-id 99889
   ```
3. Commit `scripts/odoo/manifests/solvivaenergy-sh-new-erp-staging-37792153.json`.
4. Deploy backend + frontend to staging (push `staging` in both repos; the frontend Action publishes to `staging-internalcalc.solvivaenergy.com`).
5. Browser checks, on a test opportunity (`[test] patricia test`, id 99889):
   - the opportunity form shows **Generate Proposal** and no **New Quotation**;
   - the button opens the staging calculator; after sign-in the customer is filled in and the banner names the lead;
   - Generate PDF downloads the proposal and the banner reports *Quotation S000NN created*;
   - in Odoo the quotation has the customer, dates, salesperson, the *Internal Calculator* tab and the *Bill of Quantities* tab;
   - change the payment term on that quotation in the form: the plan and end date follow the tenor (60 Months → 60, not 6).
6. Try the failure paths: sign out and open the deep link (the lead survives the SSO round-trip); temporarily blank `ODOO_API_KEY` on Render and generate a PDF (PDF still downloads, amber banner).

## Production deployment plan

Order matters: the Odoo records first, then the backend, then the frontend, and 064L last.

1. **Odoo, without 064L** — `node scripts/odoo/apply-dinuguan.mjs --env-file .env --allow-prod --calculator-url https://internalcalc.solvivaenergy.com --skip 064L --yes`, then `verify-dinuguan.mjs --env-file .env --allow-prod --lead-id <a real opportunity>`. Commit the production manifest.
2. **Backend** — merge `staging` → `main`; Render already holds the production `ODOO_*` variables. Add `ODOO_QUOTATION_ENABLED=true` to the production service.
3. **Frontend** — merge `staging` → `main`; production publishes through Cloudflare (not the GitHub Action).
4. **Smoke** — one real opportunity end to end (button → calculator → PDF → quotation).
5. **064L** — once Sales confirms the flow: `apply-dinuguan.mjs --env-file .env --allow-prod --only 064L --yes`.
6. **Announce** to Sales: proposals are now saved as quotations; the New Quotation button is gone; the BOQ and calculator tabs exist on every calculator-made quotation.

## Rollback

- Odoo: `node scripts/odoo/rollback-dinuguan.mjs --env-file <env> [--only 064L,064B,...] --yes`. Views, action and parameter are removed; the automation code is restored; products are archived (add `--delete-products` to unlink). Removing 064E fields / the 064I model **drops their data** — the script prints the affected row counts before `--yes`.
- Backend/frontend: revert the merge commits. The route is inert without `ODOO_*`; the frontend degrades to a warning banner.

## Known limits and follow-ups

- 064D (order lines) is pending: quotations arrive with **no order lines and a ₱0 total** until it ships. The 064E anchoring only takes effect once a recurring line exists.
- Sales › Quotations › *New* still allows manual quotations (064L hides only the opportunity button).
- A lead without a linked contact (0.17% of leads) returns `422 lead_has_no_partner`; the rep is told to link a contact in Odoo.
- The proposal reference (`SV-YYYY-NNNN`) is a hash of name + day-of-year; two proposals for the same customer on the same day share it. The quotation numbers stay distinct.
- Calculator prices are VAT-inclusive; the catalogue's default sales tax is 12% VAT added on top. Story 064D must send VAT-exclusive unit prices or use a price-included tax.
