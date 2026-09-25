// =============================================================================
// ODOO QUOTATION SERVICE — create a quotation after a proposal PDF (064C/J/K)
// -----------------------------------------------------------------------------
// The calculator calls POST /api/odoo/quotation right after it saves a proposal
// PDF for a customer who was loaded from an Odoo lead. This service turns that
// proposal into a DRAFT sale.order on the lead's opportunity:
//
//   064C  customer (the lead's partner), quotation date, expiration, salesperson
//   064E  the calculator's financing figures (x_calc_* fields, added by
//         scripts/odoo/apply-dinuguan.mjs) so Odoo's bill schedule can anchor on
//         the calculator's own amortisation
//   064J  one Bill-of-Quantities row per package inclusion, with quantities
//   064K  written into the x_boq_line_ids table on the same create call
//
// PRODUCT DECISIONS (sprint Dinuguan refinement, 2026-09-25):
//   • No lead id → no quotation. The frontend does not call this route at all
//     in that case; a request without leadId is a 400.
//   • The Odoo contact is never edited from here, even if the rep changed the
//     name in the calculator. The quotation points at the lead's partner.
//   • Every PDF generation creates a NEW quotation (no upsert). client_order_ref
//     carries the proposal reference so duplicates are visible, not hidden.
//   • Salesperson = the signed-in calculator user, matched to res.users by
//     email; falls back to the lead's own salesperson when there is no match.
//   • This call must never block the PDF. The frontend treats any failure as a
//     warning banner, so this service returns structured errors, never throws.
//
// FIELD TOLERANCE: the x_calc_* / x_boq_line_ids fields are created by the
// Odoo-side apply script. Until that has run on an environment, the service
// still creates the quotation and reports the skipped fields in `warnings`.
// =============================================================================

import { getSupabaseClient } from "./parametersService.js";
import {
  odooConfig,
  missingOdooEnv,
  odooTimeoutMs,
  executeKw,
  searchRead,
  toOdooDatetime,
  toOdooDateManila,
} from "./odooClient.js";

const LEAD_ID_RE = /^[1-9]\d{0,8}$/;
const MAX_BOQ_ROWS = 200;
const PACKAGES = new Set(["A", "B", "C"]);

// Product names as created by scripts/odoo/apply-dinuguan.mjs (story 064G).
// Exported so the apply script and this service cannot drift apart.
export const PACKAGE_PRODUCT_NAMES = {
  A: "A. Solar Package",
  B: "B. Battery Package",
  C: "C. Misc. Materials, Labor, Services & Other Adjustments",
};

// Calculator figures → sale.order custom fields. Only fields that exist on the
// target database are written (see fieldsAvailable below).
const CALC_FIELD_MAP = [
  ["x_calc_proposal_ref", (p) => str(p.quoteRef, 64)],
  ["x_calc_generated_at", (p) => toOdooDatetime(p.generatedAt)],
  ["x_calc_financing_type", (p) => str(p.quote.financingType, 32)],
  ["x_calc_net_price", (p) => num(p.quote.netPrice)],
  ["x_calc_discount_amount", (p) => num(p.quote.discountAmount)],
  ["x_calc_promo_code", (p) => str(p.quote.promoCode, 64)],
  ["x_calc_downpayment_pct", (p) => num(p.quote.downPaymentPct)],
  ["x_calc_downpayment_amount", (p) => num(p.quote.downPaymentAmount)],
  ["x_calc_tenor_months", (p) => int(p.quote.tenorMonths)],
  ["x_calc_interest_rate_pa", (p) => num(p.quote.interestRatePa)],
  ["x_calc_monthly_amortization", (p) => num(p.quote.monthlyPayment)],
  ["x_calc_total_amount_due", (p) => num(p.quote.totalAmountDue)],
  ["x_calc_dst", (p) => num(p.quote.dst)],
  ["x_calc_total_amount_due_incl_dst", (p) => num(p.quote.totalAmountDueInclDst)],
  ["x_calc_system_kwp", (p) => num(p.system.systemKwp)],
  ["x_calc_panel_count", (p) => int(p.system.panelCount)],
  ["x_calc_battery_kwh", (p) => num(p.system.batteryKwh)],
  ["x_calc_inverters", (p) => str((p.system.inverters || []).join(", "), 256)],
  ["x_calc_agent_email", (p) => str(p.agent && p.agent.email, 128)],
];

