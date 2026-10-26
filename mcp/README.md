# Internal Calculator MCP server

A read-only [MCP](https://modelcontextprotocol.io) server that runs the
calculator's own engine (`@solviva/calc-engine`, the workspace package in
`packages/calc-engine`) on the live admin parameters and offers Claude eight
tools: price a quote and see every line's COGS and margin, read the parameters
behind the prices, see who changed what, compare scenarios, and assemble a
complete proposal from a rep's inputs.

It is the calculator counterpart of the monitoring repo's `db_mcp.py`
("Solviva Databases") and `solviva_mcp.py` ("Solviva Systems"): same shape
(stdio for Claude Code, streamable HTTP for the claude.ai connector), same
gate (shared bearer token + Anthropic IP allowlist), same read-only database
role.

## Tools

| Tool | What it answers |
| --- | --- |
| `calc_environments` | Which databases are reachable (production / staging / testing), engine version, when each environment's parameters were last saved, promo codes, counts |
| `calc_parameters` | The effective configuration by section: `margins`, `interest_rates`, `financing`, `promo_codes`, `panels_inverters`, `battery_packages`, `cabling`, `variable_charges`, `location`, `misc_catalog`, `standalone_fixed_overhead`, `schedule_constants`, `defaults`, `devices`, `content` (T&Cs, warranties, disclaimers), `stored_payload` (the raw saved row), `all` |
| `calc_margin_schedule` | The panels margin curve at a set of kWp points per phase, the battery kWh curve, the per-component margin table resolved for every order shape, the COGS → price formula with a worked example |
| `calc_rate_table` | The RTO rate grid (tenor × down payment), its anchors, the minimum-DP tiers and maximum tenor; with `netPrice`, the monthly payment at each cell |
| `calc_quote` | The INTERNAL view of a quote: consumption, sizing (recommended vs selected), every line with COGS / gross margin ₱ and realised % / MDR allowance / VAT and the margin rule that priced it, package subtotals, promo and net price, direct-purchase and financed terms with the RA 3765 disclosure, the tenor table, savings / payback / IRR / LCOE, coverage, schedule preview, BOQ, Odoo order lines. Optional `include`: `annex`, `cashflows`, `hourly` |
| `calc_compare` | 2–6 labelled scenarios side by side (same inputs as `calc_quote`) |
| `calc_proposal` | Everything the proposal PDF prints, as data, customer-facing (no COGS or margins): reference number, dates, presented to/by, system, package detail, payment options, selected terms + disclosure, full schedule of payments, savings and returns, warranties, T&Cs with the validity tokens filled in, disclaimers; plus `odooPayload`, the exact body the calculator would POST to create the draft quotation (reference only) |
| `calc_parameter_history` | `parameter_audit_events`: actor, role, admin tab, applied keys, field-level before/after |

Every tool takes `environment` (`production` by default). All prices are PHP
and VAT-inclusive; margins and rates are fractions; tenor 0 is a Direct
Purchase. Quote inputs mirror the calculator's Steps 1–4; anything omitted
takes the calculator's default, so `calc_quote` with only `monthlyBill`
reproduces a fresh session with that bill.

Nothing writes: the database role is SELECT-only, Odoo is never contacted,
and no PDF is produced. A rep still generates the PDF and pushes the Odoo
quotation from the calculator.

## How it reads the database

One Postgres connection string per environment, for the SELECT-only role
`db_mcp_ro` created by `supabase/migrations/20261014_create_db_mcp_ro_role.sql`
(the same role and the same env-var names the "Solviva Databases" connector
uses, so no new credential was created):

| Variable | Project |
| --- | --- |
| `DB_MCP_CALC_URL` | production `gbwfhacvklwieqnydqzb` |
| `DB_MCP_CALC_STAGING_URL` | staging `xifuuxtsdyajcbyksjxx` |
| `DB_MCP_CALC_TESTING_URL` | testing `azljcxncghmncvwrphdq` |

Session-pooler strings (port 5432). An unset one leaves that environment
"not configured" and its calls answer with a clear message. Only two tables
are read: `app_parameters` (cached 30 s per environment, like the website
estimate) and `parameter_audit_events`. Every query runs in an explicit
`READ ONLY` transaction that is rolled back.

