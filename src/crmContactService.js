// =============================================================================
// CRM CONTACT SERVICE — Odoo lead lookup (story 043D)
// -----------------------------------------------------------------------------
// Resolves a "Project Number" typed by a sales rep into the customer's name,
// email and mobile number, so the rep does not retype what the CRM already has.
//
// WHY THIS LIVES SERVER-SIDE
//   The frontend is a static bundle published to GitHub Pages. Anything with a
//   VITE_ prefix is readable by anyone who opens devtools, so the Odoo API key
//   cannot go there. This service holds the credential and returns only the
//   three fields the form needs.
//
// Transport is JSON-RPC over global fetch — no new dependency. The instance's
// /xmlrpc/2/common returns HTTP 405, so JSON-RPC is the only option.
// =============================================================================

import { verifySession } from "./parametersService.js";

// Read lazily, not at module-evaluation time: env loading happens in an
// imported side-effect module, and a top-level read here could still race it.
const odooTimeoutMs = () => Number(process.env.ODOO_TIMEOUT_MS || 8000);

// "Project Number" is the crm.lead record id — the instance has no
// project-number field (a full 660-field dump of crm.lead has no
// sequence/reference candidate), and the Odoo form label showing e.g.
// "Project Number 52210" matches the record URL /odoo/action-893/52210.
// Leading zeros are rejected so "0" and "000" cannot reach Odoo.
const PROJECT_NUMBER_RE = /^[1-9]\d{0,8}$/;

// ─── Odoo agent-number blocklist ─────────────────────────────────────────────
// crm.lead.mobile is NOT the customer's number on this instance — it carries
// Solviva's own agent/telemarketer numbers. Nine values account for 5,262 of
// the 11,911 leads that have one, with a 10x frequency cliff after rank 9.
// Shipping one of these would print a Solviva agent's number on a customer
// proposal, so they are rejected outright. The list is a FLOOR, not a complete
// roster (the tail continues below the cliff), which is why `mobile` is only
// ever consulted when `phone` is empty.
const AGENT_NUMBERS = new Set([
  "09054878872",
  "09235013090",
  "09686112768",
  "09774818637",
  "09565641408",
  "09279210928",
  "09994321012",
  "09998834705",
  "09175325680",
]);

