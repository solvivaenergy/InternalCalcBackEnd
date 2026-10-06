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

Open for review after staging: the **quantity rules** in `InternalCalcFrontEnd/src/lib/boq.js` (counts for panels, batteries, racks, inverters, 2F rows and RSD; metres for excess cable; one lot for every bundled line), and the **product type** of the three package products. The apply script creates them as Goods in *Solar System* to match the existing "Solar PV System NkWp" products, so a confirmed order raises a delivery. On the staging build, *A. Solar Package* (id 412) and *B. Battery Package* (id 413) already existed as **Services** in category *All* when the script ran on 2026-09-25, so the script reused them and created only *C* as Goods. **Decision 2026-10-06:** production copies the staging set — *A* and *B* services in the default category (as AJ made them), *C* Goods in *Solar System*, *D* a service in *Solar System*; `PACKAGE_PRODUCTS` in the apply script now says so (the script still never changes an existing product, so re-running it on staging is a no-op).

**Production differs from the staging build in three places the integration relies on (read-only probe, 2026-10-06).** None of them came from a sprint story; all three are Odoo-team configuration made on the staging build only:

1. **Tax "12%" (id 3)** — on staging AJ set *Included in Price = Tax Included* and *Affect Base of Subsequent Taxes* on 2026-09-18 (two minutes after creating products A/B); on production it is still tax-excluded (unchanged since 2025-03-17). 064D sends VAT-inclusive subtotals with the product's taxes, so on production as-is every quotation total comes out 12% above the proposal. Either Finance applies the same change on production (it affects **every** product and line that carries "12%", not only quotations) or a dedicated price-included 12% tax goes on the four `IC-PKG-*` products (quotation-only effect).
2. **Seven Studio fields on `sale.order`** exist only on staging: `x_studio_payment_scheme` (direct / rto), `x_studio_mode` (downpayment / nodown / straight), `x_studio_percentage`, `x_studio_down_amount`, `x_studio_tenor` (all five by AJ, 2026-09-11, in the Studio view *Odoo Studio: sale.order.form customization*) and `x_studio_create_mode` (manual / automatic), `x_studio_financed_amount` (2026-09-30 by the admin account, for SOLSB-23 / SOLSB-26 — Odoo board SOL-645). The backend only warns when they are absent, so a quotation is still created, but Create Mode stays Manual and the Payment Scheme / Downpayment / Financed Amount boxes stay empty until the Odoo team recreates them on production with the same technical names and selection keys.
3. **Company discount product** — the *Discount on lines* setting is on for every internal user on both builds, but the product Odoo creates on the Discount wizard's first use exists only on staging (Karsten De Chavez, 2026-09-18, id 411); on production `res.company.sale_discount_product_id` is empty, so promo *Discount* lines would be skipped with a warning.

**Resolution (user decisions 2026-10-06):** all three are steps of the apply script now — **064D** flips the tax exactly as on staging and creates the discount product; **064C** creates the seven fields, their defaults and a form group (AJ had checked the fields on staging). Finance accepted that the tax change applies to every line that carries "12%", not only to quotations.

## What changed

### Odoo (applied by `scripts/odoo/apply-dinuguan.mjs`, recorded in `scripts/odoo/manifests/<database>.json`)

