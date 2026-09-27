# InternalCalcBackEnd — Handoff

## 2026-09-27 — `POST /api/public/estimate`: the website's numbers from the shared engine

### Scope

- New route + `src/estimateService.js`. Runs `@solviva/calc-engine`
  `computeProposal()` on the live `app_parameters` row (30 s cache) with the
  website's inputs over the calculator's defaults (`defaultState`, added to
  the engine in 1.1.0 — no computation changed, parity 47/47), and answers
  an allowlisted, customer-facing projection: `consumption`, `system`,
  `pricing` (net, direct purchase, rent-to-own, the tenor table, line items
  with prices), `savings`. No COGS, no margins — a final scan refuses any body
  that mentions either.
- Access: shared header `x-estimate-key` = `PUBLIC_ESTIMATE_KEY` (constant-
  time compare); unset key → `503 not_configured`. Limits: 600/min per
  calling address before the key check, 30/min per visitor
  (`x-estimate-client-ip`, read only after the key check) after it. The route
  is registered before the global `/api` limiter so the Worker's single
  address is not the whole website's bucket. `rateLimit()` gained a `key`
  option; `parametersService` gained `readParametersPayload()`.

### Contract changes

- New route only. Request/response documented in README.

### Validation

- Scripted run against staging (server spawned with the staging creds):
  503 without the env var; 401 without/with a wrong key; 400s for a bad
  bill, an unknown appliance (error lists the valid names), 8 appliances;
  200 for a real request with no `cogs`/`margin` in the body; the numbers
  (panels, battery kWh, net price, RTO monthly, DP total, monthly savings)
  equal a direct `computeProposal()` on the same inputs; 4th request from
  one visitor in a minute → 429 while another visitor still gets 200; a
  forwarded address without a valid key is ignored (401).

### Deployment notes

- Set `PUBLIC_ESTIMATE_KEY` on the Render service(s) that should serve the
  website (staging first), and the same value in the External Calculator
  Worker's secrets when it is wired up. Until then the route answers 503.
- Engine 1.1.0: after merge, `git tag calc-engine-v1.1.0` + push the tag.
  The frontend may stay on 1.0.0 (identical math); bump at the next release.

## 2026-09-27 — `packages/calc-engine`: the calculator's engine lives here now

### Scope

- New workspace package `packages/calc-engine` (`@solviva/calc-engine`
  1.0.0): the Internal Calculator's sizing/pricing engine, copied from
  `InternalCalcFrontEnd/src/engine` at its commit `3324a7e` (where it had just
  been lifted out of `src/lib` + `src/data` with a byte-identical parity
  check). Pure ESM, no browser/Vite/network imports; runs in Node.
- The backend imports it as a workspace (`workspaces` in the root
  `package.json`; `npm install`/`npm ci` create the `node_modules/@solviva/
  calc-engine` link). The frontend will depend on the tarball attached to
  GitHub Release `calc-engine-v1.0.0` (new workflow `calc-engine-release.yml`,
  triggered by pushing a `calc-engine-v*` tag).
- `POST /api/quote` and `src/quoteService.js` REMOVED. It was a hand-ported,
  partial copy of the engine that nothing called and that had drifted (last
  touched 2026-08-17; the frontend engine had 12 commits since).
- `packages/calc-engine/parity/` — the harness: `capture.mjs <engine-dir>
  <params.json>` + `compare.mjs`. Package vs the frontend's v3-220 engine on
  the staging row: identical.

### Files touched

- `packages/calc-engine/**` (new), `package.json` (workspaces),
  `package-lock.json`, `server.js` (route + import removed),
  `src/quoteService.js` (deleted), `.github/workflows/calc-engine-release.yml`
  (new), `.gitignore`, `README.md`.

### Contract changes

- `POST /api/quote` → 404. No caller existed.

### Data changes

- None.

### Validation

- `npm install` at root links the workspace; `node --input-type=module -e
  'import { computeProposal } from "@solviva/calc-engine"'` resolves.
- Parity: `parity/capture.mjs packages/calc-engine <staging payload>` vs the
  frontend's `src/engine` at v3-220 → 47/47 identical.
- `node --check server.js`.

### Deployment notes

- Staging builds with `npm ci`: the committed lockfile carries the workspace
  link. No env change.
- After merge, tag the commit `calc-engine-v1.0.0` and push the tag; the
  workflow attaches the tarball the frontend's `package.json` points at.

## 2026-09-27 — Lock down the API ahead of a public calculator endpoint

### Scope

- `GET /api/parameters` now requires a signed-in Supabase user (any role).
  It returned the whole row — COGS, margin curves, promo codes — to anyone.
  Same rule as the frontend's PostgREST fallback read (20260922 migration).
