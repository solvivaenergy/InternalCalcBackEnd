// =============================================================================
// DATABASE ACCESS for the MCP server — read-only, one Supabase project per env
// -----------------------------------------------------------------------------
// The server reads exactly two tables per environment: app_parameters (the
// single live parameter row the calculator prices from) and
// parameter_audit_events (who changed which parameter, when). It connects as
// the SELECT-only Postgres role `db_mcp_ro` that the "Solviva Databases"
// connector already uses (supabase/migrations/20261014_create_db_mcp_ro_role.sql),
// through the same three Session-pooler connection strings, so adding this
// server created no new credential:
//
//   DB_MCP_CALC_URL           production   gbwfhacvklwieqnydqzb
//   DB_MCP_CALC_STAGING_URL   staging      xifuuxtsdyajcbyksjxx
//   DB_MCP_CALC_TESTING_URL   testing      azljcxncghmncvwrphdq
//
// Why it cannot write: the role holds SELECT only and defaults every
// transaction to READ ONLY; on top of that every query here runs inside an
// explicit READ ONLY transaction that is always rolled back. An unset URL
// leaves that environment "not configured" and its tools answer with a clear
// message instead of a crash.
// =============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Supabase signs its pooler certificates with its own root ("Supabase Root
// 2021 CA", the prod-ca-2021.crt the dashboard offers for download), which is
// not in Node's root store — so without this file every connection fails with
// SELF_SIGNED_CERT_IN_CHAIN, and the only alternative is to skip verification.
// Pinned here instead; CALC_MCP_PG_CA_FILE points at a different file,
// CALC_MCP_PG_SSL_VERIFY=false disables verification (not recommended).
const DEFAULT_CA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "supabase-root-2021-ca.pem");

export const ENVIRONMENTS = {
  production: {
    env: "DB_MCP_CALC_URL",
    ref: "gbwfhacvklwieqnydqzb",
    title: "Internal Calculator (production)",
    site: "https://internalcalc.solvivaenergy.com",
  },
  staging: {
    env: "DB_MCP_CALC_STAGING_URL",
    ref: "xifuuxtsdyajcbyksjxx",
    title: "Internal Calculator (staging)",
    site: "https://staging-internalcalc.solvivaenergy.com",
  },
  testing: {
    env: "DB_MCP_CALC_TESTING_URL",
    ref: "azljcxncghmncvwrphdq",
    title: "Internal Calculator (testing)",
    site: null,
  },
};

export const ENVIRONMENT_KEYS = Object.keys(ENVIRONMENTS);

// A parameter save in the admin screens reaches this server within this
// window; the same figure the website estimate endpoint uses.
const PARAMS_CACHE_MS = 30_000;
const STATEMENT_TIMEOUT_MS = 30_000;

const pools = new Map();
const paramsCache = new Map();

export function isConfigured(environment) {
  const meta = ENVIRONMENTS[environment];
  return !!meta && !!(process.env[meta.env] || "").trim();
}

export function configuredEnvironments() {
  return ENVIRONMENT_KEYS.filter(isConfigured);
}

export class EnvironmentError extends Error {}

let caCache;
function caBundle() {
  if (caCache === undefined) {
    const file = (process.env.CALC_MCP_PG_CA_FILE || "").trim() || DEFAULT_CA_FILE;
    try {
      caCache = readFileSync(file, "utf8");
    } catch (error) {
      console.error(`[db] cannot read CA file ${file}: ${error.message}; falling back to Node's root store`);
      caCache = null;
    }
  }
  return caCache;
}

function sslFor(connectionString) {
  // Supabase's pooler requires TLS. The chain is verified against the pinned
  // Supabase root (above) plus Node's root store; CALC_MCP_PG_SSL_VERIFY=false
  // turns verification off (the Python connector's sslmode=require behaviour).
  let sslmode = "";
  try {
    sslmode = new URL(connectionString).searchParams.get("sslmode") || "";
  } catch {
    /* a malformed URL fails at connect time with pg's own message */
  }
  if (sslmode === "disable") return false;
  const verify = (process.env.CALC_MCP_PG_SSL_VERIFY || "true").toLowerCase() !== "false";
  const ca = verify ? caBundle() : null;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: verify };
}