TLS: Supabase signs its pooler certificates with its own root ("Supabase Root
2021 CA", the `prod-ca-2021.crt` the dashboard offers), which Node does not
trust by default. That root is pinned in `supabase-root-2021-ca.pem`
(SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`;
compare with the dashboard download) and verified on every connection.
`CALC_MCP_PG_CA_FILE` points at another file; `CALC_MCP_PG_SSL_VERIFY=false`
disables verification (not recommended).

## Running it

```bash
npm ci                                         # once; links packages/calc-engine
npm run mcp                                    # stdio (Claude Code)
CALC_MCP_SERVICE_TOKEN=… npm run mcp:http      # HTTP on $PORT (default 8083)
node mcp/server.js --http --allow-any-ip       # HTTP without the IP allowlist (local tests only)
```

Environment variables (`.env` in this repo is loaded first, then the file
named by `CALC_MCP_ENV_FILE`, real environment variables win over both):

| Variable | Purpose |
| --- | --- |
| `DB_MCP_CALC_URL`, `DB_MCP_CALC_STAGING_URL`, `DB_MCP_CALC_TESTING_URL` | the read-only connection strings above |
| `CALC_MCP_SERVICE_TOKEN` | shared bearer token for HTTP mode (required there); `openssl rand -hex 32` |
| `MCP_PUBLIC_HOST` | public hostname; when set, requests with another `Host` header are refused (DNS-rebinding guard) |
| `MCP_RESTRICT_IPS` | `false` skips the Anthropic egress allowlist (`160.79.104.0/21`); default on |
| `CALC_MCP_ENV_FILE` | an extra `.env` to load (locally the `DB_MCP_*` strings live in the monitoring repo's `.env`) |
| `PORT` | HTTP port (Render sets it) |

Locally, Claude Code reaches it over stdio through `solviva-inquiry/.mcp.json`
(server `internalcalc`, with `CALC_MCP_ENV_FILE` pointing at the monitoring
repo's `.env`).

## Deploying the claude.ai connector (Render)

Not a Blueprint: this repo's services were created in the dashboard, so
create this one the same way.

1. Render → New → Web Service → repository `solvivaenergy/InternalCalcBackEnd`,
   branch `main`, name `internalcalc-mcp`, runtime **Node**, region Singapore,
   build `npm ci`, start `npm run mcp:http`, plan **Starter** (not Free: a
   cold start blows Claude's connector timeout), health check path `/healthz`.
2. Environment: `NODE_VERSION=22`, `CALC_MCP_SERVICE_TOKEN` (new secret),
   `MCP_PUBLIC_HOST=internalcalc-mcp.onrender.com`, and the three
   `DB_MCP_CALC*_URL` values copied from the `solviva-db-mcp` service.
3. Check: `curl https://internalcalc-mcp.onrender.com/healthz` → `{"status":"ok"}`;
   a `POST /mcp` without a token → `401`; from a non-Anthropic address →
   `403`. The service log prints `environments configured: production,
   staging, testing` at boot.
4. claude.ai → Organizational settings → Connectors → add a custom connector:
   name **Internal Calculator Engine**, URL `https://internalcalc-mcp.onrender.com/mcp`,
   and the same request-header setup as Solviva Databases
   (`Authorization: Bearer <token>`). No OAuth: the server deliberately sends
   no `WWW-Authenticate` header.

Rotate the token by changing it on the service and in the connector. Rotate
the database password by re-running the role migration and updating the three
URLs here and on `solviva-db-mcp`.

## Files

| File | What |
| --- | --- |
| `server.js` | entry point: stdio or `--http` (Express, stateless streamable HTTP, one server per request) |
| `tools.js` | the eight tools, their zod schemas and the server instructions |
| `engine.js` | `withRuntime()` (fill the engine's live objects from a stored row and compute synchronously), inputs → calculator state, the internal projection, Odoo order lines |
| `proposal.js` | the proposal package, quote reference, Odoo payload |
| `parameters.js` | parameter sections, margin schedule, rate table |
| `db.js` | per-environment `pg` pools for `db_mcp_ro`, parameter cache, audit query |
| `auth.js` | bearer token + Anthropic IP allowlist + Host guard (port of monitoring `mcp_auth.py`) |
| `env.js` | env loading (`.env`, then `CALC_MCP_ENV_FILE`) |
| `supabase-root-2021-ca.pem` | the pinned Supabase root CA |
