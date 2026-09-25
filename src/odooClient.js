// =============================================================================
// ODOO CLIENT — shared JSON-RPC transport for every Odoo-facing service
// -----------------------------------------------------------------------------
// Extracted from crmContactService.js (story 043D) when the Dinuguan sprint
// added a second caller (odooQuotationService.js, stories 064C/J/K). One
// credential, one uid cache, one fault-handling policy.
//
// WHY THIS LIVES SERVER-SIDE
//   The frontend is a static bundle. Anything with a VITE_ prefix is readable
//   by anyone who opens devtools, so the Odoo API key cannot go there.
//
// Transport is JSON-RPC over global fetch — no new dependency. The instance's
// /xmlrpc/2/common returns HTTP 405, so JSON-RPC is the only option.
// =============================================================================

// Read lazily, not at module-evaluation time: env loading happens in an
// imported side-effect module, and a top-level read here could still race it.
export const odooTimeoutMs = () => Number(process.env.ODOO_TIMEOUT_MS || 8000);

export const ODOO_ENV_KEYS = ["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_API_KEY"];

export function odooConfig() {
  const url = (process.env.ODOO_URL || "").replace(/\/+$/, "");
  const db = process.env.ODOO_DB || "";
  const user = process.env.ODOO_USER || "";
  const apiKey = process.env.ODOO_API_KEY || "";
  if (!url || !db || !user || !apiKey) return null;
  return { url, db, user, apiKey };
}

// Names (never values) of the absent variables, for operator-facing logs.
export function missingOdooEnv() {
  return ODOO_ENV_KEYS.filter((k) => !process.env[k]);
}

// Odoo answers FAULTS with HTTP 200 and an `error` key, so `res.ok` proves
// nothing. Worse, wrong credentials return 200 with `{"result": false}` and no
// `error` key at all — which is why callers must type-check `result` rather
// than truthiness alone.
export async function rpc(cfg, payload, signal) {
  const res = await fetch(`${cfg.url}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, ...payload }),
    signal,
  });
  if (!res.ok) throw new Error(`odoo http ${res.status}`);
  const body = await res.json();
  // Never propagate body.error upward verbatim: Odoo fault payloads embed a
  // full traceback plus the database name and username. Keep the exception
  // class and the first line of its message — enough to act on, nothing more.
  if (body && body.error) {
    const data = (body.error && body.error.data) || {};
    const message = String(data.message || body.error.message || "").split("\n")[0].slice(0, 160);
    const err = new Error(`odoo fault ${data.name || "unknown"}${message ? `: ${message}` : ""}`);
    err.odooFault = data.name || null;
    throw err;
  }
  return body ? body.result : undefined;
}

// authenticate() costs a round trip, so the uid is cached in module memory.
// A stale uid surfaces as an access error, which executeKw recovers from by
// clearing the cache and authenticating once more.
let uidCache = { uid: null, at: 0, key: "" };
const UID_TTL_MS = 10 * 60 * 1000;

export async function authenticate(cfg, signal, force = false) {
  const cacheKey = `${cfg.url}|${cfg.db}|${cfg.user}`;
  const fresh = Date.now() - uidCache.at < UID_TTL_MS && uidCache.key === cacheKey;
  if (!force && uidCache.uid && fresh) return uidCache.uid;
  const result = await rpc(
    cfg,
    {
      params: {
        service: "common",
        method: "authenticate",
        args: [cfg.db, cfg.user, cfg.apiKey, {}],
      },
    },
    signal,
  );
  // Bad credentials land here as `false`, not as an error.
  if (typeof result !== "number") throw new Error("odoo auth rejected");
  uidCache = { uid: result, at: Date.now(), key: cacheKey };
  return result;
}

const isStaleSessionError = (err) => /access|session|uid/i.test(String(err && err.message));

// execute_kw with the cached uid and ONE retry on a possibly-stale session.
// `kwargs` is passed through untouched (fields, limit, context, ...).
export async function executeKw(cfg, model, method, args, kwargs = {}, signal) {
  const run = (uid) =>
    rpc(
      cfg,
      {
        params: {
          service: "object",
          method: "execute_kw",
          args: [cfg.db, uid, cfg.apiKey, model, method, args, kwargs],
        },
      },
      signal,
    );
  let uid = await authenticate(cfg, signal);
  try {
    return await run(uid);
  } catch (err) {
    if (!isStaleSessionError(err)) throw err;
    uid = await authenticate(cfg, signal, true);
    return await run(uid);
  }
}

// Convenience wrappers used by more than one service.
export function searchRead(cfg, model, domain, fields, signal, extra = {}) {
  return executeKw(cfg, model, "search_read", [domain], { fields, ...extra }, signal);
}

// Odoo stores datetimes as naive UTC "YYYY-MM-DD HH:MM:SS" and dates as
// "YYYY-MM-DD". Both helpers accept a Date or an ISO string and return null for
// anything unparseable, so a bad client value never reaches the ORM as garbage.
export function toOdooDatetime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// Calendar date IN MANILA for the given instant. The calculator computes
// "valid until" on the rep's clock; Render runs on UTC, so slicing the ISO
// string would move a late-evening issue date to the previous day.
export function toOdooDateManila(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA yields YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