// ─── Small coercers ──────────────────────────────────────────────────────────
function str(v, max) {
  if (v == null) return false;
  const s = String(v).trim();
  return s ? s.slice(0, max) : false;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
// Case-insensitive exact match for a LIKE pattern: `_` and `%` are wildcards.
function likeExact(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ─── Validation ──────────────────────────────────────────────────────────────
// Returns { error } or { leadId, proposal, boq }. Shapes are checked here so
// nothing downstream has to defend against a malformed browser payload.
function validateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object." };
  }
  const rawLead = String(body.leadId ?? "").trim();
  if (!LEAD_ID_RE.test(rawLead)) {
    return { error: "leadId must be a positive integer (the Odoo Project Number)." };
  }
  const p = body.proposal;
  if (!p || typeof p !== "object") return { error: "proposal is required." };
  if (!str(p.quoteRef, 64)) return { error: "proposal.quoteRef is required." };
  if (!toOdooDatetime(p.generatedAt)) return { error: "proposal.generatedAt must be a date." };
  if (!toOdooDateManila(p.validUntil)) return { error: "proposal.validUntil must be a date." };
  const quote = p.quote && typeof p.quote === "object" ? p.quote : {};
  const system = p.system && typeof p.system === "object" ? p.system : {};
  const agent = p.agent && typeof p.agent === "object" ? p.agent : {};
  const customer = p.customer && typeof p.customer === "object" ? p.customer : {};

  const rawBoq = Array.isArray(p.boq) ? p.boq : [];
  if (rawBoq.length > MAX_BOQ_ROWS) return { error: `proposal.boq has more than ${MAX_BOQ_ROWS} rows.` };
  const boq = [];
  for (const row of rawBoq) {
    if (!row || typeof row !== "object") continue;
    const pkg = String(row.package || "").trim().toUpperCase();
    const description = str(row.description, 500);
    if (!PACKAGES.has(pkg) || !description) continue;
    const quantity = Number(row.quantity);
    boq.push({
      package: pkg,
      product: str(row.product, 200) || false,
      description,
      quantity: Number.isFinite(quantity) && quantity >= 0 ? Math.round(quantity * 1000) / 1000 : 0,
      unit: str(row.unit, 16) || false,
    });
  }

  return {
    leadId: Number(rawLead),
    proposal: { ...p, quote, system, agent, customer },
    boq,
  };
}

// ─── Session ─────────────────────────────────────────────────────────────────
// verifySession() in parametersService returns only the user id; the
// salesperson mapping needs the email, so this resolves the user directly.
async function resolveCaller(accessToken) {
  if (!accessToken) return { status: 401, error: "Missing bearer token" };
  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (_) {
    return { status: 500, error: "Auth is not configured." };
  }
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data?.user) return { status: 401, error: "Invalid or expired session token" };
  return { userId: data.user.id, email: (data.user.email || "").trim().toLowerCase() };
}

// ─── Field availability (cached) ─────────────────────────────────────────────
// fields_get once per process per database; the custom fields only appear
// after the apply script runs, and a stale negative result self-heals on the
// next TTL expiry.
let fieldsCache = { key: "", at: 0, fields: null };
const FIELDS_TTL_MS = 10 * 60 * 1000;

async function fieldsAvailable(cfg, signal) {
  const key = `${cfg.url}|${cfg.db}`;
  if (fieldsCache.fields && fieldsCache.key === key && Date.now() - fieldsCache.at < FIELDS_TTL_MS) {
    return fieldsCache.fields;
  }
  const res = await executeKw(cfg, "sale.order", "fields_get", [], { attributes: ["type"] }, signal);
  const fields = new Set(Object.keys(res || {}));
  fieldsCache = { key, at: Date.now(), fields };
  return fields;
}

export function resetOdooQuotationCaches() {
  fieldsCache = { key: "", at: 0, fields: null };
}