| Story | Records | Notes |
|---|---|---|
| 064G | `product.template` × 4: *A. Solar Package*, *B. Battery Package*, *C. Misc. Materials, Labor, Services & Other Adjustments*, *D. Interest* (codes `IC-PKG-A/B/C/D`); manual model `x_sales_package` (fields `x_name`, `x_code`, `x_sequence`, `x_product_id` → product.product), access rules (internal users read, sales managers write), window action + menu *Sales › Configuration › Sales Packages*, one record per package | Goods (D is a service), category *Solar System*, ₱1 placeholder price. The products are what the 064D / 064S order lines land on; the Sales Package model (criterion 2, added 2026-10-02) is the business-facing register of that mapping — the backend resolves products by name, not through it. |
| 064D | `account.tax` "12%": *Included in Price* + *Affect Base of Subsequent Taxes* (previous values kept in the manifest); `product.template` *Discount* (₱0 service, no tax) set as `res.company.sale_discount_product_id` | What the order lines need (step added 2026-10-06, see the production differences above). On staging both already existed (AJ / Karsten, 2026-09-18), so the step is a no-op there. The tax change applies to **every** product and line that carries "12%", accepted by the user on 2026-10-06. |
| 064C | 7 manual fields `sale.order.x_studio_*` (payment_scheme, mode, create_mode, percentage, down_amount, tenor, financed_amount) with the staging labels, selection keys and tracking; 4 `ir.default` rows (manual / direct / straight / 0); view *Internal Calculator: sale.order payment scheme fields* | The header fields the push fills (step added 2026-10-06). The view is created only when no other view already places `x_studio_payment_scheme`, so on staging AJ's Studio layout stays and nothing is duplicated. |
| 064I | manual model `x_boq_line` (fields `x_name` = Prod Description, `x_sale_order_id`, `x_sequence`, `x_package`, `x_product`, `x_quantity`, `x_unit`), access rule `x_boq_line_user` (internal users), field `sale.order.x_boq_line_ids`, view *Internal Calculator: sale.order Bill of Quantities page* | A *Bill of Quantities* tab on the quotation with an editable list. |
| 064E | 19 fields `sale.order.x_calc_*` (proposal ref, generated at, financing type, net price, discount, promo, DP % and amount, tenor, rate, monthly amortisation, total due before/after DST, DST, system kWp, panels, battery kWh, inverters, calculator user), view *Internal Calculator: sale.order calculator figures page*, **rewritten code** of server action 1528 behind automation 141 | The automation now takes the tenor from `x_calc_tenor_months` (else the first number in the term name — the old test resolved "36 Months" and "60 Months" to 6, and S00048 shows that bug) and sets the single recurring line's unit price to `x_calc_monthly_amortization`. Previous code is kept in the manifest. |
| 064B | system parameter `internal_calculator.base_url`, server action *Internal Calculator: Generate Proposal* (code, returns `ir.actions.act_url` to `<base_url>/?leadId=<id>`), view *Internal Calculator: crm.lead Generate Proposal button* | Button next to New Quotation on the opportunity, hidden on leads. |
| 064L | view *Internal Calculator: crm.lead hide New Quotation* | Hides the opportunity's New Quotation button for all users. The *New* button on Sales › Quotations is untouched (decide separately). |

### Backend (`InternalCalcBackEnd`)

