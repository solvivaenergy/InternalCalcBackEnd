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
- `VITE_SUPERADMIN_PASSWORD`
- `VITE_ENGINEERING_PASSWORD`
- `VITE_PRODUCT_PASSWORD`

## Local run

```bash
npm install
npm start
```
