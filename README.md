# InternalCalcBackEnd

Render-ready backend for the Solviva calculator.

## Endpoints

- `GET /health`
- `POST /api/quote`
- `GET /api/parameters`
- `PUT /api/parameters`
- `GET /api/users` — Super Admin only (Bearer JWT). Lists auth accounts with their resolved role.
- `POST /api/users` — Super Admin only (Bearer JWT). Creates an account: `{ email, role, displayName?, mobile?, password? | ssoOnly: true }`. Writes `app_metadata.role`, `user_metadata` and `public.user_roles` the same way `scripts/set-user-role.mjs` does.
- `PATCH /api/users/:id` — Super Admin only (Bearer JWT). Edits `{ role?, displayName?, mobile? }` (absent = unchanged, `null`/`""` = cleared) in the same three places. Refuses to demote the caller's own role.
- `POST /api/users/:id/archive` / `POST /api/users/:id/restore` — Super Admin only (Bearer JWT). Archive bans the account (`ban_duration` ~100 years, as `scripts/deactivate-user.mjs` does) so it cannot sign in; nothing is deleted and restore lifts the ban. Refuses to archive the caller's own account.
- `GET /api/crm-contact?projectNumber=` — any signed-in user (Bearer JWT). Resolves an Odoo lead id to the customer's name, email and mobile (story 043D).
- `POST /api/odoo/quotation` — any signed-in user (Bearer JWT). Creates a DRAFT quotation on the Odoo opportunity from a generated proposal: `{ leadId, proposal: { quoteRef, generatedAt, validUntil, customer, agent, system, quote, boq[] } }` (sprint Dinuguan, stories 064C/E/J/K). Returns `201 { orderId, orderName, salespersonSource, warnings[] }`; `503 not_configured` when the `ODOO_*` variables are absent; `422 lead_has_no_partner` when the lead has no contact. See `docs/dinuguan-odoo-deployment.md` for the Odoo-side fields it fills.

## Environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PORT` (optional, default `3000`)
- `CORS_ORIGINS` (optional, comma-separated list or `*`)
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