- `src/odooClient.js` — shared JSON-RPC transport, uid cache, stale-session retry, Odoo date helpers (extracted from the 043D service).
- `src/crmContactService.js` — now uses the shared client. Since 2026-10-05 the response also carries `salesperson` (below).
- **Assigned salesperson (2026-10-05)** — `src/odooSalespersonService.js` holds the one rule both routes use: the lead's assigned salesperson (`crm.lead.user_id`), else the caller matched to `res.users` by login/email, else nobody. The lead lookup returns that person's name, email and PH mobile (first of partner `mobile`, HR `mobile_phone`, partner `phone`, HR `work_phone` that normalises to 09…; on this instance the number is nearly always in partner `phone`), and the calculator fills the Solviva Agent details from it, so the proposal's "Presented by" and the quotation's salesperson are the same person. Until then the push preferred the signed-in user and fell back to the lead.
- `src/odooQuotationService.js` — `POST /api/odoo/quotation`: verifies the Supabase JWT, reads the lead, resolves the salesperson as above, picks the payment term by tenor, creates the draft `sale.order` with the `x_calc_*` figures and the BOQ rows, posts a chatter note. Tolerates databases where the custom fields do not exist yet (reports them in `warnings`).
- **Recurring Plan is not set (2026-10-01)** — until then an RTO proposal also got `plan_id` (Monthly Rent-to-Own) and `end_date`; user decision: leave the Recurring Plan to Finance in Odoo. The 064E automation still fills it when the payment term is changed on the form. Instead the Studio **Payment Scheme** section is filled: `x_studio_payment_scheme` = direct / rto from the tenor, `x_studio_mode` = straight (Direct Purchase), downpayment or nodown (RTO, by the down-payment %). Each key is checked against the field's selection first; a missing option is a warning, not a failed create. Payment Mode, First Due Date and Last Due Date are left alone (the calculator does not know them).
- **Downpayment group, Tenor, percent figures (2026-10-02)** — the Studio *Downpayment* group (`x_studio_percentage` as a percent, e.g. 30; `x_studio_down_amount` in pesos) and `x_studio_tenor` (RTO) are filled from the calculator alongside `x_studio_financed_amount`. The calculator tab's `x_calc_downpayment_pct` and `x_calc_interest_rate_pa` are now stored as **percent** (30, 23.00), not fractions (0.30, 0.23); quotations created before this carry fractions. The other Studio down-payment fields outside that group (`x_studio_downpayment_` selection, `x_studio_downpayment` monetary, under the schedule) are not written.
- **SOLSB-23 (2026-10-01)** — the create call sets the Studio field `x_studio_create_mode = automatic` (the form's *Create Mode* radio, which defaults to Manual) when the field exists on the database; otherwise a warning says the quotation was left as Manual. The field was Studio-made on the staging build (2026-09-30) and was absent on production as of 2026-10-06; step 064C of the apply script now creates it there (default Manual).
- **064D (2026-10-01)** — the same create call now carries `order_line`: one line per non-empty Summary group on the 064G package product (`product.product` looked up by name, cached), `name` = product name + the inclusion rows, quantity 1, `price_unit` = the group's VAT-inclusive subtotal. The package products carry the price-included "12%" tax (account.tax 3), so Odoo's total equals the calculator's Total Package Price. A promo discount (`quote.discountAmount`) is split across the packages in proportion to their gross amounts (centavo-exact, residual on the largest package — criterion 4 of the tracker) and each share becomes a negative "Discount" line right under its package on `res.company.sale_discount_product_id` ("Discount", id 407 on staging) with that package line's taxes, so every package shows Gross, Discount and Net and the order total equals the calculator's net price. A missing product skips its line and is named in `warnings`.
- **064S (2026-10-02)** — on an RTO quotation a last line **"D. Interest"** (product `IC-PKG-D`, created by the apply script; a service with the company's default tax, which Finance may change on the product) carries `quote.interestAmount` = Total Amount Due − net price (the engine's AH19), named "Interest on ₱<financed> financed over N months at R% p.a.". The tracker phrases the amount as Total Amount Due − Total Package Price; the two agree unless a promo discount applies, and the engine's figure is the one that keeps the order total equal to the calculator's Total Amount Due. The Studio **Financed Amount** (`x_studio_financed_amount`) is set to `quote.amountFinanced` (net price − down payment) on RTO quotations. A missing product or field is a warning.
- **064F (2026-10-02)** — `POST /api/odoo/quotation/:id/pdf` takes the proposal PDF as a raw `application/pdf` body (≤ 25 MB; the 1 MB JSON limit does not apply) with `?quoteRef=` and `?fileName=`. It refuses unless the quotation's `client_order_ref` equals that reference (409 `ref_mismatch`), then creates the `ir.attachment` on the `sale.order` and posts a chatter note carrying it, so the PDF shows in the Logs column and under the paperclip. The frontend calls it right after the quotation is created with the exact bytes `doc.save()` wrote (`pdfBlob`); a failure is a warning on the same banner.
- `server.js` — the route. `README.md` — endpoint and `ODOO_*` variables.
- `scripts/odoo/` — `apply-dinuguan.mjs`, `verify-dinuguan.mjs`, `rollback-dinuguan.mjs`, `rpc.mjs`, `manifests/`.

### Frontend (`InternalCalcFrontEnd`, v3-219)

- `src/lib/deepLink.js` — lifts `?leadId=` off the URL at import time (survives the SSO round-trip), cleans the URL.
- `src/lib/boq.js` — Bill of Quantities rows mirroring the proposal's *System package in detail* page, with quantities.
- `src/lib/odooQuotation.js` — payload builder + `pushProposalToOdoo()`.
- `src/lib/odooOrderLines.js` (v3-222, 064D) — `orderLines[]` for the payload: the Summary tab's package groups (same rows, same A→B→C order, empty groups omitted) with their VAT-inclusive subtotals.
- `src/lib/pdfGenerator.js` (v3-222, 064F) — `generateProposalPdf()` also returns `pdfBlob`, the bytes `doc.save()` wrote; `src/lib/odooQuotation.js` `attachProposalPdf()` posts them to the quotation; `App.jsx` calls it after a successful push and folds the result into the banner.
- `src/components/Step2Packages.jsx` (v3-222, story 072) — when the Product-set minimum system size (Quote Limits → *Minimum system size*) floors the recommendation, a warning callout under 2A says what the inputs asked for and what the proposal defaults to. The engine's floor itself is unchanged (v3-68: `ceil(minSystemKwp × 1000 / panelWatts)` panels, so 5 kWp on 630 W panels is 8 panels = 5.04 kWp). **The limit is data, not code: set it to 5 on staging and production in the Product tab when deploying** (staging held 2.5 on 2026-10-02).
- `src/lib/boq.js` `odooProdDescription()` (v3-222) — the BOQ *Prod Description* sent to Odoo drops the leading count the proposal prints ("8 units 630W Solar Panels" → "630W Solar Panels"; "15m of Add'l. DC Cable" → "Add'l. DC Cable"), since the table has Quantity and Unit columns (user decision 2026-10-01). Mid-sentence counts such as the RSD line's "for 8 Solar Panels" stay. The proposal, the Summary and the 064D order-line text are unchanged.
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
   - the *Order Lines* tab lists A / B / C (each with its inclusions beneath the product), a *Discount* line when a promo code was applied, and the order total equals the calculator's net price (064D; S00078 and S00079 on staging are the reference quotations);
   - change the payment term on that quotation in the form: the plan and end date follow the tenor (60 Months → 60, not 6).
6. Try the failure paths: sign out and open the deep link (the lead survives the SSO round-trip); temporarily blank `ODOO_API_KEY` on Render and generate a PDF (PDF still downloads, amber banner).

## Production deployment plan

Order matters: Odoo records and configuration first, then the backend, then the frontend, then the opportunity button together with 064L (user decision 2026-10-06: the New Quotation button is hidden on production in the same release). Backend before frontend because v3-224 posts to a route the old backend does not have.

0. **Pre-flight** — on staging, one quotation from lead 99889 to confirm the v3-224 salesperson rule (`salespersonSource` = `lead`); the 2026-10-06 script/doc changes committed to `staging`; optionally give Patrick Avedillo's production Odoo contact his mobile (0917 148 6078) so the smoke test fills the agent phone (his contact holds only "+63" today).
1. **Odoo, everything except the button and 064L** — dry run, read it, apply, verify:
   ```powershell
   node scripts/odoo/apply-dinuguan.mjs --env-file .env --allow-prod --calculator-url https://internalcalc.solvivaenergy.com --skip 064B,064L
   node scripts/odoo/apply-dinuguan.mjs --env-file .env --allow-prod --calculator-url https://internalcalc.solvivaenergy.com --skip 064B,064L --yes
   node scripts/odoo/verify-dinuguan.mjs --env-file .env --allow-prod
   ```
   Creates the four package products and *Discount*, flips the "12%" tax, creates the seven header fields with their defaults and form group, the Sales Package and BOQ models, the 19 calculator fields and their pages, and rewrites server action 1528 (previous code in the manifest). Commit `scripts/odoo/manifests/solvivaenergy-solviva-odoo-v18-main-30096417.json` to `staging` before cutting the release branch so `main` carries it.
2. **Backend** — add `ODOO_QUOTATION_ENABLED=true` to the Render production service first (old code ignores it), then `release/staging-to-main-<date>` from `staging` → PR → `main`; Render auto-deploys `main`. Checks: `/health` ok; `GET /api/parameters` → 401 without a JWT; `POST /api/public/estimate` → 503; a foreign `Origin` gets no `access-control-allow-origin`.
3. **Frontend** — same release branch → PR → `main`; Cloudflare Pages builds it (the "Cloudflare Pages" check run on the merge commit). `curl -s https://internalcalc.solvivaenergy.com/ | grep -o 'x-solviva-build[^>]*'` must read v3-224. The merge also removes the vestigial GitHub Pages workflow.
4. **Data** — Product tab › Quote Limits › *Minimum system size* = 5 on production (it holds 2.5).
5. **Odoo, button + hide New Quotation** — `apply-dinuguan.mjs --env-file .env --allow-prod --calculator-url https://internalcalc.solvivaenergy.com --only 064B,064L --yes`, then `verify-dinuguan.mjs --env-file .env --allow-prod --lead-id 52210`. Commit the manifest again.
6. **Smoke** on opportunity 52210 *Testing for Odoo Proposal* (team Sales, salesperson Patrick Avedillo; keep its quotations): Direct Purchase, RTO, and a promo code — lines A / B / C (+ *D. Interest* on RTO), order total = the calculator's figure, *Internal Calculator* and *Bill of Quantities* tabs, Create Mode Automatic (debug mode), Payment Scheme / Mode / Tenor / Downpayment / Financed Amount filled, PDF in the chatter, agent details = the assigned rep.
7. **Announce** to Sales: proposals are now saved as quotations; the New Quotation button is gone; the BOQ and calculator tabs exist on every calculator-made quotation.

## Rollback

- Odoo: `node scripts/odoo/rollback-dinuguan.mjs --env-file <env> [--only 064L,064B,...] --yes`. Views, action and parameter are removed; the automation code is restored; products are archived (add `--delete-products` to unlink). Removing 064E fields / the 064I model / the 064C fields **drops their data** — the script prints the affected row counts before `--yes`. Rolling back 064D restores the tax's previous values (which re-totals every open quotation and unposted invoice carrying "12%") and the company's discount field; for a code-only rollback leave 064D and 064C in place.
- Backend/frontend: revert the merge commits. The route is inert without `ODOO_*`; the frontend degrades to a warning banner.

## Known limits and follow-ups

- 064D shipped on 2026-10-01 (backend + frontend v3-222): quotations now carry the package lines and the discount line, and the order total equals the calculator's net price. The package lines are not recurring and the calculator no longer sets a Recurring Plan, so the 064E anchoring only takes effect once Finance sets the plan and a recurring line exists on an RTO quotation.
- The staging build also has a hand-made **"C. Misc Expenses"** service product (id 414) next to the scripted *C. Misc. Materials, Labor, Services & Other Adjustments* (id 416). The backend uses the scripted name; archive or rename 414 so reps cannot pick the wrong one. Same decision as the product-type question above: align all three before production.
- Sales › Quotations › *New* still allows manual quotations (064L hides only the opportunity button).
- A lead without a linked contact (0.17% of leads) returns `422 lead_has_no_partner`; the rep is told to link a contact in Odoo.
- The proposal reference (`SV-YYYY-NNNN`) is a hash of name + day-of-year; two proposals for the same customer on the same day share it. The quotation numbers stay distinct.
- Calculator prices are VAT-inclusive. The company default (`account_price_include`) is tax-excluded, but the "12%" sale tax itself is `price_include_override = tax_included` (AJ on staging, 2026-09-18; step 064D on production) and it is the tax on all four package products, so 064D sends the VAT-inclusive subtotals unchanged. If that tax is ever switched to excluded, the order totals will come out 12% high.