function pool(environment) {
  const meta = ENVIRONMENTS[environment];
  if (!meta) {
    throw new EnvironmentError(
      `unknown environment ${JSON.stringify(environment)}; one of: ${ENVIRONMENT_KEYS.join(", ")}`,
    );
  }
  const dsn = (process.env[meta.env] || "").trim();
  if (!dsn) {
    throw new EnvironmentError(
      `environment "${environment}" is not configured on this server (${meta.env} is unset)`,
    );
  }
  if (!pools.has(environment)) {
    pools.set(
      environment,
      new pg.Pool({
        connectionString: dsn,
        ssl: sslFor(dsn),
        max: 2,
        idleTimeoutMillis: 60_000,
        connectionTimeoutMillis: 15_000,
        statement_timeout: STATEMENT_TIMEOUT_MS,
        application_name: "internalcalc-mcp",
      }),
    );
  }
  return pools.get(environment);
}

// Run one parameterised query inside a READ ONLY transaction that is always
// rolled back. Returns the rows.
async function readQuery(environment, sql, params = []) {
  const client = await pool(environment).connect();
  try {
    await client.query("begin read only");
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    try {
      await client.query("rollback");
    } catch {
      /* the connection is being released anyway */
    }
    client.release();
  }
}

// The stored app_parameters payload (admin overrides over the bundled
// defaults) and when it was last saved. Cached for PARAMS_CACHE_MS per
// environment; the caller receives a fresh deep copy because buildRuntime
// edits the override in place.
export async function readParameters(environment, { fresh = false } = {}) {
  const now = Date.now();
  const cached = paramsCache.get(environment);
  if (!fresh && cached && now - cached.at < PARAMS_CACHE_MS) {
    return { payload: JSON.parse(cached.json), updatedAt: cached.updatedAt, cached: true };
  }
  const rows = await readQuery(
    environment,
    "select payload, updated_at from app_parameters where id = true",
  );
  const row = rows[0] || { payload: {}, updated_at: null };
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const updatedAt = row.updated_at ? new Date(row.updated_at).toISOString() : null;
  paramsCache.set(environment, { at: now, json: JSON.stringify(payload), updatedAt });
  return { payload: JSON.parse(JSON.stringify(payload)), updatedAt, cached: false };
}

// Parameter audit history, newest first. `area` matches the admin tab(s) the
// save touched — the column holds tab names, comma-joined when a save spanned
// several ("Product", "Engineering", "FinCo", "Inventory,Product") — as a
// case-insensitive substring; `since` an ISO timestamp; `actor` a
// case-insensitive substring of the actor's email.
export async function readAuditEvents(
  environment,
  { limit = 50, area = null, since = null, actor = null, includePayloads = false } = {},
) {
  const n = Math.max(1, Math.min(Number(limit) || 50, 200));
  const cols = [
    "id",
    "actor_email",
    "actor_role",
    "area",
    "source",
    "occurred_at",
    "timezone",
    "changes",
    "applied_admin_keys",
    "ignored_admin_keys",
    "inventory_applied",
    "request_id",
    "metadata",
  ];
  if (includePayloads) cols.push("before_payload", "after_payload");
  return readQuery(
    environment,
    `select ${cols.join(", ")}
       from parameter_audit_events
      where ($2::text is null or area ilike '%' || $2 || '%')
        and ($3::timestamptz is null or occurred_at >= $3)
        and ($4::text is null or actor_email ilike '%' || $4 || '%')
      order by occurred_at desc
      limit $1`,
    [n, area || null, since || null, actor || null],
  );
}

export async function closePools() {
  await Promise.all([...pools.values()].map((p) => p.end().catch(() => {})));
  pools.clear();
}