- `POST /api/quote` now requires a signed-in user. Unused by the frontend and
  behind the browser engine, but it was public and read the parameters row
  through the service-role key per call.
- CORS: `CORS_ORIGINS` unset now means the calculator's own origins
  (prod, staging, `localhost:5173`) instead of `*`. Both Render services
  were running on the `*` default, so this deploys with no env change and
  no disruption. Setting the variable replaces the built-in list. `npm run
  dev` defaults to `*` because Vite and the backend are different local
  origins.
- Rate limit on `/api/*`: 120 requests / 60 s per client address (in-memory,
  `src/rateLimit.js`), `429` + `Retry-After` beyond that. `trust proxy` set
  so `req.ip` is the caller behind Render.
- 500 responses on `/api/quote`, `GET|PUT /api/parameters` and
  `/api/parameter-audit` no longer echo `error.message` (Supabase faults name
  tables and queries); logged server-side instead, as the newer routes do.

### Files touched

- `server.js`, `src/parametersService.js` (`getParameters(accessToken)` →
  `{ status, payload }`), `src/rateLimit.js` (new), `dev-server.js`,
  `README.md`.
- Frontend: `src/lib/paramsService.js` — `loadFromBackend()` sends
  `Authorization: Bearer <session JWT>`.

### Contract changes

- `GET /api/parameters` and `POST /api/quote`: `401` without a valid JWT.
  The frontend already only loads parameters after sign-in; a frontend
  built before this change gets `401` from the backend and falls through to
  its Supabase direct read, so parameters still load — deploy the frontend
  change alongside anyway so the backend path is the one that serves.
- Any `/api/*` route: `429` when a client exceeds the cap.

### Data changes

- None.

### Validation

- `node --check` on every touched file.
- Scripted run against the staging project (throwaway user, deleted after):
  `401` without / with a bogus token, `200` with a real JWT and the payload
  carries `adminParams`; `POST /api/quote` `401`; foreign `Origin` gets no
  `Access-Control-Allow-Origin`, the listed one is echoed; `429` after the
  cap with `Retry-After`.

### Deployment notes

- No env change required. Optional: `CORS_ORIGINS` (replaces the built-in
  list), `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS`.
- Deploy the frontend change with it (a frontend built before this change
  still loads parameters via its Supabase fallback, but through the slower
  path).
- Post-deploy: `curl -i -H "Origin: https://example.com" <backend>/health`
  must show no `access-control-allow-origin`; `curl -i <backend>/api/parameters`
  must answer `401`.

## 2026-09-07 — Fix phantom derived-price entries in parameter audit history

### Scope

- `PUT /api/parameters` audit diff no longer records derived COGS→price ripples
  (`miscCatalog[x].price`, `deliveryLocations[x].fixedFee/perPanel`,
  `batteryPackages[x].*Price`, inverter `directPrice`, panel `panelDirectPrice`,
  and the 21 derived adminParams scalar prices).
- These fields are recomputed client-side from `*Cogs` inputs + the live
  `grossMarginReference` on every load/save (frontend `deriveDirectPrices`,
  v3-83). When the stored reference margin and a saving client's derivation
  margin disagreed (e.g. an Engineering/Product save after a FinCo margin
  change), the raw deep diff flagged every derived price as "changed" —
  the 20–23-field phantom events seen in staging on Sep 4–5 2026.
- Authored inputs (`*Cogs`, labels, margins, rates, row adds/removes) still
  audit under their own paths; no real change history is lost. A save whose
  only diff was a derived ripple now writes **no** audit event.
- Backward compatible: no schema change; `parameter_audit_events` rows keep
  the same shape. Existing (noisy) rows are untouched.

### Files touched

- `src/parametersService.js` — new `DERIVED_ADMIN_SCALAR_PRICES`,
  `DERIVED_AUDIT_PATH_PATTERNS`, `isDerivedAuditPath()`; `buildChanges()`
  result filtered before the `changes.length > 0` event write.

### Contract changes

- None. Request/response shape unchanged. Frontend needs no update.

### Data changes

- None. No migrations, no RLS changes, no backfill.

### Validation

- `node --check src/parametersService.js` — pass.
- Filter unit-checked against 27 paths: all 10 observed phantom paths
  (miscCatalog/deliveryLocations derived prices etc.) filtered; all 17
  authored-input paths (COGS, labels, margins, row adds, devices, panel
  watts) preserved.
- Verified against live staging `parameter_audit_events`: the Sep 4–5
  multi-area events contained only derived-price replaces + the real edit
  (e.g. `minSystemKwp`, `duRateInflationDefault`); under the new filter
  those events would show 1–4 fields each.

### Deployment notes

- Deploy backend to staging, then production. No env/config changes.
- Optional cleanup: historical phantom-heavy events remain in the table;
  delete or leave per audit-retention preference (no script shipped).
