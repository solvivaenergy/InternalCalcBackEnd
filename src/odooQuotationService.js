// =============================================================================
// ODOO QUOTATION SERVICE — create a quotation after a proposal PDF (064C/J/K)
// -----------------------------------------------------------------------------
// The calculator calls POST /api/odoo/quotation right after it saves a proposal
// PDF for a customer who was loaded from an Odoo lead. This service turns that
// proposal into a DRAFT sale.order on the lead's opportunity:
//
//   064C  customer (the lead's partner), quotation date, expiration, salesperson
//   064D  one order line per package (A / B / C products from 064G) at the
//         calculator's VAT-inclusive subtotal, the inclusions as the line
//         description, and a negative "Discount" line for a promo discount
//   064E  the calculator's financing figures (x_calc_* fields, added by
//         scripts/odoo/apply-dinuguan.mjs) so Odoo's bill schedule can anchor on
//         the calculator's own amortisation
//   064J  one Bill-of-Quantities row per package inclusion, with quantities
//   064K  written into the x_boq_line_ids table on the same create call
//   064F  the proposal PDF, attached to that quotation by a second call
//         (attachProposalPdf) with a chatter note
//   064S  a "D. Interest" line on RTO quotations and the Studio Financed
//         Amount field (net price less the down payment)
//   SOLSB-23  Create Mode = Automatic (Studio field x_studio_create_mode)
//   Payment Scheme section (Studio): Payment Scheme + Mode from the financing;
//         the Recurring Plan is never set from here (user decision 2026-10-01)
//
// VAT: the calculator prices everything VAT-inclusive. The package products
// carry the price-included "12%" sale tax (account.tax 3 on both builds), so
// the subtotal goes in as price_unit unchanged and Odoo backs the VAT out. The
// discount line gets the same taxes explicitly so the VAT is taken on the
// discounted price, which is what the calculator does.
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
const MAX_ORDER_LINES = 10;
const MAX_INCLUSIONS_PER_LINE = 80;
const PACKAGES = new Set(["A", "B", "C"]);

