// =============================================================================
// PROPOSAL PACKAGE — everything the proposal PDF prints, as data
// -----------------------------------------------------------------------------
// The Internal Calculator renders its proposal in the browser (jsPDF,
// InternalCalcFrontEnd src/lib/pdfGenerator.js) and, on generation, pushes a
// DRAFT quotation to Odoo (POST /api/odoo/quotation). This module produces the
// same content as structured JSON — cover figures, the system package in
// detail, payment options, the RA 3765 disclosure, the schedule of payments,
// savings and returns, warranties, the T&Cs with their validity tokens filled
// in, the disclaimers — so a Claude conversation can gather the inputs from a
// rep and write the proposal up. It also returns the exact Odoo payload the
// calculator would send (odooPayload), for reference: this server never
// writes to Odoo; a rep pushes the quotation from the calculator itself.
//
// Customer-facing by construction: the cost columns of the internal
// projection are not copied here.
// =============================================================================

import { DISCLAIMERS, PROPOSAL_CONTENT } from "@solviva/calc-engine/data/adminParams.js";
import { ADMIN_PARAMS, buildOrderLines } from "./engine.js";
import { boq } from "@solviva/calc-engine";
import { round2 } from "./util.js";

// The PDF's reference number (pdfGenerator.js makeQuoteRef, same hash as
// lead.js makeLeadRef): SV-<year>-<4 digits> from the customer name and the
// day of year — deterministic, so re-running the same proposal on the same
// day yields the same reference.
export function makeQuoteRef(generatedDate, contact) {
  const name = (contact?.name || "X").toLowerCase();
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  const dayOfYear = Math.floor(
    (generatedDate - new Date(generatedDate.getFullYear(), 0, 0)) / 86400000,
  );
  const suffix = String(Math.abs(h ^ dayOfYear) % 10000).padStart(4, "0");
  return `SV-${generatedDate.getFullYear()}-${suffix}`;
}

const fmtDate = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", year: "numeric", month: "long", day: "numeric" });

function substituteTokens(value, map) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in map ? String(map[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => substituteTokens(v, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteTokens(v, map)]));
  }
  return value;
}

const inverterLabels = (arr) => (arr || []).filter(Boolean).map((inv) => (inv.ratedKw != null ? `${inv.ratedKw} kW` : "Inverter"));

// The frontend's buildOdooQuotationPayload (src/lib/odooQuotation.js), so the
// shape here is what POST /api/odoo/quotation accepts.
export function buildOdooPayload({ state, model, contact, agent, issuedAt, validUntil, quoteRef, leadId }) {
  const terms = model?.terms || {};
  const tenor = Number(state?.tenor) || 0;
  const isDirect = tenor <= 0;
  const rows = boq.buildBoqLines({ model, state });
  const orderLines = buildOrderLines({ model, state });
  return {
    leadId: leadId ?? null,
    // v3-231 — the region whose parameters priced the proposal. The connector
    // reads the legacy (Luzon) row, so this is always Luzon here for now.
    region: "luzon",
    proposal: {
      quoteRef,
      generatedAt: issuedAt.toISOString(),
      validUntil: validUntil.toISOString(),
      customer: {
        name: contact?.name || "",
        email: contact?.email || "",
        mobile: contact?.mobile || "",
        installAddress: contact?.installAddress || "",
      },
      agent: { name: agent?.name || "", email: agent?.email || "", phone: agent?.phone || "" },
      system: {
        panelCount: model?.panelCount ?? 0,
        systemKwp: round2(model?.systemKwp),
        batteryKwh: model?.batteryKwh ?? 0,
        batteryPackage: model?.activeBatteryPackage?.label || null,
        inverters: inverterLabels(model?.effectiveInverters),
        phase: state?.phase === "three" ? "3-phase" : "single-phase",
        roofMaterial: state?.roofMaterial || null,
        rsdIncluded: !!state?.rsdEnabled,
        netMetering: !!state?.netMeteringEnabled,
      },
      quote: {
        financingType: isDirect ? "Direct Purchase" : "RTO",
        netPrice: round2(terms.netDirectPrice),
        discountAmount: round2(terms.discountAmount ?? 0),
        promoCode: state?.promoCode || "",
        downPaymentPct: state?.downPaymentPct ?? null,
        downPaymentAmount: round2(terms.dpTotalCharge),
        tenorMonths: tenor,
        interestRatePa: isDirect ? 0 : (terms.rtoRate ?? null),
        monthlyPayment: isDirect ? 0 : round2(terms.customerMonthlyPmt),
        totalAmountDue: round2(terms.totalAmountDue),
        dst: round2(terms.dst ?? 0),
        totalAmountDueInclDst: round2(terms.summaryTotalDue ?? terms.totalAmountDue),
        interestAmount: isDirect ? 0 : round2(terms.totalInterest ?? 0),
        amountFinanced: isDirect ? 0 : round2(terms.amountForFinancing ?? 0),
      },
      orderLines,
      boq: rows.map((r) => ({
        package: r.package,
        product: r.product,
        description: odooProdDescription(r.description),
        quantity: r.quantity,
        unit: r.unit,
      })),
    },
  };
}

