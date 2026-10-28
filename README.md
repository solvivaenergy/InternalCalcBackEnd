# InternalCalcBackEnd

Render-ready backend for the Solviva calculator.

## Endpoints

Every `/api/*` route needs a signed-in Supabase user (Bearer JWT) and is rate
limited per client address (see `RATE_LIMIT_*` below). Only `GET /health` is
open.

- `GET /health`
- `POST /api/public/estimate` — the website calculator's numbers, from the same `@solviva/calc-engine` and the same `app_parameters` row the Internal Calculator uses. Not a user route: it needs the shared header `x-estimate-key: $PUBLIC_ESTIMATE_KEY` (the External Calculator's Cloudflare Worker holds it) and answers `503 not_configured` when the variable is unset. Body: `{ monthlyBill, appliances?: [{ name, count, onHour, offHour, daysPerWeek }] (≤7, names from the device library), utilityRate?, phase?: "single"|"three", desiredSavingsPct?, roofMaterial?, location?, locationKm?, tenor?, downPaymentPct? }`; everything else stays at the calculator's defaults. Returns `{ engineVersion, generatedAt, inputs, consumption, system, pricing, savings }` — an allowlisted projection with no COGS or margins (`src/estimateService.js`). Rate limited per visitor (`x-estimate-client-ip`, forwarded by the Worker) after the key check.
- `GET /api/parameters?region=luzon|cebu` — any signed-in user, for a region on their account (`403 region_forbidden` otherwise; `region` absent = `luzon`). Returns that region's parameter payload (COGS, margins, promo codes included — the calculator derives selling prices from them) plus a top-level `region` echo. Public until 2026-09-27; one payload per region since 2026-10-28 (see *Regions*).
- `PUT /api/parameters?region=luzon|cebu` — role-gated per section, confined to the caller's regions. A change to `adminParams.gateAuthEnabled` (maintenance mode, global by product decision) is copied into every other region's row; the response lists them as `mirroredRegions`.
- `GET /api/parameter-audit?region=luzon|cebu|all&limit=` — Super Admin only. `all` = every region the caller holds, each row carrying its `region`.
- `GET /api/users` — Super Admin only (Bearer JWT). Lists auth accounts with their resolved role and `regions` (`regionsExplicit: false` = the account predates regions and gets Manila by default).
- `POST /api/users` — Super Admin only (Bearer JWT). Creates an account: `{ email, role, regions?: ["luzon"|"cebu", …], displayName?, mobile?, password? | ssoOnly: true }`. Writes `app_metadata.role` (+ `app_metadata.regions`, default `["luzon"]`), `user_metadata` and `public.user_roles` the same way `scripts/set-user-role.mjs` does.
- `PATCH /api/users/:id` — Super Admin only (Bearer JWT). Edits `{ role?, regions?, displayName?, mobile? }` (absent = unchanged, `null`/`""` = cleared; `regions` replaces the list whole and may not be empty) in the same three places. Refuses to demote the caller's own role; the caller MAY edit their own regions.
- `POST /api/users/:id/archive` / `POST /api/users/:id/restore` — Super Admin only (Bearer JWT). Archive bans the account (`ban_duration` ~100 years, as `scripts/deactivate-user.mjs` does) so it cannot sign in; nothing is deleted and restore lifts the ban. Refuses to archive the caller's own account.
- `GET /api/crm-contact?projectNumber=&region=` — any signed-in user (Bearer JWT). Resolves an Odoo lead id to the customer's name, email and mobile (story 043D). `warnings[]` gains `lead_region_mismatch` when the lead's address (province, else an unambiguous city) belongs to the other region, or `lead_region_unknown` when the lead has no address; once a region's `adminParams.odooCompanyId` is set the check compares the lead's company instead (`lead_company_mismatch`). Also returns `salesperson` — the lead's assigned salesperson's name, email and PH mobile from their `res.users` record (else the caller's own Odoo user; `source: lead | calculator-user | none`, `warnings[]`), which the calculator puts in the Solviva Agent details (2026-10-05); `null` when that part of the lookup failed (`salesperson_unavailable` in `warnings`).
- `POST /api/odoo/quotation` — any signed-in user (Bearer JWT). Creates a DRAFT quotation on the Odoo opportunity from a generated proposal: `{ leadId, region?, proposal: { quoteRef, generatedAt, validUntil, customer, agent, system, quote, orderLines[], boq[] } }` (sprint Dinuguan, stories 064C/D/E/J/K; `region` = the parameters that priced it, default `luzon`, named in the chatter note). `orderLines[]` is `{ package: "A"|"B"|"C", inclusions: string[], amount }` per non-empty Summary group; each becomes an order line on the matching package product at the VAT-inclusive amount (the products carry the price-included 12% tax), and a non-zero `quote.discountAmount` adds a negative "Discount" line on the company's discount product. The quotation is tagged *Create Mode: Automatic* (`x_studio_create_mode`, SOLSB-23) and its Studio *Payment Scheme* / *Mode* radios follow the financing (direct + straight, or rto + downpayment / nodown); the Recurring Plan is never set from here. The promo discount is split per package (one negative "Discount" line under each package line), and an RTO quotation also gets a "D. Interest" line (`quote.interestAmount`) and the Studio *Financed Amount* (`quote.amountFinanced`) — story 064S. The quotation's salesperson is the lead's assigned salesperson, else the caller matched to an Odoo user by email (`salespersonSource: lead | calculator-user | none`; until 2026-10-05 the order was the reverse). Returns `201 { orderId, orderName, region, salespersonSource, warnings[], warningCodes[] }` (`warningCodes` carries the lead↔region codes listed under `/api/crm-contact`; the quotation is created regardless); `503 not_configured` when the `ODOO_*` variables are absent; `422 lead_has_no_partner` when the lead has no contact. See `docs/dinuguan-odoo-deployment.md` for the Odoo-side fields it fills.
- `POST /api/odoo/quotation/:id/pdf?quoteRef=&fileName=` — any signed-in user (Bearer JWT). Body is the proposal PDF itself (`Content-Type: application/pdf`, ≤ 25 MB). Attaches it to that quotation (`ir.attachment` + a chatter note carrying it) when the quotation's proposal reference equals `quoteRef`; otherwise `409 ref_mismatch`. `400` for a body that is not a PDF, `413` above 25 MB, same `503` codes as the create call (story 064F).

## Regions (2026-10-28)

One calculator serves more than one office, and each office — **Manila**
(region id `luzon`, the original) and **Cebu** (`cebu`) — has its OWN complete
parameter payload: margins, COGS, inventory, logistics, FinCo settings, all of
it. The allowlist is `src/regions.js`.

- Storage: `public.region_parameters` (one row per region, migration
  `supabase/migrations/20261028_region_parameters.sql`, which also seeds both
  rows from the live `app_parameters` row — Cebu with its own label, no
  delivery hub, and the Visayan utility named as the inflation source). The
  legacy one-row `app_parameters` stays and every Luzon save is mirrored into
  it, because the frontend's direct-read fallback, the `mcp/` connector and
  the parity harness still read it; once those read `region_parameters` the
  mirror goes (`writeRegionPayload` in `src/parametersService.js`). While the
  new table does not exist yet (backend deployed before the migration) Luzon
  is served from `app_parameters` and Cebu answers `503 region_not_provisioned`.
- Access: `auth.users.app_metadata.regions` (array), set through `/api/users`.
  An account without the key is a Manila account — the backend, the RLS policy
  on `region_parameters` and the frontend all apply that same default, so the
  accounts that predate regions need no backfill.
- `parameter_audit_events.region` records which region an edit was made in.
- Engine 1.3.0 parameters that make a payload region-aware:
  `deliveryRegionLabel`, `deliveryHubLabel`, `deliveryHubEnabled` (false = no
  dispatch hub yet ⇒ every delivery prices ₱0 at any distance and the
  Logistics T&C clause is dropped) and `odooCompanyId` (the Odoo
  company/branch the region's leads live in; null until it exists).
- `scripts/seed-region-parameters.mjs` re-seeds or inspects the rows (dry run
  by default; `--region cebu --apply`, `--force` to overwrite, `--from luzon`
  to re-base).
- Not region-aware yet: `POST /api/public/estimate` (the website is
  Luzon-only) and the `mcp/` connector (reads the Luzon row).

## MCP server (`mcp/`)

A separate, read-only process for Claude Teams: it runs `@solviva/calc-engine`
on the live `app_parameters` row (production, staging or testing, as the
SELECT-only role `db_mcp_ro`) and offers eight `calc_*` tools — a quote with
every line's COGS and margin, the parameters by section, margin curves, the
RTO rate grid, parameter change history, scenario comparison, and a complete
proposal package. `npm run mcp` (stdio, Claude Code) or `npm run mcp:http`
(the claude.ai connector, behind `CALC_MCP_SERVICE_TOKEN` and the Anthropic IP
allowlist). It needs only the three `DB_MCP_CALC*_URL` strings, never the
service-role key. See `mcp/README.md` for the tools, environment and the
Render / connector setup.

## Environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PORT` (optional, default `3000`)
- `CORS_ORIGINS` (optional) — comma-separated list of browser origins allowed to call the API. Unset means the built-in list in `server.js`: the production and staging calculators plus the Vite dev server (`localhost:5173`). Setting it replaces that list; `*` allows all and is what `npm run dev` uses. The active list is logged at boot. Before 2026-09-27 unset meant `*`.
- `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` (optional, default `120` per `60`s per client address; `/api/*` answers `429` with `Retry-After` beyond that)
- `PUBLIC_ESTIMATE_KEY` — shared secret for `POST /api/public/estimate`; the same value goes into the External Calculator Worker's secrets. Unset = the route answers `503 not_configured`. Generate with `openssl rand -hex 32`.
- `ESTIMATE_RATE_LIMIT_PER_VISITOR` (optional, default `30` per minute per forwarded visitor address) / `ESTIMATE_RATE_LIMIT_PER_ADDRESS` (optional, default `600` per minute per calling address, applied before the key check)
- `PARAMETERS_STORAGE` (optional; set to `local-json` only for local development)
- `VITE_SUPERADMIN_PASSWORD`
- `VITE_ENGINEERING_PASSWORD`
- `VITE_PRODUCT_PASSWORD`
- `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_API_KEY` — the Odoo JSON-RPC credential used by `/api/crm-contact` and `/api/odoo/quotation`. Point staging at the Odoo.sh staging build; its API keys are wiped when the build is neutralised, so generate a key on the staging build itself.
- `ODOO_QUOTATION_ENABLED` — must be exactly `true` for `/api/odoo/quotation` to create quotations; anything else answers `503 push_disabled`. Set it only on a service whose `ODOO_*` credential is confirmed to point at the intended database (the lead lookup is read-only, the quotation push is not).
- `ODOO_TIMEOUT_MS` (optional, default `8000`)

Regions (2026-10-28) add no variables.

Successful parameter saves are recorded in `parameter_audit_events` with the
verified actor, role, region, timestamp, source, complete before/after payloads,
and a field-level `changes` list. Local development writes the same event shape to
`data/parameter-audit.local.jsonl` instead of Supabase; that file is ignored by
Git because it may contain local user activity.

## Local run

```bash
npm install
npm start
```

For local development without connecting parameter reads or writes to Supabase,
run the frontend's `npm run dev` command. It starts this backend through the
`dev` script with the required development-only variables automatically.

To start the backend by itself, use:

```powershell
npm run dev
```

The backend then reads and writes `data/parameters.local.json` (Luzon) and
`data/parameters.cebu.local.json` (Cebu; `?region=cebu`). The files start as an
empty object and are intentionally tracked, so parameter changes appear in Git
as ordinary JSON changes that can be reviewed and committed. This mode is
blocked unless `NODE_ENV=development`; staging and production continue using
Supabase.