// ─── Phone normalisation ─────────────────────────────────────────────────────
// The calculator's own validator (frontend src/lib/validation.js isValidPhPhone)
// requires 11+ digits starting "09". Odoo's dominant storage format is "+639…"
// (175,587 leads), which FAILS that validator — and formatPhPhone passes non-09
// input through unchanged, so it cannot rescue it. Populating the raw Odoo value
// would hand the rep a number they did not type, mark it invalid, and block
// "Save changes". So normalise here, and return null rather than guess.
//
// Allowlist only: every shape not explicitly matched returns null so the rep
// types it manually. Notably "0919 0916 155 - 09913005620" (22 digits) would
// PASS isValidPhPhone verbatim and then be silently truncated by formatPhPhone,
// so "passes the validator" is not on its own a safe test.
export function normalisePhPhone(raw) {
  if (!raw || typeof raw !== "string") return null;
  // Multi-number fields are real ("+639437295737 /  0933 8664343"). Try each
  // token, first success wins. NOT split on "-": that is the separator in the
  // app's own display format, 0917-841-5976.
  for (const token of raw.split(/\s*[/,;]\s*/)) {
    let d = token.replace(/\D+/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    let out = null;
    if (d.length === 12 && d.startsWith("63")) out = `0${d.slice(2)}`;
    else if (d.length === 11 && d.startsWith("09")) out = d;
    else if (d.length === 10 && d.startsWith("9")) out = `0${d}`;
    if (out) return out;
  }
  return null;
}

// ─── Email salvage ───────────────────────────────────────────────────────────
// Same regex the frontend form validates with, so this service never returns
// something the form will immediately redden.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Real multi-address separators on this instance are " / ", ";" and " or " —
// commas are almost always comma-for-dot TYPOS ("janine12Falcon@gmail,com"),
// which a naive comma split mangles into an unrecoverable string. So commas are
// deliberately NOT separators here; a malformed value is returned raw for the
// rep to see and fix.
export function salvageEmail(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { email: null, warning: "email_missing" };
  if (EMAIL_RE.test(value)) return { email: value, warning: null };
  for (const token of value.split(/\s*(?:[;/]|\bor\b)\s*/i)) {
    const t = token.trim();
    if (EMAIL_RE.test(t)) return { email: t, warning: null };
  }
  // Junk exists in this column (a phone number, a person's name, a single "h").
  // Surface it rather than hiding it, so the rep can correct it.
  return { email: value, warning: "email_unparseable" };
}

// ─── Name resolution ─────────────────────────────────────────────────────────
// partner_id[1] FIRST, and this is deliberate: on the story's worked example
// (lead 52210) contact_name is "Patrick (Test)" while partner_id is
// [32179, "Lili Narvaez"] — a DIFFERENT person, and "Lili Narvaez" is the value
// the rep expects. 99.83% of leads have a partner_id, so the lead-level
// fallbacks below are near-dead code kept only for the 355 that do not.
// partner_name is Odoo's *Company Name* field, hence last.
//
// Do NOT reorder this to prefer contact_name, and do NOT add a "company
// detector" that switches away from partner_id — where both fields are set they
// are usually misspelt duplicates of the same person, and switching would
// discard the right name for an unrelated one.
export function resolveName(lead) {
  const partner = Array.isArray(lead.partner_id) ? lead.partner_id[1] : null;
  const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return clean(partner) || clean(lead.contact_name) || clean(lead.partner_name);
}

// ─── Odoo JSON-RPC ───────────────────────────────────────────────────────────

function odooConfig() {
  const url = (process.env.ODOO_URL || "").replace(/\/+$/, "");
  const db = process.env.ODOO_DB || "";
  const user = process.env.ODOO_USER || "";
  const apiKey = process.env.ODOO_API_KEY || "";
  if (!url || !db || !user || !apiKey) return null;
  return { url, db, user, apiKey };
}

// Odoo answers FAULTS with HTTP 200 and an `error` key, so `res.ok` proves
// nothing. Worse, wrong credentials return 200 with `{"result": false}` and no
// `error` key at all — which is why callers must type-check `result` rather
// than truthiness alone.
async function rpc(cfg, payload, signal) {
  const res = await fetch(`${cfg.url}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, ...payload }),
    signal,
  });
  if (!res.ok) throw new Error(`odoo http ${res.status}`);
  const body = await res.json();
  // Never propagate body.error upward verbatim: Odoo fault payloads embed a
  // full traceback plus the database name and username.
  if (body && body.error) {
    const data = (body.error && body.error.data) || {};
    throw new Error(`odoo fault ${data.name || body.error.message || "unknown"}`);
  }
  return body ? body.result : undefined;
}

// authenticate() costs a round trip, so the uid is cached in module memory.
// A stale uid surfaces as an access error, which callers recover from by
// clearing the cache and authenticating once more.
let uidCache = { uid: null, at: 0 };
const UID_TTL_MS = 10 * 60 * 1000;

async function authenticate(cfg, signal, force = false) {
  const fresh = Date.now() - uidCache.at < UID_TTL_MS;
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
  uidCache = { uid: result, at: Date.now() };
  return result;
}

function searchRead(cfg, uid, model, domain, fields, signal) {
  return rpc(
    cfg,
    {
      params: {
        service: "object",
        method: "execute_kw",
        args: [cfg.db, uid, cfg.apiKey, model, "search_read", [domain], { fields, limit: 1 }],
      },
    },
    signal,
  );
}

const LEAD_FIELDS = [
  "id",
  "partner_id",
  "contact_name",
  "partner_name",
  "email_from",
  "phone",
  "mobile",
];

// ─── Public entry point ──────────────────────────────────────────────────────

export async function getCrmContact(projectNumber, accessToken) {
  const raw = String(projectNumber ?? "").trim();
  if (!PROJECT_NUMBER_RE.test(raw)) {
    return {
      status: 400,
      payload: { error: "projectNumber must be a positive integer." },
    };
  }

  // Any authenticated Supabase user may look up (product decision). The token
  // is verified SERVER-side — the frontend's own login gate and its
  // rep/customer mode flag are client-side only and protect nothing here.
  const session = await verifySession(accessToken);
  if (session.error) {
    return { status: session.status, payload: { error: session.error } };
  }

  const cfg = odooConfig();
  if (!cfg) {
    // Distinguished from a transient Odoo failure on purpose. Reporting a
    // missing credential as "try again shortly" sends whoever is debugging
    // after a network fault that does not exist. Names which vars are absent
    // (never their values) because this is an operator error, not a rep one.
    const missing = ["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_API_KEY"].filter(
      (k) => !process.env[k],
    );
    console.error("[crm-contact] odoo not configured", { missing });
    return {
      status: 503,
      payload: {
        error: "CRM lookup is not configured on the server.",
        code: "not_configured",
      },
    };
  }

  const id = Number(raw);
  const signal = AbortSignal.timeout(odooTimeoutMs());

  let rows;
  try {
    let uid = await authenticate(cfg, signal);
    // search_read rather than read: an absent id — or one hidden by a record
    // rule — collapses to [] instead of raising, so one 404 path covers both.
    // The `active` leaf is mandatory: 18.9% of leads are archived and some are
    // still quotable, so omitting it would 404 ~38k valid Project Numbers.
    const domain = [
      ["id", "=", id],
      ["active", "in", [true, false]],
    ];
    try {
      rows = await searchRead(cfg, uid, "crm.lead", domain, LEAD_FIELDS, signal);
    } catch (err) {
      // One retry on a possibly-stale cached uid.
      if (/access|session|uid/i.test(String(err.message))) {
        uid = await authenticate(cfg, signal, true);
        rows = await searchRead(cfg, uid, "crm.lead", domain, LEAD_FIELDS, signal);
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Log the shape, never the contact data.
    console.error("[crm-contact] odoo lookup failed", {
      projectNumber: id,
      reason: String(err && err.message).slice(0, 120),
    });
    return { status: 502, payload: { error: "CRM lookup unavailable." } };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      status: 404,
      payload: { error: "No lead found for that Project Number." },
    };
  }

  const lead = rows[0];
  const warnings = [];

  const name = resolveName(lead);
  if (!name) warnings.push("name_missing");

  const { email, warning: emailWarning } = salvageEmail(lead.email_from);
  if (emailWarning) warnings.push(emailWarning);

  // phone is the customer's number; mobile is only consulted when phone is
  // empty, and then only if it is not a known agent number.
  let mobile = normalisePhPhone(lead.phone);
  if (!mobile && lead.phone) warnings.push("phone_unnormalisable");
  if (!mobile && !lead.phone) {
    const fallback = normalisePhPhone(lead.mobile);
    if (fallback && AGENT_NUMBERS.has(fallback)) {
      warnings.push("phone_agent_blocklisted");
    } else if (fallback) {
      mobile = fallback;
    } else {
      warnings.push("phone_missing");
    }
  }
  if (mobile && AGENT_NUMBERS.has(mobile)) {
    mobile = null;
    warnings.push("phone_agent_blocklisted");
  }

  // Shown to the rep for context, never auto-substituted for `name`.
  // Compared on collapsed whitespace: contact_name is very often the same
  // human as partner_id with different spacing ("Rowell  Vitug" vs "Rowell
  // Vitug"), and reporting that as an alternative name is pure noise.
  const squash = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
  const alternate = [lead.contact_name, lead.partner_name]
    .map(squash)
    .find((v) => v && v.toLowerCase() !== squash(name).toLowerCase());
  if (alternate) warnings.push("contact_name_differs");

  // Deliberately minimal. crm.lead has 660 fields; a pass-through proxy would
  // ship pipeline, commission and internal-note data into the browser.
  return {
    status: 200,
    payload: {
      projectNumber: id,
      name: name || null,
      email: email || null,
      mobile: mobile || null,
      alternateName: alternate || null,
      warnings,
    },
  };
}