// Product names as created by scripts/odoo/apply-dinuguan.mjs (story 064G).
// Exported so the apply script and this service cannot drift apart.
export const PACKAGE_PRODUCT_NAMES = {
  A: "A. Solar Package",
  B: "B. Battery Package",
  C: "C. Misc. Materials, Labor, Services & Other Adjustments",
  // 064S — the interest line of an RTO quotation (AssetCo's revenue).
  D: "D. Interest",
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
  // Percentages are stored as PERCENT (30, not 0.30 — user decision
  // 2026-10-02); the calculator sends fractions.
  ["x_calc_downpayment_pct", (p) => asPercent(p.quote.downPaymentPct)],
  ["x_calc_downpayment_amount", (p) => num(p.quote.downPaymentAmount)],
  ["x_calc_tenor_months", (p) => int(p.quote.tenorMonths)],
  ["x_calc_interest_rate_pa", (p) => asPercent(p.quote.interestRatePa)],
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
// A rate the calculator sends as a fraction (0.3) becomes a percent (30);
// a value above 1 is taken to be a percent already. Two decimals.
function asPercent(v) {
  const n = num(v);
  if (n <= 0) return 0;
  return Math.round((n <= 1 ? n * 100 : n) * 100) / 100;
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
// Returns { error } or { leadId, proposal, boq, orderLines }. Shapes are
// checked here so nothing downstream has to defend against a malformed
// browser payload. Exported (as validateQuotationBody) for unit checks.
export function validateQuotationBody(body) {
  return validateBody(body);
}

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

  // 064D — one entry per package from the calculator's Summary. A row with an
  // unknown package letter is dropped; a non-numeric amount becomes 0 (the
  // line still carries its inclusions, and ₱0 is visible rather than hidden).
  const rawLines = Array.isArray(p.orderLines) ? p.orderLines : [];
  if (rawLines.length > MAX_ORDER_LINES) return { error: `proposal.orderLines has more than ${MAX_ORDER_LINES} rows.` };
  const orderLines = [];
  const seen = new Set();
  for (const row of rawLines) {
    if (!row || typeof row !== "object") continue;
    const pkg = String(row.package || "").trim().toUpperCase();
    if (!PACKAGES.has(pkg) || seen.has(pkg)) continue;
    seen.add(pkg);
    const amount = Number(row.amount);
    const inclusions = (Array.isArray(row.inclusions) ? row.inclusions : [])
      .map((s) => str(s, 500))
      .filter(Boolean)
      .slice(0, MAX_INCLUSIONS_PER_LINE);
    orderLines.push({
      package: pkg,
      inclusions,
      amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0,
    });
  }

  return {
    leadId: Number(rawLead),
    proposal: { ...p, quote, system, agent, customer },
    boq,
    orderLines,
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
// next TTL expiry. The cache keeps the selection keys too, so a Studio radio
// is only written with a value the database actually offers.
let fieldsCache = { key: "", at: 0, fields: null, meta: null, ttl: 0 };
const FIELDS_TTL_MS = 10 * 60 * 1000;
// A NEGATIVE answer (custom fields absent) is cached only briefly: the apply
// script may run at any moment, and on 2026-09-25 the staging service kept
// reporting the fields missing for minutes after they existed.
const FIELDS_MISSING_TTL_MS = 30 * 1000;

async function fieldsAvailable(cfg, signal) {
  const key = `${cfg.url}|${cfg.db}`;
  if (!(fieldsCache.fields && fieldsCache.key === key && Date.now() - fieldsCache.at < fieldsCache.ttl)) {
    const res = await executeKw(cfg, "sale.order", "fields_get", [], { attributes: ["type", "selection"] }, signal);
    const fields = new Set(Object.keys(res || {}));
    const complete = fields.has("x_boq_line_ids") && CALC_FIELD_MAP.every(([f]) => fields.has(f));
    fieldsCache = { key, at: Date.now(), fields, meta: res || {}, ttl: complete ? FIELDS_TTL_MS : FIELDS_MISSING_TTL_MS };
  }
  const { fields, meta } = fieldsCache;
  return {
    has: (name) => fields.has(name),
    // The selection keys of a selection field, or null when the field is
    // absent or not a selection.
    selectionKeys: (name) => {
      const f = meta[name];
      return f && Array.isArray(f.selection) ? f.selection.map((pair) => pair[0]) : null;
    },
  };
}

// Pure: the Studio "Payment Scheme" section from the calculator's financing
// (user decision 2026-10-01: fill this section, never the Recurring Plan).
//   Payment Scheme  direct | rto           from the tenor (0 = Direct Purchase)
//   Mode            straight               Direct Purchase
//                   downpayment | nodown   RTO, by whether a down payment is set
// Returns [field, value] pairs; the caller writes only those whose key the
// database offers. Exported for unit checks.
export function paymentSchemeValues({ tenorMonths, downPaymentPct }) {
  const isDirect = int(tenorMonths) <= 0;
  return [
    ["x_studio_payment_scheme", isDirect ? "direct" : "rto"],
    ["x_studio_mode", isDirect ? "straight" : (num(downPaymentPct) > 0 ? "downpayment" : "nodown")],
  ];
}

// Pure: the Studio financing figures the form shows outside the calculator
// tab (user decisions 2026-10-02):
//   Downpayment group   x_studio_percentage   down payment as PERCENT (30)
//                       x_studio_down_amount  down payment in pesos
//   Payment Scheme      x_studio_tenor        months, RTO only
//   Summary             x_studio_financed_amount  net price − down payment,
//                                             RTO only (064S)
// Returns [field, value] pairs; the caller writes only fields the database
// has. Exported for unit checks.
export function studioFinancingValues({ tenorMonths, downPaymentPct, downPaymentAmount, netPrice, amountFinanced } = {}) {
  const tenor = int(tenorMonths);
  const isDirect = tenor <= 0;
  const pct = asPercent(downPaymentPct);
  const dpAmount = num(downPaymentAmount);
  const out = [];
  if (pct > 0) out.push(["x_studio_percentage", pct]);
  if (dpAmount > 0) out.push(["x_studio_down_amount", dpAmount]);
  if (!isDirect) {
    out.push(["x_studio_tenor", tenor]);
    const financed = amountFinanced != null ? num(amountFinanced) : num(netPrice) - dpAmount;
    if (financed > 0) out.push(["x_studio_financed_amount", financed]);
  }
  return out;
}

// ─── Package products (cached) ───────────────────────────────────────────────
// product.product ids (and sale taxes) of the three package products from
// story 064G, plus the company's discount product, resolved once per process
// per database. As with the fields, an incomplete answer is cached only
// briefly so a product created later is picked up without a restart.
let productsCache = { key: "", at: 0, value: null, ttl: 0 };

async function packageProducts(cfg, companyId, signal) {
  const key = `${cfg.url}|${cfg.db}|${companyId}`;
  if (productsCache.value && productsCache.key === key && Date.now() - productsCache.at < productsCache.ttl) {
    return productsCache.value;
  }
  const names = Object.values(PACKAGE_PRODUCT_NAMES);
  const rows = await searchRead(
    cfg,
    "product.product",
    [["name", "in", names], ["sale_ok", "=", true]],
    ["id", "name", "display_name", "taxes_id"],
    signal,
    { limit: 20, order: "id asc" },
  );
  const byPackage = {};
  for (const [code, name] of Object.entries(PACKAGE_PRODUCT_NAMES)) {
    const hit = (rows || []).find((r) => r.name === name);
    if (hit) {
      byPackage[code] = {
        id: hit.id,
        name,
        // display_name carries the internal reference ("[IC-PKG-C] C. …"),
        // which is what Odoo itself puts on the first line of a hand-picked
        // product's description, so the list view folds it into the product.
        displayName: hit.display_name || name,
        taxIds: Array.isArray(hit.taxes_id) ? hit.taxes_id : [],
      };
    }
  }
  const companies = await searchRead(
    cfg,
    "res.company",
    [["id", "=", companyId]],
    ["sale_discount_product_id"],
    signal,
    { limit: 1 },
  );
  const discount = companies && companies[0] && Array.isArray(companies[0].sale_discount_product_id)
    ? companies[0].sale_discount_product_id[0]
    : null;
  const value = { byPackage, discountProductId: discount };
  const complete = Object.keys(byPackage).length === names.length && !!discount;
  productsCache = { key, at: Date.now(), value, ttl: complete ? FIELDS_TTL_MS : FIELDS_MISSING_TTL_MS };
  return value;
}

// Pure: split a peso discount across the packages in proportion to their
// gross amounts (064D criterion 4 — "applied at a package level"). Parts are
// rounded to centavos and the rounding residual lands on the largest package,
// so the parts always add up to the discount exactly. Exported for checks.
export function allocateDiscount(discount, amounts) {
  const gross = (amounts || []).map((a) => Math.max(0, num(a)));
  const total = gross.reduce((s, a) => s + a, 0);
  const d = Math.abs(num(discount));
  if (!(d > 0) || !(total > 0)) return gross.map(() => 0);
  const parts = gross.map((a) => Math.round(((d * a) / total) * 100) / 100);
  const residual = Math.round((d - parts.reduce((s, p) => s + p, 0)) * 100) / 100;
  if (residual !== 0) {
    const largest = gross.reduce((best, a, i) => (a > gross[best] ? i : best), 0);
    parts[largest] = Math.round((parts[largest] + residual) * 100) / 100;
  }
  return parts;
}

function peso(n) {
  return `₱${num(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Pure: the (0, 0, vals) commands for sale.order.order_line. Exported for
// unit checks. `products` is packageProducts().byPackage; a package whose
// product is missing is skipped and named in `skipped`. The shape, per the
// 064D / 064S criteria (tracker, 2026-10-01):
//   • one line per package at its VAT-INCLUSIVE gross subtotal — name = the
//     Odoo product display name on the first line, then the inclusions, the
//     same text Odoo composes when a rep picks the product by hand;
//   • a promo discount (quote.discountAmount, the engine's AH6, ≤ 0) becomes
//     one negative "Discount" line PER PACKAGE, right under it, with the
//     package's share (allocateDiscount) and the package line's taxes, so
//     each package shows Gross, Discount and Net and the order total is the
//     calculator's net price;
//   • RTO only: a "D. Interest" line (quote.interestAmount = Total Amount Due
//     − net price, the engine's AH19) after the packages, so Finance sees the
//     principal and the interest revenue apart. Absent product → skipped.
export function buildOrderLineCommands({ orderLines, products, discountAmount, promoCode, discountProductId, quote }) {
  const commands = [];
  const skipped = [];
  const lines = [];
  for (const line of orderLines || []) {
    if (products && products[line.package]) lines.push(line);
    else skipped.push(PACKAGE_PRODUCT_NAMES[line.package] || line.package);
  }
  const code = str(promoCode, 64);
  const shares = allocateDiscount(discountAmount, lines.map((l) => l.amount));
  let sequence = 10;
  lines.forEach((line, i) => {
    const product = products[line.package];
    commands.push([0, 0, {
      sequence,
      product_id: product.id,
      name: [product.displayName || product.name, ...(line.inclusions || [])].join("\n"),
      product_uom_qty: 1,
      price_unit: num(line.amount),
    }]);
    sequence += 10;
    if (shares[i] > 0) {
      if (!discountProductId) {
        if (!skipped.includes("Discount")) skipped.push("Discount");
        return;
      }
      commands.push([0, 0, {
        sequence,
        product_id: discountProductId,
        name: `Discount\n${product.name}${code ? ` — promo code ${code}` : ""}`,
        product_uom_qty: 1,
        price_unit: -shares[i],
        tax_id: [[6, 0, product.taxIds || []]],
      }]);
      sequence += 10;
    }
  });

  const q = quote || {};
  const tenor = int(q.tenorMonths);
  const interest = q.interestAmount != null
    ? num(q.interestAmount)
    : Math.max(0, num(q.totalAmountDue) - num(q.netPrice));
  if (lines.length && tenor > 0 && interest > 0) {
    const product = products && products.D;
    if (!product) {
      skipped.push(PACKAGE_PRODUCT_NAMES.D);
    } else {
      const financed = q.amountFinanced != null ? num(q.amountFinanced) : num(q.netPrice) - num(q.downPaymentAmount);
      const rateRaw = num(q.interestRatePa);
      const ratePct = rateRaw > 0 && rateRaw <= 1 ? rateRaw * 100 : rateRaw;
      commands.push([0, 0, {
        sequence,
        product_id: product.id,
        name: `${product.displayName || product.name}\nInterest on ${peso(financed)} financed over ${tenor} months at ${ratePct.toFixed(2)}% p.a.`,
        product_uom_qty: 1,
        price_unit: interest,
      }]);
      sequence += 10;
    }
  }
  return { commands, skipped };
}

export function resetOdooQuotationCaches() {
  fieldsCache = { key: "", at: 0, fields: null, meta: null, ttl: 0 };
  productsCache = { key: "", at: 0, value: null, ttl: 0 };
}

// ─── Public entry point ──────────────────────────────────────────────────────

export async function createQuotationFromProposal(body, accessToken, requestId = "") {
  const parsed = validateBody(body);
  if (parsed.error) return { status: 400, payload: { error: parsed.error } };
  const { leadId, proposal, boq, orderLines } = parsed;

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

    // 3. Payment term by tenor (0 = Direct Purchase). The Recurring Plan and
    // end date are deliberately NOT set, even for RTO (user decision
    // 2026-10-01): the subscription plan is Finance's call in Odoo, and the
    // 064E automation still fills it when the payment term is changed on the
    // form. The calculator's financing goes to the Payment Scheme section
    // below instead.
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

    for (const [field, pick] of CALC_FIELD_MAP) {
      if (!available.has(field)) { skipped.push(field); continue; }
      const v = pick(proposal);
      if (v !== undefined) vals[field] = v;
    }

    // SOLSB-23 — a quotation the calculator creates is tagged Create Mode =
    // Automatic. x_studio_create_mode is a Studio selection (manual |
    // automatic) that already exists on both builds and defaults to manual;
    // it is not one of the fields the apply script owns, so its absence gets
    // its own warning rather than the "run the apply script" one.
    if (available.has("x_studio_create_mode")) {
      vals.x_studio_create_mode = "automatic";
    } else {
      warnings.push("Odoo has no Create Mode field (x_studio_create_mode); the quotation was left as Manual.");
    }

    // Payment Scheme section (Studio radios). Each value is written only when
    // the database offers that key, so a renamed option degrades to a
    // warning instead of a failed create.
    for (const [field, value] of paymentSchemeValues(proposal.quote)) {
      const keys = available.selectionKeys(field);
      if (keys && keys.includes(value)) vals[field] = value;
      else warnings.push(`Odoo field ${field} is missing or has no "${value}" option; left at its default.`);
    }

    // Downpayment group, Tenor and Financed Amount (Studio) from the
    // calculator's financing — see studioFinancingValues.
    const missingStudio = [];
    for (const [field, value] of studioFinancingValues(proposal.quote)) {
      if (available.has(field)) vals[field] = value;
      else missingStudio.push(field);
    }
    if (missingStudio.length) {
      warnings.push(`Odoo has no ${missingStudio.join(", ")} field(s); left unset.`);
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

    // 4b. 064D — order lines on the package products. A missing product skips
    // its line and is reported; the quotation is still created.
    let orderLineCount = 0;
    if (orderLines.length) {
      const companyId = Array.isArray(lead.company_id) ? lead.company_id[0] : 1;
      const products = await packageProducts(cfg, companyId, signal);
      const built = buildOrderLineCommands({
        orderLines,
        products: products.byPackage,
        discountAmount: proposal.quote.discountAmount,
        promoCode: proposal.quote.promoCode,
        discountProductId: products.discountProductId,
        quote: proposal.quote,
      });
      if (built.commands.length) vals.order_line = built.commands;
      orderLineCount = built.commands.length;
      if (built.skipped.length) {
        warnings.push(`Odoo products not found, so these order lines were skipped: ${built.skipped.join(", ")}.`);
      }
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
          (isDirect ? "" : `, ${tenor} months at ${asPercent(q.interestRatePa).toFixed(2)}% p.a., ${asPercent(q.downPaymentPct).toFixed(0)}% down`),
        `Net price ₱${num(q.netPrice).toLocaleString("en-PH")}, down payment ₱${num(q.downPaymentAmount).toLocaleString("en-PH")}` +
          (isDirect ? "" : `, monthly ₱${num(q.monthlyPayment).toLocaleString("en-PH")}, total due ₱${num(q.totalAmountDueInclDst).toLocaleString("en-PH")}`) + ".",
        `Order lines: ${orderLineCount}. Bill of Quantities rows: ${boq.length}.`,
      ];
      // Odoo 18 escapes `body` unless body_is_html is set (a plain string is
      // never trusted as markup over RPC). Without it the note shows literal
      // "&lt;p&gt;" tags — seen on the staging quotation S00066.
      await executeKw(
        cfg,
        "sale.order",
        "message_post",
        [[orderId]],
        { body: lines.map((l) => `<p>${l}</p>`).join(""), body_is_html: true, message_type: "comment", subtype_xmlid: "mail.mt_note" },
        signal,
      );
    } catch (err) {
      warnings.push("Quotation created, but the chatter note could not be posted.");
      console.warn("[odoo-quotation] message_post failed", { requestId, orderId, reason: String(err && err.message).slice(0, 120) });
    }

    console.log("[odoo-quotation] created", {
      requestId, leadId, orderId, orderName, salespersonSource, orderLines: orderLineCount, boqRows: boq.length, skipped,
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

// ─── 064F — attach the proposal PDF to the quotation ─────────────────────────
// Second call from the calculator, right after the quotation is created: the
// PDF bytes travel as a raw application/pdf body (the JSON limit does not
// apply), and land as an ir.attachment on the sale.order plus a chatter note
// carrying it, which is where the "Logs" column of the test cases looks.
// The order must carry the proposal reference the caller names, so a PDF can
// only be attached to the quotation its own generation created. Same gate
// and session rules as the create call; never throws.
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export async function attachProposalPdf({ orderId, quoteRef, fileName, pdf }, accessToken, requestId = "") {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return { status: 400, payload: { error: "orderId must be a positive integer." } };
  const ref = str(quoteRef, 64);
  if (!ref) return { status: 400, payload: { error: "quoteRef is required." } };
  if (!Buffer.isBuffer(pdf) || pdf.length < 8 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { status: 400, payload: { error: "Body must be a PDF (Content-Type application/pdf)." } };
  }
  if (pdf.length > MAX_PDF_BYTES) return { status: 413, payload: { error: "PDF larger than 25 MB." } };

  const caller = await resolveCaller(accessToken);
  if (caller.error) return { status: caller.status, payload: { error: caller.error } };
  if (String(process.env.ODOO_QUOTATION_ENABLED || "").toLowerCase() !== "true") {
    return { status: 503, payload: { error: "Saving quotations to Odoo is switched off on this server.", code: "push_disabled" } };
  }
  const cfg = odooConfig();
  if (!cfg) return { status: 503, payload: { error: "Odoo is not configured on the server.", code: "not_configured" } };

  // Base64 of a multi-megabyte PDF takes longer than a field read.
  const signal = AbortSignal.timeout(odooTimeoutMs() * 4);
  const warnings = [];
  try {
    const orders = await searchRead(cfg, "sale.order", [["id", "=", id]], ["name", "client_order_ref"], signal, { limit: 1 });
    if (!Array.isArray(orders) || orders.length === 0) {
      return { status: 404, payload: { error: "No quotation with that id.", code: "order_not_found" } };
    }
    if (String(orders[0].client_order_ref || "") !== ref) {
      return { status: 409, payload: { error: "The quotation does not carry this proposal reference, so the PDF was not attached.", code: "ref_mismatch" } };
    }
    const safeName = (str(fileName, 120) || `Solviva-Proposal-${ref}.pdf`).replace(/[^\w.\- ]+/g, "_");
    const attachmentId = await executeKw(cfg, "ir.attachment", "create", [{
      name: safeName,
      type: "binary",
      datas: pdf.toString("base64"),
      mimetype: "application/pdf",
      res_model: "sale.order",
      res_id: id,
    }], {}, signal);
    if (typeof attachmentId !== "number") throw new Error("ir.attachment create returned no id");
    try {
      await executeKw(
        cfg,
        "sale.order",
        "message_post",
        [[id]],
        {
          body: `<p>Proposal PDF <b>${escapeHtml(safeName)}</b> attached from the Internal Calculator by ${escapeHtml(caller.email || "an unknown user")}.</p>`,
          body_is_html: true,
          message_type: "comment",
          subtype_xmlid: "mail.mt_note",
          attachment_ids: [attachmentId],
        },
        signal,
      );
    } catch (err) {
      warnings.push("PDF attached, but the chatter note could not be posted.");
      console.warn("[odoo-quotation] pdf message_post failed", { requestId, orderId: id, reason: String(err && err.message).slice(0, 120) });
    }
    console.log("[odoo-quotation] pdf attached", { requestId, orderId: id, attachmentId, bytes: pdf.length });
    return { status: 201, payload: { attachmentId, orderName: orders[0].name, warnings } };
  } catch (err) {
    console.error("[odoo-quotation] pdf failed", { requestId, orderId: id, reason: String(err && err.message).slice(0, 160) });
    return { status: 502, payload: { error: "Odoo did not accept the PDF.", code: "odoo_unavailable" } };
  }
}