// ─── Date arithmetic for the subscription end date ───────────────────────────
// Odoo's own automation does date_order + relativedelta(months=N), clamping to
// the end of the month. Mirror that on the Manila calendar date.
function addMonthsManila(value, months) {
  const ymd = toOdooDateManila(value);
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// ─── Public entry point ──────────────────────────────────────────────────────

export async function createQuotationFromProposal(body, accessToken, requestId = "") {
  const parsed = validateBody(body);
  if (parsed.error) return { status: 400, payload: { error: parsed.error } };
  const { leadId, proposal, boq } = parsed;

  const caller = await resolveCaller(accessToken);
  if (caller.error) return { status: caller.status, payload: { error: caller.error } };

  // WRITE PATH IS OPT-IN. The ODOO_* credential is shared with the read-only
  // lead lookup, and on 2026-09-25 the Render STAGING service turned out to
  // hold the PRODUCTION credential — a staging test created a quotation in
  // production. Creating quotations therefore requires an explicit
  // ODOO_QUOTATION_ENABLED=true on the server, set only where the credential
  // is known to point at the intended database.
  if (String(process.env.ODOO_QUOTATION_ENABLED || "").toLowerCase() !== "true") {
    console.warn("[odoo-quotation] push disabled (ODOO_QUOTATION_ENABLED is not 'true')", { requestId });
    return {
      status: 503,
      payload: {
        error: "Saving quotations to Odoo is switched off on this server.",
        code: "push_disabled",
      },
    };
  }

  const cfg = odooConfig();
  if (!cfg) {
    console.error("[odoo-quotation] odoo not configured", { requestId, missing: missingOdooEnv() });
    return {
      status: 503,
      payload: { error: "Odoo is not configured on the server.", code: "not_configured" },
    };
  }

  const signal = AbortSignal.timeout(odooTimeoutMs() * 2);
  const warnings = [];

  try {
    // 1. The lead — its partner is the quotation's customer.
    const leads = await searchRead(
      cfg,
      "crm.lead",
      [["id", "=", leadId], ["active", "in", [true, false]]],
      ["id", "name", "partner_id", "user_id", "team_id", "company_id"],
      signal,
      { limit: 1 },
    );
    if (!Array.isArray(leads) || leads.length === 0) {
      return { status: 404, payload: { error: "No lead found for that Project Number.", code: "lead_not_found" } };
    }
    const lead = leads[0];
    const partnerId = Array.isArray(lead.partner_id) ? lead.partner_id[0] : null;
    if (!partnerId) {
      // 0.17% of leads. A sale.order needs a partner and the product decision
      // is to never create or edit contacts from the calculator.
      return {
        status: 422,
        payload: {
          error: "The Odoo lead has no customer contact linked, so a quotation cannot be created. Link a contact on the opportunity in Odoo and generate again.",
          code: "lead_has_no_partner",
        },
      };
    }

    // 2. Salesperson: the signed-in calculator user, else the lead's own.
    let userId = null;
    let salespersonSource = "none";
    if (caller.email) {
      const users = await searchRead(
        cfg,
        "res.users",
        ["&", ["active", "=", true], "|", ["login", "=ilike", likeExact(caller.email)], ["email", "=ilike", likeExact(caller.email)]],
        ["id", "name"],
        signal,
        { limit: 1 },
      );
      if (Array.isArray(users) && users.length) {
        userId = users[0].id;
        salespersonSource = "calculator-user";
      }
    }
    if (!userId && Array.isArray(lead.user_id)) {
      userId = lead.user_id[0];
      salespersonSource = "lead";
      warnings.push(`No Odoo user matches ${caller.email || "the signed-in account"}; salesperson taken from the lead.`);
    }

    // 3. Payment term by tenor (0 = Direct Purchase), and the RTO plan.
    const tenor = int(proposal.quote.tenorMonths);
    const isDirect = tenor <= 0;
    const termName = isDirect ? "Direct Purchase" : `${tenor} Months`;
    const terms = await searchRead(
      cfg,
      "account.payment.term",
      [["name", "=ilike", likeExact(termName)]],
      ["id", "name"],
      signal,
      { limit: 1 },
    );
    const paymentTermId = Array.isArray(terms) && terms.length ? terms[0].id : null;
    if (!paymentTermId) warnings.push(`No Odoo payment term named "${termName}"; left unset.`);

    let planId = null;
    if (!isDirect) {
      const plans = await searchRead(
        cfg,
        "sale.subscription.plan",
        [["name", "=ilike", likeExact("Monthly Rent-to-Own")]],
        ["id", "name"],
        signal,
        { limit: 1 },
      );
      if (Array.isArray(plans) && plans.length) {
        planId = plans[0].id;
      } else {
        const monthly = await searchRead(
          cfg,
          "sale.subscription.plan",
          [["billing_period_value", "=", 1], ["billing_period_unit", "=", "month"]],
          ["id", "name"],
          signal,
          { limit: 1 },
        );
        if (Array.isArray(monthly) && monthly.length) planId = monthly[0].id;
        else warnings.push("No monthly subscription plan found in Odoo; recurring plan left unset.");
      }
    }

    // 4. Which custom fields exist on this database.
    const available = await fieldsAvailable(cfg, signal);
    const skipped = [];

    const vals = {
      partner_id: partnerId,
      opportunity_id: lead.id,
      origin: str(lead.name, 200) || false,
      date_order: toOdooDatetime(proposal.generatedAt),
      validity_date: toOdooDateManila(proposal.validUntil),
      client_order_ref: str(proposal.quoteRef, 64),
    };
    if (userId) vals.user_id = userId;
    if (Array.isArray(lead.team_id)) vals.team_id = lead.team_id[0];
    if (paymentTermId) vals.payment_term_id = paymentTermId;
    if (planId) {
      vals.plan_id = planId;
      const endDate = addMonthsManila(proposal.generatedAt, tenor);
      if (endDate) vals.end_date = endDate;
    }

    for (const [field, pick] of CALC_FIELD_MAP) {
      if (!available.has(field)) { skipped.push(field); continue; }
      const v = pick(proposal);
      if (v !== undefined) vals[field] = v;
    }

    if (available.has("x_boq_line_ids")) {
      // x_name IS the "Prod Description" column (it doubles as the row's
      // display name). Field set mirrors scripts/odoo/apply-dinuguan.mjs.
      vals.x_boq_line_ids = boq.map((row, i) => [0, 0, {
        x_name: row.description,
        x_sequence: (i + 1) * 10,
        x_package: PACKAGE_PRODUCT_NAMES[row.package] || row.package,
        x_product: row.product,
        x_quantity: row.quantity,
        x_unit: row.unit,
      }]);
    } else if (boq.length) {
      skipped.push("x_boq_line_ids");
    }
    if (skipped.length) {
      warnings.push(`Odoo fields not present on this database (run scripts/odoo/apply-dinuguan.mjs): ${skipped.join(", ")}.`);
    }

    // 5. Create the quotation.
    const orderId = await executeKw(cfg, "sale.order", "create", [vals], {}, signal);
    if (typeof orderId !== "number") throw new Error("sale.order create returned no id");
    const created = await executeKw(cfg, "sale.order", "read", [[orderId]], { fields: ["name"] }, signal);
    const orderName = Array.isArray(created) && created[0] ? created[0].name : String(orderId);

    // 6. Chatter note for traceability. Best effort — the quotation exists.
    try {
      const q = proposal.quote;
      const lines = [
        `Created from the Internal Calculator proposal <b>${escapeHtml(proposal.quoteRef)}</b> by ${escapeHtml(caller.email || "an unknown user")}.`,
        `Financing: ${escapeHtml(q.financingType || (isDirect ? "Direct Purchase" : "RTO"))}` +
          (isDirect ? "" : `, ${tenor} months at ${escapeHtml(String(q.interestRatePa ?? ""))} p.a.`),
        `Net price ₱${num(q.netPrice).toLocaleString("en-PH")}, down payment ₱${num(q.downPaymentAmount).toLocaleString("en-PH")}` +
          (isDirect ? "" : `, monthly ₱${num(q.monthlyPayment).toLocaleString("en-PH")}, total due ₱${num(q.totalAmountDueInclDst).toLocaleString("en-PH")}`) + ".",
        `Bill of Quantities rows: ${boq.length}.`,
      ];
      await executeKw(
        cfg,
        "sale.order",
        "message_post",
        [[orderId]],
        { body: lines.map((l) => `<p>${l}</p>`).join(""), message_type: "comment", subtype_xmlid: "mail.mt_note" },
        signal,
      );
    } catch (err) {
      warnings.push("Quotation created, but the chatter note could not be posted.");
      console.warn("[odoo-quotation] message_post failed", { requestId, orderId, reason: String(err && err.message).slice(0, 120) });
    }

    console.log("[odoo-quotation] created", {
      requestId, leadId, orderId, orderName, salespersonSource, boqRows: boq.length, skipped,
    });
    return {
      status: 201,
      payload: { orderId, orderName, leadId, salespersonSource, warnings },
    };
  } catch (err) {
    // Log the shape, never the customer data.
    console.error("[odoo-quotation] failed", {
      requestId, leadId, reason: String(err && err.message).slice(0, 160),
    });
    return {
      status: 502,
      payload: { error: "Odoo did not accept the quotation.", code: "odoo_unavailable" },
    };
  }
}
