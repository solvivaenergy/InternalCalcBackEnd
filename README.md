# InternalCalcBackEnd

Render-ready backend for the Solviva calculator.

## Endpoints

Every `/api/*` route needs a signed-in Supabase user (Bearer JWT) and is rate
limited per client address (see `RATE_LIMIT_*` below). Only `GET /health` is
open.

- `GET /health`
- `POST /api/public/estimate` — the website calculator's numbers, from the same `@solviva/calc-engine` and the same `app_parameters` row the Internal Calculator uses. Not a user route: it needs the shared header `x-estimate-key: $PUBLIC_ESTIMATE_KEY` (the External Calculator's Cloudflare Worker holds it) and answers `503 not_configured` when the variable is unset. Body: `{ monthlyBill, appliances?: [{ name, count, onHour, offHour, daysPerWeek }] (≤7, names from the device library), utilityRate?, phase?: "single"|"three", desiredSavingsPct?, roofMaterial?, location?, locationKm?, tenor?, downPaymentPct? }`; everything else stays at the calculator's defaults. Returns `{ engineVersion, generatedAt, inputs, consumption, system, pricing, savings }` — an allowlisted projection with no COGS or margins (`src/estimateService.js`). Rate limited per visitor (`x-estimate-client-ip`, forwarded by the Worker) after the key check.
- `GET /api/parameters` — any signed-in user. Returns the whole `app_parameters` row (COGS, margins, promo codes included — the calculator derives selling prices from them). Public until 2026-09-27.
- `PUT /api/parameters` — role-gated per section.
- `GET /api/users` — Super Admin only (Bearer JWT). Lists auth accounts with their resolved role.
- `POST /api/users` — Super Admin only (Bearer JWT). Creates an account: `{ email, role, displayName?, mobile?, password? | ssoOnly: true }`. Writes `app_metadata.role`, `user_metadata` and `public.user_roles` the same way `scripts/set-user-role.mjs` does.
- `PATCH /api/users/:id` — Super Admin only (Bearer JWT). Edits `{ role?, displayName?, mobile? }` (absent = unchanged, `null`/`""` = cleared) in the same three places. Refuses to demote the caller's own role.
- `POST /api/users/:id/archive` / `POST /api/users/:id/restore` — Super Admin only (Bearer JWT). Archive bans the account (`ban_duration` ~100 years, as `scripts/deactivate-user.mjs` does) so it cannot sign in; nothing is deleted and restore lifts the ban. Refuses to archive the caller's own account.
- `GET /api/crm-contact?projectNumber=` — any signed-in user (Bearer JWT). Resolves an Odoo lead id to the customer's name, email and mobile (story 043D).
- `POST /api/odoo/quotation` — any signed-in user (Bearer JWT). Creates a DRAFT quotation on the Odoo opportunity from a generated proposal: `{ leadId, proposal: { quoteRef, generatedAt, validUntil, customer, agent, system, quote, orderLines[], boq[] } }` (sprint Dinuguan, stories 064C/D/E/J/K). `orderLines[]` is `{ package: "A"|"B"|"C", inclusions: string[], amount }` per non-empty Summary group; each becomes an order line on the matching package product at the VAT-inclusive amount (the products carry the price-included 12% tax), and a non-zero `quote.discountAmount` adds a negative "Discount" line on the company's discount product. The quotation is tagged *Create Mode: Automatic* (`x_studio_create_mode`, SOLSB-23) and its Studio *Payment Scheme* / *Mode* radios follow the financing (direct + straight, or rto + downpayment / nodown); the Recurring Plan is never set from here. The promo discount is split per package (one negative "Discount" line under each package line), and an RTO quotation also gets a "D. Interest" line (`quote.interestAmount`) and the Studio *Financed Amount* (`quote.amountFinanced`) — story 064S. Returns `201 { orderId, orderName, salespersonSource, warnings[] }`; `503 not_configured` when the `ODOO_*` variables are absent; `422 lead_has_no_partner` when the lead has no contact. See `docs/dinuguan-odoo-deployment.md` for the Odoo-side fields it fills.
- `POST /api/odoo/quotation/:id/pdf?quoteRef=&fileName=` — any signed-in user (Bearer JWT). Body is the proposal PDF itself (`Content-Type: application/pdf`, ≤ 25 MB). Attaches it to that quotation (`ir.attachment` + a chatter note carrying it) when the quotation's proposal reference equals `quoteRef`; otherwise `409 ref_mismatch`. `400` for a body that is not a PDF, `413` above 25 MB, same `503` codes as the create call (story 064F).

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

Successful parameter saves are recorded in `parameter_audit_events` with the
verified actor, role, timestamp, source, complete before/after payloads, and a
field-level `changes` list. Local development writes the same event shape to
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

The backend then reads and writes `data/parameters.local.json`. The file starts
as an empty object and is intentionally tracked, so parameter changes appear in
Git as ordinary JSON changes that can be reviewed and committed. This mode is
blocked unless `NODE_ENV=development`; staging and production continue using
Supabase.
