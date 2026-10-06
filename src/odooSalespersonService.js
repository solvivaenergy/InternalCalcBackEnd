// =============================================================================
// ODOO SALESPERSON — who presents the proposal (sprint Dinuguan follow-up)
// -----------------------------------------------------------------------------
// One rule, shared by the lead lookup (GET /api/crm-contact, which prefills the
// Solviva Agent details) and the quotation push (POST /api/odoo/quotation,
// which sets sale.order.user_id), so the agent printed on the proposal and the
// salesperson on the Odoo quotation are the same person:
//
//   1. the lead's ASSIGNED salesperson (crm.lead.user_id) — user decision
//      2026-10-05: the proposal carries the assigned rep's name and number;
//   2. otherwise the signed-in calculator user, matched to res.users by
//      login/email (a lead that has no salesperson yet);
//   3. otherwise nobody (source "none").
//
// Until 2026-10-05 the push preferred the signed-in user and fell back to the
// lead, which put whoever clicked Generate on the quotation instead of the
// opportunity's owner. Odoo's own "New Quotation" button takes the lead's
// salesperson, and now so does the calculator.
//
// The profile carries name, email and a PH mobile. On this instance an internal
// user's number lives almost entirely in the partner `phone` field (57 of 105
// active internal users on 2026-10-05; of the 28 sales reps with an Odoo user,
// 24 had a usable number there and 1 in `mobile`), while the HR work mobile /
// work phone and the partner `mobile` were set on a handful. So the fields are
// tried most-specific first and the first value that normalises to 09XXXXXXXXX
// wins; anything else is reported as missing rather than guessed.
// =============================================================================

import { searchRead, likeExact } from "./odooClient.js";
import { normalisePhPhone } from "./phPhone.js";

// Most-specific first. mobile_phone / work_phone are hr.employee related
// fields and exist only with HR installed (it is, on both builds); the read
// below retries without them if Odoo rejects the field list.
export const PHONE_FIELD_ORDER = ["mobile", "mobile_phone", "phone", "work_phone"];
const USER_FIELDS = ["id", "name", "login", "email", ...PHONE_FIELD_ORDER];
const USER_FIELDS_BASE = ["id", "name", "login", "email", "mobile", "phone"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// Pure. The first field that normalises wins, or null.
export function pickUserMobile(user) {
  for (const f of PHONE_FIELD_ORDER) {
    const n = normalisePhPhone(typeof user?.[f] === "string" ? user[f] : "");
    if (n) return n;
  }
  return null;
}

// Pure. { id, name, email, mobile } with nulls for what Odoo does not have.
// login is the email address on this instance, so it stands in when the
// partner has no email; a login that is not an address is not reported as one.
export function userProfile(user) {
  if (!user) return null;
  const email = [user.email, user.login].map(clean).find((v) => v && EMAIL_RE.test(v)) || null;
  return { id: user.id, name: clean(user.name), email, mobile: pickUserMobile(user) };
}

async function readUsers(cfg, domain, signal) {
  try {
    return (await searchRead(cfg, "res.users", domain, USER_FIELDS, signal, { limit: 1 })) || [];
  } catch (err) {
    if (!/field/i.test(String(err && err.message))) throw err;
    return (await searchRead(cfg, "res.users", domain, USER_FIELDS_BASE, signal, { limit: 1 })) || [];
  }
}

export async function findUserByEmail(cfg, email, signal) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const rows = await readUsers(
    cfg,
    ["&", ["active", "=", true], "|", ["login", "=ilike", likeExact(e)], ["email", "=ilike", likeExact(e)]],
    signal,
  );
  return rows[0] || null;
}

// Archived users included: an opportunity can still point at a rep who has
// left, and the proposal should say so rather than silently switch presenter.
export async function readUser(cfg, id, signal) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await readUsers(cfg, [["id", "=", id], ["active", "in", [true, false]]], signal);
  return rows[0] || null;
}

/**
 * Resolve the salesperson for a lead (or, with no lead, for the caller).
 *   { source: "lead" | "calculator-user" | "none", userId, profile }
 * `lead` is a crm.lead row read with `user_id`; `callerEmail` the verified
 * session's email. Throws on an Odoo failure — callers decide whether that
 * fails their request (the push) or degrades it (the lookup).
 */
export async function resolveSalesperson(cfg, { lead, callerEmail } = {}, signal) {
  const leadUserId = Array.isArray(lead?.user_id) ? lead.user_id[0] : null;
  if (leadUserId) {
    const user = await readUser(cfg, leadUserId, signal);
    // The id is authoritative even when the record is not readable (a record
    // rule, say): the push can still assign it, and the name on the lead's
    // many2one is better than nothing for the proposal.
    const profile = userProfile(user || { id: leadUserId, name: lead.user_id[1] });
    return { source: "lead", userId: leadUserId, profile };
  }
  const own = await findUserByEmail(cfg, callerEmail, signal);
  if (own) return { source: "calculator-user", userId: own.id, profile: userProfile(own) };
  return { source: "none", userId: null, profile: null };
}

// The wire shape the lead lookup returns under `salesperson`. Pure.
export function salespersonPayload({ source, profile }) {
  const warnings = [];
  if (source === "none") warnings.push("salesperson_missing");
  else if (!profile?.mobile) warnings.push("salesperson_mobile_missing");
  return {
    source,
    name: profile?.name || null,
    email: profile?.email || null,
    mobile: profile?.mobile || null,
    warnings,
  };
}