// Odoo's Bill of Quantities has its own Quantity/Unit columns, so a LEADING
// count is dropped from the description (frontend src/lib/boq.js, v3-222).
const LEADING_COUNT_RE = /^\s*\d+(?:[.,]\d+)?\s*(?:units?\/s|units?|pcs?|pieces?|lots?|m(?:eters?)?)\b\.?\s*(?:of\s+)?/i;
export function odooProdDescription(description) {
  const text = String(description ?? "").trim();
  const stripped = text.replace(LEADING_COUNT_RE, "").trim();
  return stripped || text;
}

export function buildProposal({ internal, model, state, customer = {}, agent = {}, generatedDate, leadId = null }) {
  const ap = ADMIN_PARAMS;
  const issuedAt = generatedDate;
  const validUntil = new Date(internal.validUntil);
  const quoteRef = makeQuoteRef(issuedAt, customer);
  const safeName = String(customer?.name || "Customer").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // The same three tokens pdfGenerator.js substitutes (T&C paragraphs and the
  // delivery note), from the same live parameters.
  const tokens = {
    QUOTE_VALIDITY_DAYS: internal.validityDays,
    VALID_UNTIL: fmtDate.format(validUntil),
    LUZON_FREE_KM: ap.luzonFreeTravelKm || 30,
    // engine 1.3.0 — the dispatch hub named in the Logistics clause.
    DELIVERY_HUB: ap.deliveryHubLabel || "Parañaque hub",
  };

  const packageDetail = ["A", "B", "C"]
    .map((letter) => {
      const lines = internal.lineItems.filter((l) => l.package === letter);
      if (!lines.length) return null;
      return {
        package: letter,
        label: internal.totals.packageLabels[letter],
        lines: lines.map((l) => ({ description: l.description, price: l.directPrice })),
        subtotal: internal.totals.byPackage[letter]?.directPrice ?? round2(lines.reduce((s, l) => s + l.directPrice, 0)),
      };
    })
    .filter(Boolean);

  return {
    reference: quoteRef,
    suggestedFileName: `Solviva-Proposal-${quoteRef}-${safeName}.pdf`,
    issuedAt: issuedAt.toISOString(),
    issuedAtManila: fmtDate.format(issuedAt),
    validUntil: validUntil.toISOString(),
    validUntilManila: fmtDate.format(validUntil),
    validityDays: internal.validityDays,
    engineVersion: internal.engineVersion,
    presentedTo: {
      name: customer.name || "",
      email: customer.email || "",
      mobile: customer.mobile || "",
      installAddress: customer.installAddress || "",
      odooLeadId: leadId,
    },
    presentedBy: { name: agent.name || "", email: agent.email || "", phone: agent.phone || "" },
    financingEntity: { name: ap.financingEntityName, isSeparateEntity: !!ap.financingEntityIsSeparate },
    consumption: internal.consumption,
    system: internal.system,
    packageDetail,
    zeroPriceInclusions: internal.zeroPriceInclusions,
    packageTotal: internal.pricing.packageTotal,
    promo: internal.pricing.promo,
    discountAmount: internal.pricing.discountAmount,
    netPrice: internal.pricing.netPrice,
    directPurchase: internal.pricing.directPurchase,
    selectedTerms: internal.pricing.selected,
    paymentOptions: internal.pricing.tenorTable,
    truthInLendingDisclosure: {
      law: "RA 3765 (Truth in Lending Act)",
      cashPrice: round2(model.terms?.disclosure?.cashPrice),
      downPayment: round2(model.terms?.disclosure?.downPayment),
      amountFinanced: round2(model.terms?.disclosure?.amountFinanced),
      financeCharge: round2(model.terms?.disclosure?.financeCharge),
      documentaryStampTax: round2(model.terms?.dst),
      totalPayable: round2(model.terms?.disclosure?.totalPayable),
      nominalAnnualRate: model.terms?.disclosure?.nominalAnnualRate,
      rateConvention: "per annum on the diminishing balance",
      monthlyPayment: round2(model.terms?.disclosure?.monthlyPayment),
      tenorMonths: model.terms?.disclosure?.tenor,
    },
    scheduleOfPayments: { installDate: internal.schedule.installDate, rows: internal.schedule.rows || internal.schedule.preview },
    savingsAndReturns: internal.savings,
    warranties: PROPOSAL_CONTENT.warranties,
    // engine 1.3.0 — blocks flagged requiresHub (the Logistics clause) are
    // dropped for a region with no dispatch hub, as pdfGenerator.js does.
    termsAndConditions: substituteTokens(
      PROPOSAL_CONTENT.termsAndConditions.filter((b) => !(b.requiresHub && ap.deliveryHubEnabled === false)),
      tokens,
    ),
    disclaimers: {
      irr: `${DISCLAIMERS.irrDisclaimerBefore}${DISCLAIMERS.irrDisclaimerHighlight}${DISCLAIMERS.irrDisclaimerAfter}`,
      irrHighlight: DISCLAIMERS.irrDisclaimerHighlight,
      cfei: DISCLAIMERS.cfeiDisclaimer,
      paybackNote: DISCLAIMERS.paybackNote,
      monthlySavingsNote: DISCLAIMERS.monthlySavingsNote,
      duTariffNote: DISCLAIMERS.duTariffNoteInflated,
      duTariffNoteContextPdf: DISCLAIMERS.duTariffNoteContextPdf,
    },
    notes: internal.notes,
    odooPayload: buildOdooPayload({ state, model, contact: customer, agent, issuedAt, validUntil, quoteRef, leadId }),
  };
}
