# InternalCalcBackEnd

Render-ready backend for the Solviva calculator.

## Endpoints

- `GET /health`
- `POST /api/quote`
- `GET /api/parameters`
- `PUT /api/parameters`

## Environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PORT` (optional, default `3000`)
- `CORS_ORIGINS` (optional, comma-separated list or `*`)
- `PARAMETERS_STORAGE` (optional; set to `local-json` only for local development)
- `VITE_SUPERADMIN_PASSWORD`
- `VITE_ENGINEERING_PASSWORD`
- `VITE_PRODUCT_PASSWORD`

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
