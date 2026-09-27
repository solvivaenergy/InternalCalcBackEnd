// =============================================================================
// CALCULATIONS — pure functions mirroring every formula in the Excel CALCULATOR
// -----------------------------------------------------------------------------
// All functions here are PURE: same inputs → same outputs, no side effects.
// The UI calls `computeQuote(state)` once whenever any input changes; the
// result is then displayed across the Calculator / Summary / Schedule tabs.
//
// Cell-reference comments map each block to the original Excel cell so you
// can trace any number back to its source.
// =============================================================================

import { DEVICES, DAY_START_HOUR } from "./data/devices.js";
import {
  PANEL_SETTINGS,
  INVERTERS_SINGLE_PHASE,
  INVERTERS_THREE_PHASE,
} from "./data/inventory.js";
import {
  INCLUDED_DC_CABLE_METERS,
  INCLUDED_AC_CABLE_METERS,
} from "./constants.js";
import {
  resolveBatteryPackage,
  normalizeCategory,
  racksNeeded,
  promoDiscountAmount,
} from "./data/adminParams.js";

// ─── Excel financial functions (PMT, PV) ──────────────────────────────────────
// These match Excel's behaviour including the optional `type` argument
// (0 = end of period, 1 = beginning of period). Excel's PMT and PV are
// negatively signed for cash outflows; we follow the convention used in the
// workbook where every PMT(...) call passes a NEGATIVE pv so the output is
// positive.

/**
 * Excel PMT(rate, nper, pv, fv=0, type=0)
 * Returns the periodic payment for a loan/annuity.
 */
export function PMT(rate, nper, pv, fv = 0, type = 0) {
  if (nper === 0) return 0;
  if (rate === 0) return -(pv + fv) / nper;
  const pvif = Math.pow(1 + rate, nper);
  let pmt = (-rate * (pv * pvif + fv)) / ((1 + rate * type) * (pvif - 1));
  return pmt;
}

/**
 * Excel PV(rate, nper, pmt, fv=0, type=0)
 * Returns the present value of an annuity.
 */
export function PV(rate, nper, pmt, fv = 0, type = 0) {
  if (rate === 0) return -(pmt * nper + fv);
  const pvif = Math.pow(1 + rate, nper);
  return -((pmt * (1 + rate * type) * (pvif - 1)) / rate + fv) / pvif;
}

/**
 * Excel NPER(rate, pmt, pv, fv=0, type=0)
 * Number of periods to pay off a loan / accumulate to fv.
 * Used for "Simple Payback Period" calculation.
 */
export function NPER(rate, pmt, pv, fv = 0, type = 0) {
  if (pmt === 0) return Infinity;
  if (rate === 0) return -(pv + fv) / pmt;
  const num = pmt * (1 + rate * type) - fv * rate;
  const den = pv * rate + pmt * (1 + rate * type);
  if (num / den <= 0) return Infinity; // payback never happens
  return Math.log(num / den) / Math.log(1 + rate);
}

/**
 * Excel IRR — Newton's method.
 * cashflows: array where cashflows[0] is the initial outflow (negative).
 * Returns the rate that makes the NPV zero. Returns null if no convergence.
 */
export function IRR(cashflows, guess = 0.1) {
  const MAX_ITER = 100;
  const TOL = 1e-7;
  let rate = guess;
  for (let i = 0; i < MAX_ITER; i++) {
    let npv = 0;
    let dnpv = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const v = 1 / Math.pow(1 + rate, t);
      npv += cashflows[t] * v;
      dnpv -= (t * cashflows[t] * v) / (1 + rate);
    }
    if (Math.abs(npv) < TOL) return rate;
    if (dnpv === 0) return null;
    const next = rate - npv / dnpv;
    if (Math.abs(next - rate) < TOL) return next;
    rate = next;
    if (rate < -0.99) rate = -0.99;
  }
  return null;
}

/**
 * Excel NPV(rate, cashflows...). Note: Excel's NPV does NOT include the
 * initial investment — the first value in the array is treated as occurring
 * at the END of period 1. We replicate that.
 */
export function NPV(rate, cashflows) {
  return cashflows.reduce(
    (acc, cf, i) => acc + cf / Math.pow(1 + rate, i + 1),
    0,
  );
}

// ═══ COGS → DIRECT PURCHASE PRICE (v3-83) ════════════════════════════════════
// Engineering (Anjon) now enters COGS (pre-VAT). Every direct purchase price in
// the app is DERIVED from it. Product owns the two levers.
//
//     DP Price = CEILING( COGS × (1+VAT) / (1 − GM) / ((1+VAT)(1 − MDR) − VAT) )
//
// WHY PRE-VAT COGS IS THE RIGHT BASE: under Philippine VAT, input VAT paid to
// suppliers is CREDITABLE against output VAT collected on sales — it is
// recovered, not spent, so it is not a cost. Marking up a VAT-inclusive cost
// would mark up money you get refunded, and then charge output VAT on top of it.
//
// WHY THE DENOMINATOR IS NOT SIMPLY (1 − MDR): the acquirer takes its cut of the
// VAT-INCLUSIVE amount the customer is charged, while the full output VAT is
// still remitted to the BIR. So per ₱1 of ex-VAT price, Solviva actually keeps
//     (1+VAT)(1 − MDR) − VAT  =  1.12 × 0.85 − 0.12  =  0.832
// not 0.85. Anjon's original sheet divided by 0.85, which quietly realised a
// 24.4% margin against a 26% target. This form realises the margin you set.
// (Not tax advice — confirmed with the user, who chose this over the sheet's.)
const VAT_RATE = 0.12; // Philippine VAT. A constant, not a param, by instruction.

// v3-145 — sign-aware companion to directFromCogs, for the ONE place negative
// COGS is a feature rather than bad input: the misc catalog's reversal/credit
// items. Negative costs price as the exact negative of their positive
// counterpart (see the v3-144 catalog loop note). Used by BOTH the engine's
// derive loop and the admin table cell so the two can never diverge again —
// v3-144 shipped with the engine handling the sign while the admin cell
// (calling directFromCogs directly) still displayed ₱0.
export function signedDirectFromCogs(cogs, adminParams, marginOverride) {
  const c = Number(cogs);
  return c < 0
    ? -directFromCogs(-c, adminParams, marginOverride)
    : directFromCogs(c, adminParams, marginOverride);
}

export function directFromCogs(cogs, adminParams, marginOverride) {
  // v3-84 — defensive. A missing adminParams used to throw, which took the ENTIRE
  // admin screen down (blank page) rather than showing one wrong number. A price
  // of ₱0 in an admin cell is visible and harmless; a ReferenceError is not.
  const ap = adminParams || {};
  // v3-92 — gross margin is now CAPACITY-DERIVED (a GENLINV curve over kWp).
  // Callers pricing a quote pass the resolved margin explicitly; with no override
  // the price is the ADMIN/REFERENCE price — grossMarginReference (v3-95: set
  // directly, default = the max anchor / ceiling), falling back to grossMarginMax.
  const gm =
    marginOverride ??
    ap.grossMarginReference ??
    ap.grossMarginMax ??
    ap.grossMargin ??
    0;
  const mdr = ap.merchantDiscountRate ?? 0;
  const c = Number(cogs);
  if (!Number.isFinite(c) || c <= 0) return 0;
  // Net retained per 1.00 of ex-VAT price, after the acquirer's cut and the VAT
  // remittance. Guarded: the server and client both refuse to save margins that
  // would drive this to zero or below, but a hand-edited blob must not divide by
  // zero and blank out every price in the app.
  const retained = (1 + VAT_RATE) * (1 - mdr) - VAT_RATE;
  if (!(retained > 0) || !(1 - gm > 0)) return 0;
  return Math.ceil((c * (1 + VAT_RATE)) / (1 - gm) / retained);
}

// v3-208 — BATTERY PACKAGE margin rides its OWN capacity axis: the quote's
// total battery kWh, not the solar array's kWp (production main, v3-149
// equivalent). A panel-light, battery-heavy order no longer inherits the
// small-system floor margin on its battery lines, and a big system no longer
// prices a small battery at the large-system ceiling. kWh is clamped to the
// anchor axis so the output is bounded in [min, max]. Anchors ship non-
// decreasing (Min ≤ Med ≤ Max — flat curves allowed); a degenerate axis falls
// back to the max anchor, the same defensive rule grossMarginCurve uses.
export function batteryMarginCurve(batteryKwh, adminParams) {
  const ap = adminParams || {};
  const x1 = ap.grossMarginBatteryMinKwh,
    x2 = ap.grossMarginBatteryMidKwh,
    x3 = ap.grossMarginBatteryMaxKwh,
    q1 = ap.grossMarginBatteryMin,
    q2 = ap.grossMarginBatteryMid,
    q3 = ap.grossMarginBatteryMax;
  const fb = Number.isFinite(q3)
    ? q3
    : Number.isFinite(ap.grossMargin)
      ? ap.grossMargin
      : 0;
  if (![x1, x2, x3, q1, q2, q3].every(Number.isFinite) || !(x1 < x2 && x2 < x3))
    return fb;
  // Flat margin (Min = Med = Max, e.g. a deliberate constant battery margin —
  // allowed by both validators): the GENLINV skew divides by (q2 − q1) = 0.
  // Short-circuit to the constant rather than degrading to NaN.
  if (q1 === q2 && q2 === q3) return q3;
  const kwh = Number.isFinite(batteryKwh) && batteryKwh > 0 ? batteryKwh : x3; // 0/absent → ceiling
  const x = Math.min(x3, Math.max(x1, kwh));
  const kN = Math.log(0.5) / Math.log((x2 - x1) / (x3 - x1));
  const u = Math.pow((x - x1) / (x3 - x1), kN);
  const p = 0.25 + 0.5 * u;
  const b = (q3 - q2) / (q2 - q1);
  const z = normSInv(p) / Z75;
  return Math.abs(b - 1) < 1e-9
    ? q2 + (q3 - q2) * z
    : q2 + ((q3 - q2) * (Math.pow(b, z) - 1)) / (b - 1);
}

// The exact inverse of directFromCogs(). Used ONLY to rescue a SKU that an admin
// added to a pre-v3-83 blob and that therefore has a stored price but no COGS,
// and no matching entry in the code defaults to copy one from. Back-solving keeps
// its price where it was instead of zeroing it out.
export function cogsFromDirect(directPrice, adminParams, marginOverride) {
  const ap = adminParams || {};
  const gm =
    marginOverride ??
    ap.grossMarginReference ??
    ap.grossMarginMax ??
    ap.grossMargin ??
    0;
  const mdr = ap.merchantDiscountRate ?? 0;
  const px = Number(directPrice);
  if (!Number.isFinite(px) || px <= 0) return 0;
  const retained = (1 + VAT_RATE) * (1 - mdr) - VAT_RATE;
  if (!(retained > 0) || !(1 - gm > 0)) return 0;
  return Math.round((px * (1 - gm) * retained) / (1 + VAT_RATE));
}

// Writes every derived price back onto the live objects. Called by paramsService
// on boot AND after any admin save, so nothing downstream in calculations.js has
// to know COGS exists — it still reads `mountingSupportFloorPrice`, `directPrice`,
// `batteryUnitPrice` etc. exactly as before. That is the whole point of doing it
// this way: the pricing engine is UNCHANGED.
export function deriveDirectPrices(
  ap,
  panelSettings,
  invertersSP,
  invertersTP,
  margin,
) {
  // v3-92 — `margin` is the basis to price at. Boot/admin pass the REFERENCE
  // margin (grossMarginReference); a per-quote re-price passes
  // the quote's capacity margin. Omitted → directFromCogs falls back to the
  // grossMarginMax ceiling.
  //
  // v3-191 — `margin` may now be a FUNCTION (componentId → margin), built by
  // buildMarginResolver(): the quote path prices each component group at ITS
  // OWN resolved margin. A scalar (or omitted) margin behaves exactly as
  // before — every key at that one margin — which is what boot still passes
  // (grossMarginReference), preserving the pre-v3-191 boot derivation
  // verbatim.
  const mFor = typeof margin === "function" ? margin : () => margin;
  const dAt = (c, id) => directFromCogs(c, ap, mFor(id));

  if (panelSettings?.singlePhase)
    panelSettings.singlePhase.panelDirectPrice = dAt(
      panelSettings.singlePhase.panelCogs,
      "A",
    );
  if (panelSettings?.threePhase)
    panelSettings.threePhase.panelDirectPrice = dAt(
      panelSettings.threePhase.panelCogs,
      "A",
    );
  for (const inv of invertersSP || []) inv.directPrice = dAt(inv.cogs, "I");
  for (const inv of invertersTP || []) inv.directPrice = dAt(inv.cogs, "J");

  // adminParams scalars — key: [its COGS field, its v3-191 component id].
  // 'PM' (preventive maintenance) is OUTSIDE the component scheme — the
  // resolver routes it to grossMarginReference; the scalar path is unaffected.
  const MAP = {
    mountingSupportFloorPrice: ["mountingSupportFloorCogs", "P"],
    additionalDcCablePerMeter: ["additionalDcCablePerMeterCogs", "D"],
    additionalAcCablePerMeter: ["additionalAcCablePerMeterCogs", "E"],
    laborInstallationPerKwp: ["laborInstallationPerKwpCogs", "F"],
    rsdVariablePerPanel: ["rsdVariablePerPanelCogs", "G"],
    rsdFixedTransmitter: ["rsdFixedTransmitterCogs", "H"],
    roofAsphaltPerKwp: ["roofAsphaltPerKwpCogs", "Q"],
    roofConcretePerKwp: ["roofConcretePerKwpCogs", "Q"],
    luzonOver30FixedFee: ["luzonOver30FixedFeeCogs", "M"],
    luzonOver30PerKm: ["luzonOver30PerKmCogs", "M"],
    rsdStandaloneLaborPerPanel: ["rsdStandaloneLaborPerPanelCogs", "N"],
    rsdStandaloneLaborMobilization: ["rsdStandaloneLaborMobilizationCogs", "N"],
    inverterStandaloneLaborPerUnit: ["inverterStandaloneLaborPerUnitCogs", "N"],
    inverterStandaloneMobilization: ["inverterStandaloneMobilizationCogs", "N"],
    fixedOverheadDeliveryLogistics: ["fixedOverheadDeliveryLogisticsCogs", "O"],
    fixedOverheadWarehouse: ["fixedOverheadWarehouseCogs", "O"],
    fixedOverheadCustoms: ["fixedOverheadCustomsCogs", "O"],
    fixedOverheadSafetySupervision: ["fixedOverheadSafetySupervisionCogs", "O"],
    fixedOverheadTesting: ["fixedOverheadTestingCogs", "O"],
    preventiveMaintenancePerPanel: ["preventiveMaintenancePerPanelCogs", "PM"],
    preventiveMaintenancePerVisit: ["preventiveMaintenancePerVisitCogs", "PM"],
  };
  for (const [priceKey, [cogsKey, compId]] of Object.entries(MAP)) {
    if (cogsKey in ap) ap[priceKey] = dAt(ap[cogsKey], compId);
  }

  // Battery packages — six derived prices each.
  const B = {
    batteryUnitPrice: "batteryUnitCogs",
    batteryRackPrice: "batteryRackCogs",
    atsPrice: "atsCogs",
    criticalLoadsMaterials: "criticalLoadsMaterialsCogs",
    laborWithSolarInstall: "laborWithSolarInstallCogs",
    standaloneLabor: "standaloneLaborCogs",
  };
  // v3-116 — delivery locations: two derived prices per row (was the four
  // cebu/siargao scalars in the map above).
  for (const loc of ap.deliveryLocations || []) {
    loc.fixedFee = dAt(loc.fixedFeeCogs, "M");
    loc.perPanel = dAt(loc.perPanelCogs, "M");
  }
  // v3-138 — misc catalog: one derived unit price per row. Written
  // unconditionally (v3-85 rationale) so a row whose COGS was edited never
  // keeps a stale price.
  // v3-144 — NEGATIVE COGS allowed here (reversal/credit items, e.g.
  // "REVERSAL: Battery Rack" when the standard package includes a rack the
  // site doesn't need). Priced sign-symmetrically: -d(-c), so a reversal
  // derives the EXACT negative of its positive counterpart at any margin and
  // the pair nets to zero to the centavo. directFromCogs keeps its own
  // c <= 0 → 0 guard for every other COGS field, where negatives are still
  // invalid input, not credits.
  for (const m of ap.miscCatalog || []) {
    // v3-191 — the whole catalog prices at the L component margin; reversals
    // keep their sign symmetry AT THAT MARGIN, so a reversal still nets to
    // zero against its counterpart to the centavo.
    m.price = signedDirectFromCogs(m.cogs, ap, mFor("L"));
  }
  for (const pkg of ap.batteryPackages || []) {
    for (const [priceKey, cogsKey] of Object.entries(B)) {
      // v3-85: was `if (cogsKey in pkg)` — which meant a COGS-less package (a
      // pre-v3-83 blob) silently KEPT its stale stored price while its COGS cell
      // rendered blank. Write unconditionally; backfillCogs() guarantees the COGS
      // is there by the time we get here.
      pkg[priceKey] = dAt(pkg[cogsKey], "K");
    }
  }
  return ap;
}

// ─── RTO INTEREST RATE SURFACE (v3-79) ───────────────────────────────────────
// Replaces the flat `effectiveRtoRate(panelCount)` (base rate + a 400bps
// small-package premium). The premium is GONE — panel count no longer affects
// the rate at all.
//
// The rate is now a function of tenor and down payment, fitted through three
// admin anchors using Myerson's generalized-lognormal quantile function — the
// same curve SimTools' GENLINV(p, q1, q2, q3) implements:
//
//     b = (q3 - q2) / (q2 - q1)                     the skew ratio
//     z = NORMSINV(p) / NORMSINV(0.75)
//     rate(p) = q2 + (q3 - q2) * (b^z - 1) / (b - 1)
//
// which reproduces q1, q2, q3 exactly at p = 0.25, 0.50, 0.75. GENLINV is
// one-dimensional, so the two axes are first collapsed into a single risk
// index u in [0,1], then mapped onto p = 0.25 + 0.50*u. That places the two
// corner anchors on the 25th and 75th percentiles and the mid anchor on the
// 50th — so every grid cell interpolates BETWEEN the anchors and none of them
// extrapolates into the distribution's tails.
//
//     uT  = ((T - 1) / (60 - 1)) ^ kT       1 at 60 mo,  0 at 1 mo
//     uDP = ((0.5 - DP) / 0.5)  ^ kD        1 at 0% DP,  0 at 50% DP
//     u   = w*uT + (1 - w)*uDP
//
// kT and kD are solved so the MID anchor's cell lands exactly on u = 0.5.
// kD works out to 1 (25% is the midpoint of 0–50%); kT is a hair under 1
// because 30 months is not quite the midpoint of 1–60.
//
// The weight w cannot disturb the anchors: at each of them uT and uDP agree,
// so any blend of them returns the same value. It reshapes only the interior.

// The 0-point of the surface's DP axis. NOTE (v3-82): the SELECTABLE down
// payment now runs to 100%, but the RATE AXIS deliberately still ends here.
// Down payments above 50% are CLAMPED to the 50% rate — i.e. 50% down already
// earns the best rate on the card, and putting down more earns no further
// discount. That is intentional: re-anchoring the axis to 0–100% would have
// silently repriced every existing quote (50%/60mo would jump 12.750% → 13.750%).
// It also barely matters — at 75% down you are financing a quarter of the
// system, so the rate is doing very little work. Change this to 1.0 only if you
// also intend to re-tune the anchors.
const DP_AXIS_MAX = 0.5;
// v3-99 — restored to 1, matching Solviva_Calc_v_B_5_1.xlsm's rate surface,
// whose tenor axis spans 1..60 (PRODUCT!D54=1, D55=60; normalization
// (tenor−1)/59, kT=0.9759…). v3-97 had narrowed this to 2 while the app was on
// the v4.8 curve; that skewed every interior interpolation vs v5.1.
// v3-100 — Direct Purchase is now TENOR 0 (a distinct option, mirroring v5.1's
// "Direct Purch" column via the AG12 sentinel); the numeric tenor 1 is a real
// interest-bearing 1-month term priced by this axis's endpoint (the N-column).
const TENOR_AXIS_MIN = 1;
const TENOR_AXIS_MAX = 60;
const ANCHOR_MID_TENOR = 30;
const ANCHOR_MID_DP = 0.25;

// Acklam's inverse normal CDF. Accurate to ~1e-9 — far beyond what a rate card
// snapped to 1/8 of a point could ever need.
function normSInv(p) {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269,
    -30.66479806614716, 2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= 1 - pLow) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

const Z75 = normSInv(0.75); // 0.6744897…

// The rate a customer actually pays, given their tenor and down payment.
// Tenor is clamped to [1,60] and DP to [0,0.5] so an out-of-range value can
// never push the curve outside its anchors.
export function rtoRate(tenor, downPaymentPct, adminParams) {
  // v3-100 — DIRECT PURCHASE IS TENOR 0, NOT TENOR 1. v5.1's tenor axis is
  // 60…2, 1, "Direct Purch": the numeric 1-month term is a REAL financed month
  // priced by the curve's N-column (21.75% at 0% DP → 16.0% at 50%), while
  // "Direct Purch" is its own distinct 0%-interest option. The app mirrors the
  // AG12 sentinel with tenor 0. Returned before the surface so an interior
  // curve rate can never leak onto a Direct Purchase; PMT is bypassed entirely
  // for tenor 0 in computePaymentTerms (single balance payment, AH15's IFERROR
  // fallback to AH10).
  if (tenor < 1) return 0;

  const q1 = adminParams.rateAnchorMin;
  const q2 = adminParams.rateAnchorMid;
  const q3 = adminParams.rateAnchorMax;
  const w = adminParams.rateTenorWeight;
  const step = adminParams.rateStepPct;

  const T = Math.min(TENOR_AXIS_MAX, Math.max(TENOR_AXIS_MIN, tenor));
  const DP = Math.min(DP_AXIS_MAX, Math.max(0, downPaymentPct));

  const kT =
    Math.log(0.5) /
    Math.log(
      (ANCHOR_MID_TENOR - TENOR_AXIS_MIN) / (TENOR_AXIS_MAX - TENOR_AXIS_MIN),
    );
  const kD =
    Math.log(0.5) / Math.log((DP_AXIS_MAX - ANCHOR_MID_DP) / DP_AXIS_MAX);

  const uT = Math.pow(
    (T - TENOR_AXIS_MIN) / (TENOR_AXIS_MAX - TENOR_AXIS_MIN),
    kT,
  );
  const uD = Math.pow((DP_AXIS_MAX - DP) / DP_AXIS_MAX, kD);
  const p = 0.25 + 0.5 * (w * uT + (1 - w) * uD);

  const b = (q3 - q2) / (q2 - q1);
  let raw;
  if (Math.abs(b - 1) < 1e-9) {
    // Symmetric anchors — the generalized-lognormal degenerates to a normal.
    // Without this branch the (b - 1) denominator below divides by zero.
    raw = q2 + ((q3 - q1) / (2 * Z75)) * normSInv(p);
  } else {
    raw = q2 + ((q3 - q2) * (Math.pow(b, normSInv(p) / Z75) - 1)) / (b - 1);
  }
  return step > 0 ? Math.round(raw / step) * step : raw;
}

// ─── GROSS MARGIN SURFACE (v3-92) ────────────────────────────────────────────
// Gross margin is no longer a flat scalar — it rides a GENLINV curve over the
// solar array's rated capacity (kWp), exactly like the RTO rate surface rides a
// curve over tenor/DP. Same generalized-lognormal quantile function (SimTools'
// GENLINV, native closed form). Three admin anchors, placed at the 25th / 50th /
// 75th percentiles so the two ends act as the true min/max and nothing
// extrapolates into the tails:
//   grossMarginMin @ grossMarginMinKwp   — 25th pctile (small systems, floor)
//   grossMarginMid @ grossMarginMidKwp   — 50th pctile (curvature)
//   grossMarginMax @ grossMarginMaxKwp   — 75th pctile (large systems, ceiling)
// kWp is clamped to [minKwp, maxKwp], so the output is bounded in [min, max].
// Mirrors PRODUCT!D10:D22 of Solviva_Calc_v_B_4_8.xlsm to the digit.
//
// v3-191 — PER-PHASE curves (user-directed, Pat): three-phase panels ride
// their own anchor set (the six `…Tp` keys). `phase` defaults to 'single' so
// every pre-v3-191 caller — and the workbook's single-anchor PRODUCT sheet —
// is preserved verbatim. A blob predating the split has no Tp keys; each Tp
// anchor falls back to its single-phase counterpart INDIVIDUALLY, so a
// partially hand-edited blob degrades to "same curve as single-phase" rather
// than to the degenerate-axis fallback. (paramsService also seeds the Tp keys
// from the blob's single-phase values on load — this fallback is the
// belt-and-braces second layer.)
export function grossMarginCurve(systemKwp, adminParams, phase = "single") {
  const ap = adminParams || {};
  const tp = phase === "three";
  const pick = (tpKey, spKey) => {
    const v = tp ? ap[tpKey] : undefined;
    return Number.isFinite(v) ? v : ap[spKey];
  };
  const x1 = pick("grossMarginMinKwpTp", "grossMarginMinKwp"),
    x2 = pick("grossMarginMidKwpTp", "grossMarginMidKwp"),
    x3 = pick("grossMarginMaxKwpTp", "grossMarginMaxKwp");
  const q1 = pick("grossMarginMinTp", "grossMarginMin"),
    q2 = pick("grossMarginMidTp", "grossMarginMid"),
    q3 = pick("grossMarginMaxTp", "grossMarginMax");
  // Defensive: a hand-edited blob with a degenerate axis must not throw.
  if (
    ![x1, x2, x3, q1, q2, q3].every(Number.isFinite) ||
    x3 <= x1 ||
    x2 <= x1 ||
    x2 >= x3
  ) {
    return Number.isFinite(q3)
      ? q3
      : Number.isFinite(ap.grossMargin)
        ? ap.grossMargin
        : 0;
  }
  const kwp = Number.isFinite(systemKwp) ? systemKwp : x3; // bad kWp → max anchor → q3
  const x = Math.min(x3, Math.max(x1, kwp));
  const kN = Math.log(0.5) / Math.log((x2 - x1) / (x3 - x1));
  const u = Math.pow((x - x1) / (x3 - x1), kN);
  const p = 0.25 + 0.5 * u;
  const b = (q3 - q2) / (q2 - q1);
  const z = normSInv(p) / Z75;
  return Math.abs(b - 1) < 1e-9
    ? q2 + (q3 - q2) * z
    : q2 + ((q3 - q2) * (Math.pow(b, z) - 1)) / (b - 1);
}

// The margin actually APPLIED to a quote. v4.6 rule (PRODUCT!D24):
//   IF(panelCount > 0, curve(kWp), maxMargin)
// An order with NO solar array — battery-only, RSD-only, inverter-only retrofit
// — defaults to the MAXIMUM margin (the ceiling), not the curve's value at 0 kWp.
//
// v3-176 — the rule GENERALIZES (user-directed, Pat): the curve applies only to
// a FULL solar system — panels AND an inverter. Any order missing either leg
// prices at the max margin. In practice the new case is the v3-175 panels-only
// EXPANSION, which had been riding the curve at the NEW panels' kWp (6 panels
// ≈ 3.78 kWp → near the 20% floor) — pricing an accessory-scale order at
// small-system margins. Zero-panel orders are unchanged (already max), and
// `hasInverter` DEFAULTS TRUE so pre-v3-176 callers and the workbook's D24
// behavior are preserved verbatim wherever the flag is not supplied. This is
// an app-side extension of D24's spirit (no full system → ceiling margin);
// the workbook has no expansion concept — noted on the deferred-sync list.
// v3-191 — panels-only orders no longer price at the hardwired max anchor:
// they price at a dedicated PER-PHASE parameter (user-directed, Pat — "the
// margin for panels-only will not follow the panels curve"). The curve applies
// ONLY when panels are purchased with at least one inverter. Zero-panel orders
// keep the max-anchor return for pre-v3-191 callers, but the quote engine no
// longer consumes that branch (each component resolves its own margin).
export function grossMarginNoInverter(adminParams, phase = "single") {
  const ap = adminParams || {};
  const v =
    phase === "three" ? ap.grossMarginNoInverterTp : ap.grossMarginNoInverterSp;
  return Number.isFinite(v) ? v : (ap.grossMarginMax ?? ap.grossMargin ?? 0);
}

export function grossMarginForCapacity(
  systemKwp,
  panelCount,
  adminParams,
  hasInverter = true,
  phase = "single",
) {
  const ap = adminParams || {};
  if (!(panelCount > 0)) return ap.grossMarginMax ?? ap.grossMargin ?? 0;
  if (!hasInverter) return grossMarginNoInverter(ap, phase);
  return grossMarginCurve(systemKwp, ap, phase);
}

// ─── v3-191 · PER-COMPONENT GROSS MARGINS ────────────────────────────────────
// Every priced component other than the panels carries its own margin setting
// in `adminParams.componentMargins` — one structured object (the
// deliveryLocations / miscCatalog / cablingTiers storage precedent), keyed by
// Pat's component letters:
//   B  Single-phase cabling bundle       C  Three-phase cabling bundle
//   D  Add'l DC cable                    E  Add'l AC cable
//   F  Labor & installation (per kWp)    G  RSD variable (per panel)
//   H  RSD fixed transmitter             I  Single-phase inverters
//   J  Three-phase inverters             L  Misc catalog (all rows)
//   M  Location / delivery (all rows + Luzon pair)
//   N  Standalone retrofit charges       O  Fixed overhead (all five lines)
//   P  Mounting support                  Q  Roof preparation
// Each entry: { mode: 'follow'|'fixed', fixed, otherwise } — except N, which
// only ever prices in NO-PANEL orders (standalone RSD labor, standalone-
// inverter mobilization), so its full-system branch is unreachable and it
// stores a single { otherwise } margin (decision D4, Pat).
//
// v3-208 — K (Battery Package) is OUT of this table: the battery rides its
// own kWh margin curve (batteryMarginCurve, grossMarginBattery* anchors),
// following the quote's battery kWh regardless of the solar order shape —
// the production-main rule. normalizeComponentMargins below iterates this
// list, so a persisted K entry is stripped on load; the first admin save
// after this deploy then drops it from the blob.
//
// THE RULE (confirmed verbatim, Pat): Follow-panels-curve and Fixed apply ONLY
// when the order contains BOTH panels AND at least one inverter ("full
// system"); `otherwise` applies in ALL other cases — panels without an
// inverter, inverter without panels, battery/RSD standalone. "Follow" rides
// the curve OF THE ORDER'S PHASE.
//
// Preventive maintenance stays entirely OUTSIDE this scheme (decision D1): its
// prices derive at grossMarginReference (the FinCo IRR/LCOE assumption), and
// the resolver id 'PM' below exists only so deriveDirectPrices can route those
// two keys away from the component table.
export const COMPONENT_MARGIN_IDS = [
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
];

const finOr = (v, fb) => (Number.isFinite(v) ? v : fb);

// Shape-hardening. Ensures componentMargins exists with every id, valid modes,
// and finite margins; missing values seed from the CURRENT grossMarginMax so a
// pre-v3-191 blob upgrades with bit-identical margin RESOLUTION (every
// component used to price at either the shared curve or the max anchor —
// mode 'follow' + otherwise = max reproduces exactly that). Mutates and
// returns ap.componentMargins. Exported for paramsService and the smoke
// harness.
export function normalizeComponentMargins(ap) {
  if (!ap || typeof ap !== "object") return {};
  const base = finOr(ap.grossMarginMax, finOr(ap.grossMargin, 0.3));
  const src =
    ap.componentMargins && typeof ap.componentMargins === "object"
      ? ap.componentMargins
      : {};
  const out = {};
  for (const id of COMPONENT_MARGIN_IDS) {
    const r = src[id] && typeof src[id] === "object" ? src[id] : {};
    out[id] =
      id === "N"
        ? { otherwise: finOr(r.otherwise, base) }
        : {
            mode: r.mode === "fixed" ? "fixed" : "follow",
            fixed: finOr(r.fixed, base),
            otherwise: finOr(r.otherwise, base),
          };
  }
  ap.componentMargins = out;
  return out;
}

// The margin a component prices at for a given order shape. `panelsMargin` is
// the resolved Solar Panels margin (curve or no-inverter param) — what
// 'follow' follows on a full system.
export function componentMarginFor(id, adminParams, fullSystem, panelsMargin) {
  const ap = adminParams || {};
  const base = finOr(ap.grossMarginMax, finOr(ap.grossMargin, 0.3));
  const r = (ap.componentMargins || {})[id] || {};
  if (id === "N") return finOr(r.otherwise, base);
  if (fullSystem) {
    return r.mode === "fixed"
      ? finOr(r.fixed, base)
      : finOr(panelsMargin, base);
  }
  return finOr(r.otherwise, base);
}

// Builds the per-component margin resolver for ONE order. Returned function
// maps a component id → margin; 'A' is the panels line itself, 'PM' the
// preventive-maintenance pair (reference margin, outside the scheme), and
// 'K' the battery package — which v3-208 routes to the battery kWh curve,
// ignoring fullSystem/panelsMargin entirely (the battery curve follows the
// order's battery kWh whatever the solar shape).
export function buildMarginResolver(
  adminParams,
  systemKwp,
  panelCount,
  hasInverter,
  phase,
  batteryKwh,
) {
  const ap = adminParams || {};
  const fullSystem = panelCount > 0 && !!hasInverter;
  const panelsMargin = !(panelCount > 0)
    ? null
    : fullSystem
      ? grossMarginCurve(systemKwp, ap, phase)
      : grossMarginNoInverter(ap, phase);
  const refMargin = finOr(
    ap.grossMarginReference,
    finOr(ap.grossMarginMax, finOr(ap.grossMargin, 0)),
  );
  return (id) => {
    if (id === "A") return finOr(panelsMargin, finOr(ap.grossMarginMax, 0));
    if (id === "PM") return refMargin;
    if (id === "K") return batteryMarginCurve(batteryKwh, ap);
    return componentMarginFor(id, ap, fullSystem, panelsMargin);
  };
}

// ─── Day vs Night kWh allocation ─────────────────────────────────────────────
// Excel CALCULATOR!A10:D16 (one row per device) computes how many
// hours/month each device runs in the DAY window (6 AM – 6 PM) vs the NIGHT
// window. The Excel formula is dense; here it is unpacked:
//
// Inputs per device row:
//   onTime  (0..1 fraction of day, e.g. 09:00 = 0.375)
//   offTime (0..1 fraction of day)
//   daysPerWeek
//   count   (how many of this device)
//   avgKw   (looked up from device library: peakKw * dutyFactor)
//
// The Excel uses a "shifted" frame where t=0 is 6 AM (subtract 6/24).
//   Day window in shifted frame: [0,   0.5] AND [1, 1.5]   (12h total)
//   Night window in shifted frame: (0.5, 1) AND (1.5, 2)   (12h total)
//
// We compute: hoursInDayPerCycle, hoursInNightPerCycle, then scale to monthly:
//   monthlyHours = hoursPerCycle * (daysPerWeek/7) * (365/12)

export function deviceMonthlyKwh(device, count, onTime, offTime, daysPerWeek) {
  // null/empty inputs → contributes nothing
  if (onTime == null || offTime == null || count == null || count <= 0) {
    return { dayKwh: 0, nightKwh: 0 };
  }

  // Replicate the Excel formula structure exactly.
  // The "duration" of the device's ON cycle, mapped to [0..1):
  let dur;
  if (onTime === offTime) {
    dur = 1; // runs continuously all day
  } else if (offTime > onTime) {
    dur = offTime - onTime;
  } else {
    dur = offTime + 1 - onTime;
  }

  // Shifted on-time: ((onTime - 6/24) MOD 1)
  const SHIFT = DAY_START_HOUR / 24;
  const onShifted = (((onTime - SHIFT) % 1) + 1) % 1;

  // Day window contribution (in fractional days, then *24 → hours)
  // Two pieces because the "shifted day" can wrap:
  //   piece1: window [0,   0.5]
  //   piece2: window [1.0, 1.5]
  const dayPiece1 = Math.max(
    0,
    Math.min(onShifted + dur, 0.5) - Math.max(onShifted, 0),
  );
  const dayPiece2 = Math.max(
    0,
    Math.min(onShifted + dur, 1.5) - Math.max(onShifted, 1),
  );
  const hoursDay = (dayPiece1 + dayPiece2) * 24;

  // Night window contribution
  //   piece1: window (0.5, 1.0]
  //   piece2: window (1.5, 2.0]
  const nightPiece1 = Math.max(
    0,
    Math.min(onShifted + dur, 1.0) - Math.max(onShifted, 0.5),
  );
  const nightPiece2 = Math.max(
    0,
    Math.min(onShifted + dur, 2.0) - Math.max(onShifted, 1.5),
  );
  const hoursNight = (nightPiece1 + nightPiece2) * 24;

  // Monthly hours: per-cycle hours * (daysPerWeek/7) * (365/12)
  const monthlyMultiplier = (daysPerWeek / 7) * (365 / 12);
  const dayHoursPerMo = hoursDay * monthlyMultiplier;
  const nightHoursPerMo = hoursNight * monthlyMultiplier;

  // Find avg kW for the device
  const avgKw = device ? device.peakKw * device.dutyFactor : 0;

  return {
    dayKwh: dayHoursPerMo * avgKw * count,
    nightKwh: nightHoursPerMo * avgKw * count,
  };
}

/**
 * Sum the per-device contributions across the customer's device table.
 * deviceRows: [{ deviceName, count, onTime, offTime, daysPerWeek }, ...]
 */
export function totalDeviceKwh(deviceRows) {
  let day = 0,
    night = 0;
  for (const row of deviceRows) {
    if (!row.deviceName) continue;
    const device = DEVICES.find((d) => d.name === row.deviceName);
    if (!device) continue;
    const { dayKwh, nightKwh } = deviceMonthlyKwh(
      device,
      row.count,
      row.onTime,
      row.offTime,
      row.daysPerWeek,
    );
    day += dayKwh;
    night += nightKwh;
  }
  return { totalDeviceDayKwh: day, totalDeviceNightKwh: night };
}

// ─── Recommended panel count (CALCULATOR Q34, W7) ────────────────────────────
// CALCULATOR Q25 = monthlyBill / utilityRate  (estimated kWh consumption)
// CALCULATOR Q26 = totalDeviceDayKwh + totalDeviceNightKwh (from listed devices)
// CALCULATOR Q27 = Q25 - Q26  (baseload — what the device list doesn't account for)
// CALCULATOR Q28 = Q27/2 + deviceDayKwh    (total day-time kWh)
// CALCULATOR Q29 = Q27/2 + deviceNightKwh  (total night-time kWh)
// CALCULATOR Q31 = Q29 / batteryEfficiency / batteryDepthOfDischarge (battery sizing)
// CALCULATOR Q32 = (Q28 + Q31) * 12 / 365  (daily capacity needed)
// CALCULATOR Q33 = panelWatts (lookup based on phase)
// CALCULATOR Q34 = desiredSavings * Q32 * 1000 / Q33 / kWhPerKwpPerDay
// CALCULATOR W7 (recommended panel count) = ROUNDUP(Q34, 0)

export function computeRecommendedPanels(inputs, adminParams) {
  const { monthlyBill, utilityRate, deviceRows, desiredSavingsPct, phase } =
    inputs;
  const Q25 = monthlyBill / utilityRate;
  const { totalDeviceDayKwh, totalDeviceNightKwh } = totalDeviceKwh(deviceRows);
  const Q26 = totalDeviceDayKwh + totalDeviceNightKwh;
  const Q27 = Q25 - Q26; // baseload (can be negative if user-listed > bill implies)
  const Q28 = Q27 / 2 + totalDeviceDayKwh; // total day kWh/mo
  const Q29 = Q27 / 2 + totalDeviceNightKwh; // total night kWh/mo
  const Q31 =
    Q29 / adminParams.batteryEfficiency / adminParams.batteryDepthOfDischarge;
  const Q32 = ((Q28 + Q31) * 12) / 365; // daily capacity needed (kWh/day)
  const panelWatts =
    phase === "three"
      ? PANEL_SETTINGS.threePhase.panelWatts
      : PANEL_SETTINGS.singlePhase.panelWatts;
  const Q34 =
    (desiredSavingsPct * Q32 * 1000) / panelWatts / adminParams.kWhPerKwpPerDay;
  // v3-68: Product-settable minimum system size. DELIBERATE DEVIATION from the
  // Excel mirror (the workbook has no equivalent knob): the recommendation is
  // floored at the panel-count equivalent of adminParams.minSystemKwp. Inert
  // at the shipped default of 0 (floor = 0 panels → Math.max is a no-op), so
  // the Excel-mirrored value W7 = ROUNDUP(Q34) is unchanged until Product
  // raises the limit. minPanelsFloor is exported for the Step 2A override
  // input, which clamps manual entries to the same floor (0 stays allowed for
  // standalone RSD/inverter retrofit orders).
  const minPanelsFloor = Math.ceil(
    ((adminParams.minSystemKwp || 0) * 1000) / panelWatts,
  );
  // v3-106 — panel stock flag. When the active phase's panel is out of stock
  // the recommendation is forced to ZERO panels (overriding the min-system
  // floor too — you can't floor an order to panels that don't exist). The
  // quote itself proceeds: batteries / inverters / RSD retrofits for existing
  // installations are all still orderable (the standalone pricing paths).
  // Absent flag = available, so pre-v3-106 blobs need no migration.
  const panelsAvailable =
    (phase === "three"
      ? PANEL_SETTINGS.threePhase.available
      : PANEL_SETTINGS.singlePhase.available) !== false;
  const W7 = panelsAvailable
    ? Math.max(Math.ceil(Q34), minPanelsFloor) // recommended panel count
    : 0;

  // Validity warning: if Q27 < 0, user's device list claims more kWh than the
  // bill suggests — Excel shows "Something doesn't add up."
  const inconsistent = Q27 < 0;

  return {
    estMonthlyKwh: Q25,
    deviceDayKwh: totalDeviceDayKwh,
    deviceNightKwh: totalDeviceNightKwh,
    deviceTotalKwh: Q26,
    baseloadKwh: Q27,
    dayTimeKwh: Q28,
    nightTimeKwh: Q29,
    batteryNightTimeKwh: Q31,
    dailyCapacityNeeded: Q32,
    rawRecommendation: Q34,
    recommendedPanelCount: W7,
    minPanelsFloor,
    panelWatts,
    panelsAvailable, // v3-106 — false ⇒ W7 forced to 0; UI shows out-of-stock notice
    inconsistent,
  };
}

// ─── Recommended battery size (CALCULATOR Y25) ───────────────────────────────
// Excel: Y25 = ROUNDUP(ROUND(Schedule!G37, 0) / 5, 0) * 5
// This requires running the 24-hour schedule (which depends on panel count).
// We call this from the schedule module instead, after the day-curve is built.
// See: lib/schedule.js → batteryDailyExcess() + roundBatteryKwhToPackage()

// ─── Filter available inverters and sort descending ──────────────────────────
// Excel Inventory!G8:J40 = SORT(C8:F40, 4, 1) — sort by Available descending.
// We additionally filter to ONLY available rows for the dropdown source.
// The recommended-inverter logic uses these in order, picking the largest
// available size first.

export function availableInverters(phase) {
  const list =
    phase === "three" ? INVERTERS_THREE_PHASE : INVERTERS_SINGLE_PHASE;
  // v3-106 — rows carry an `available` stock flag (absent = available, so
  // pre-v3-106 blobs need no migration). Out-of-stock SKUs keep their row in
  // the admin editor but are excluded HERE — the single chokepoint both the
  // recommendation engine (recommendInverters) and the Step 2C dropdown read
  // from, so one filter covers every consumer. Sort largest-first to mirror
  // the Excel VLOOKUP behavior.
  return list
    .filter((inv) => inv.available !== false)
    .sort((a, b) => b.ratedKw - a.ratedKw);
}

// ─── Recommended inverter split (CALCULATOR G19, G20, G21) ───────────────────
// Excel logic:
//   Total inverter AC kW required: H17 = sum of selected
//   Required total: G18 = systemKwp / maxDcAcRatio
//                       (e.g. 5.04 kWp / 1.3 = 3.88 kW required)
//   G19 = MIN(G18, MAX(available inverters))   ← largest first
//   G20 = MIN(G18-G19, MAX(available inverters))
//   G21 = MIN(G18-G19-G20, MAX(available inverters))
// Then VLOOKUP picks the smallest available inverter >= G19 (etc.).
//
// Our function returns up to 3 recommended inverter sizes (kW). Each is the
// smallest AVAILABLE inverter whose rated kW >= the remaining required kW.
// If we run out of remaining requirement → returns null for that slot.

export function recommendInverters(systemKwp, phase) {
  const available = availableInverters(phase);
  if (available.length === 0) return [null, null, null];

  const maxRatio =
    phase === "three"
      ? PANEL_SETTINGS.threePhase.maxDcAcRatio
      : PANEL_SETTINGS.singlePhase.maxDcAcRatio;
  const totalAcKwRequired = systemKwp / maxRatio;
  const largestAvailable = available[0].ratedKw;

  const slots = [null, null, null];
  let remaining = totalAcKwRequired;

  for (let i = 0; i < 3; i++) {
    if (remaining <= 0.001) break;
    const target = Math.min(remaining, largestAvailable);
    // Find smallest available inverter whose ratedKw >= target.
    // (Sorted ascending here so we pick the smallest sufficient one.)
    const ascending = [...available].sort((a, b) => a.ratedKw - b.ratedKw);
    const picked =
      ascending.find((inv) => inv.ratedKw >= target) ||
      ascending[ascending.length - 1];
    slots[i] = picked;
    remaining -= picked.ratedKw;
  }

  return slots;
}

// ─── System sizing summary (CALCULATOR Y6, H17, G17) ─────────────────────────
// Y6 = panelCount * panelWatts / 1000  (system kWp)
// H17 = sum of selected inverter rated kW
// G17 = Y6 / H17  (actual DC/AC ratio)
// Warning if G17 > F17 (max ratio)

export function systemSizing(panelCount, panelWatts, selectedInverters, phase) {
  const systemKwp = (panelCount * panelWatts) / 1000;
  const totalInverterKw = selectedInverters.reduce(
    (sum, inv) => sum + (inv ? inv.ratedKw : 0),
    0,
  );
  const dcAcRatio = totalInverterKw > 0 ? systemKwp / totalInverterKw : 0;
  const maxRatio =
    phase === "three"
      ? PANEL_SETTINGS.threePhase.maxDcAcRatio
      : PANEL_SETTINGS.singlePhase.maxDcAcRatio;
  const ratioExceeded = dcAcRatio > maxRatio;
  return { systemKwp, totalInverterKw, dcAcRatio, maxRatio, ratioExceeded };
}

// ─── Cabling tier lookup (Admin VLOOKUP, B37:G44, 6, TRUE) ────────────────────
// VLOOKUP with approximate match returns the row where panelCount >= minPanels
// — i.e. the LAST row whose minPanels is still <= panelCount.

// Conservative baseline matching the smallest-panel-count default tier.
// Used as a last-resort fallback if cablingTiers is missing or empty so
// the calculator never crashes — the alternative is a blank page.
const FALLBACK_CABLING_TIER = {
  minPanels: 1,
  dcCablePct: 0.27,
  acCablePct: 0.08,
  conduitsPct: 0.12,
  panelBoardPct: 0.09,
};

// ─── v3-174 · tier total + THE MONOTONICITY FLOOR ────────────────────────────
// Cabling costs pct × panels × panelPrice, so each tier's cost at its own
// minPanels is an ANCHOR. For the ladder never to price a larger system
// cheaper than a smaller one, anchors must be non-decreasing:
//     pct[i] × minPanels[i]  ≥  pct[i-1] × minPanels[i-1]
// cablingTierRequiredTotal() computes that floor for a row; it is the ONE
// definition consumed by the Engineering editor (per-field minimums + save
// block), the client pre-save validator, and — hand-mirrored, since functions
// cannot import from src/ — the server validator in netlify/functions/
// parameters.js. The smoke suite diffs the two implementations.
export function cablingTierTotal(tier) {
  return (
    (tier.dcCablePct || 0) +
    (tier.acCablePct || 0) +
    (tier.conduitsPct || 0) +
    (tier.panelBoardPct || 0)
  );
}
export function cablingTierRequiredTotal(tiers, idx) {
  if (idx <= 0 || !tiers[idx - 1] || !tiers[idx]) return 0;
  const prev = tiers[idx - 1];
  return (
    (cablingTierTotal(prev) * (prev.minPanels || 1)) /
    (tiers[idx].minPanels || 1)
  );
}
// Every-boundary check, shared by the client validator and the smoke gate.
// Returns null when monotone, else { index, minPanels, requiredTotal, total }.
export function findCablingTierViolation(tiers) {
  const sorted = [...tiers].sort(
    (a, b) => (a.minPanels || 0) - (b.minPanels || 0),
  );
  for (let i = 1; i < sorted.length; i++) {
    const req = cablingTierRequiredTotal(sorted, i);
    const tot = cablingTierTotal(sorted[i]);
    if (tot < req - 1e-9) {
      return {
        index: i,
        minPanels: sorted[i].minPanels,
        requiredTotal: req,
        total: tot,
      };
    }
  }
  return null;
}

// ─── v3-178 · PER-COMPONENT DECOMPOSITION (admin test row) ───────────────────
// `cablingTotalPct` interpolates the TOTAL only — since v3-174 there has been
// no per-component percentage anywhere in the engine. The Inventory tier-table
// test row needs one figure per component column, so this returns the four.
//
// ⚠ THIS IS NOT NEW PRICING MATH. Interpolation is LINEAR and each tier's
// total anchor is exactly the sum of its four component anchors, so
// interpolating each component between its own anchors at the SAME fraction f
// gives four costs that sum to the total cost:
//
//   Σ_c [ cost_c(a) + (cost_c(b) − cost_c(a))·f ]
//     = cost_total(a) + (cost_total(b) − cost_total(a))·f
//
// i.e. `sum(cablingComponentPcts(n, …)) === cablingTotalPct(n, …)` identically.
// Swept over both live tables at every count 1–200 the largest gap is 2.22e-16
// — one ULP. The smoke suite asserts this agreement, so the test row is a VIEW
// of the engine (v3-172 grid precedent): if this ever diverges from
// cablingTotalPct the suite fails rather than an admin reading a wrong number.
//
// Deliberately mirrors cablingTotalPct's branch structure — same sort, same
// clamp at n>=1, same flat-below-first / flat-above-last regions — so the two
// cannot drift on edge cases. NO CALLER PRICES ANYTHING WITH THIS; it exists
// for display, and the quote continues to consume cablingTotalPct as-is.
export const CABLING_COMPONENT_FIELDS = [
  "dcCablePct",
  "acCablePct",
  "conduitsPct",
  "panelBoardPct",
];

export function cablingComponentPcts(panelCount, tiers) {
  const list = Array.isArray(tiers) ? tiers : [];
  if (list.length === 0) {
    const t = FALLBACK_CABLING_TIER;
    return CABLING_COMPONENT_FIELDS.map((f) => t[f] || 0);
  }
  const at = (t) => CABLING_COMPONENT_FIELDS.map((f) => t[f] || 0);
  // v3-212 — must track cablingTotalPct's model exactly. The admin test row
  // renders these four cells beside a TOTAL taken from the engine, and the
  // two are only equal by construction while both use the same lookup; under
  // production parity these become the chosen tier's raw component values.
  if (MATCH_PRODUCTION_PRICING) {
    let chosen = list[0];
    for (const tier of list) {
      if (tier.minPanels <= panelCount) chosen = tier;
      else break;
    }
    return at(chosen);
  }
  const sorted = [...list].sort(
    (a, b) => (a.minPanels || 0) - (b.minPanels || 0),
  );
  const n = Math.max(1, panelCount || 0);
  if (n <= sorted[0].minPanels) return at(sorted[0]);
  const last = sorted[sorted.length - 1];
  if (n >= last.minPanels) return at(last);
  let hi = 1;
  while (sorted[hi].minPanels < n) hi++;
  const a = sorted[hi - 1],
    b = sorted[hi];
  const f = (n - a.minPanels) / (b.minPanels - a.minPanels);
  return CABLING_COMPONENT_FIELDS.map((field) => {
    const ca = (a[field] || 0) * (a.minPanels || 1);
    const cb = (b[field] || 0) * (b.minPanels || 1);
    return (ca + (cb - ca) * f) / n;
  });
}

// Which anchors a given count sits between — drives the test row's caption so
// an engineer can see WHY a number is what it is, including the two flat
// regions, which are the ones that surprise people.
export function cablingInterpolationSpan(panelCount, tiers) {
  const list = Array.isArray(tiers) ? tiers : [];
  if (list.length === 0) return null;
  const sorted = [...list].sort(
    (a, b) => (a.minPanels || 0) - (b.minPanels || 0),
  );
  const n = Math.max(1, panelCount || 0);
  const last = sorted[sorted.length - 1];
  if (n >= last.minPanels) return { flat: "above", anchor: last.minPanels };
  // v3-212 — under production parity nothing interpolates: a count sits INSIDE
  // a band and pays that band's rate flat until the next tier begins. Reported
  // as its own kind so the test row's caption states the real rule rather than
  // describing an interpolation that is not happening.
  if (MATCH_PRODUCTION_PRICING) {
    let chosen = sorted[0];
    let next = null;
    for (const tier of sorted) {
      if (tier.minPanels <= n) chosen = tier;
      else {
        next = tier.minPanels;
        break;
      }
    }
    return { flat: "step", anchor: chosen.minPanels, to: next };
  }
  if (n <= sorted[0].minPanels)
    return { flat: "below", anchor: sorted[0].minPanels };
  let hi = 1;
  while (sorted[hi].minPanels < n) hi++;
  return {
    flat: null,
    from: sorted[hi - 1].minPanels,
    to: sorted[hi].minPanels,
  };
}

// ─── v3-212 · PRODUCTION PRICING PARITY SWITCH ───────────────────────────────
// TRUE  = price exactly as the LIVE PRODUCTION build (main) does.
// FALSE = the v3-174 + v3-191 model this branch was developed against.
//
// WHY THIS EXISTS. The CEO set the package prices in production by working
// BACKWARDS from a target price per package to the margin and tier figures
// that produce it. Those figures are therefore not inputs anyone is free to
// reinterpret — they are the solution to his pricing, and any change to how
// the engine consumes them moves a number he personally signed off. Shipping
// this branch on its own model would have re-priced live quotes without a
// pricing decision behind it, so the release goes out PRICE-NEUTRAL and the
// pricing change becomes its own approval, on its own timing.
//
// The two behaviours this gates, and what they cost when TRUE:
//
//   1. CABLING TIER LOOKUP — step (production) vs cost-space interpolation
//      (v3-174). This is nearly all of the money. At panel counts between
//      tier anchors the two disagree by thousands: 19 panels prices ₱36,505
//      apart. At the anchors themselves they agree to within ₱15.
//
//      ⚠ The step lookup is NOT monotone. Cost rises across a tier then drops
//      at the next boundary, so a LARGER system can be quoted CHEAPER cabling:
//      on the current live table, 19 panels bills ₱41,698 MORE than 20, and
//      7 panels ₱14,893 more than 8. Six such cliffs exist across 1–40 panels.
//      This is why v3-174 replaced the lookup, and it is a live commercial
//      defect in production TODAY, not something introduced here. It cannot be
//      fixed by editing the tier table — the anchor rule only governs anchor
//      to anchor, so the counts BETWEEN anchors stay exposed (raising the
//      20-panel row to its floor makes it worse: seven cliffs, not six).
//      Interpolation removes all of them. Flipping this switch to FALSE, with
//      the 20-panel row raised to ≥50.4%, yields no cliffs at any size.
//
//   2. MOUNTING + CABLING PRICING SPACE — v3-191 decision D2. Production
//      derives both from the panels' SELLING price; D2 derives them from the
//      panels' COGS and prices each at its own component margin. Worth ≤₱21
//      across 1–40 panels, so it is included here only to make parity exact.
//      Note D2 is what lets those two lines carry a margin of their own: while
//      this switch is TRUE they silently inherit the panel margin, and the
//      `P` / `B` / `C` entries in componentMargins do not apply to them.
//
// TO CHANGE PRICING: flip this to false in a PR of its own, with the approval
// referenced in the commit. Deliberately NOT an admin parameter — a control
// that silently re-prices every quote must not be one click away in a console.
export const MATCH_PRODUCTION_PRICING = true;

export function cablingTotalPct(panelCount, adminParams, phase) {
  // v3-62: phase-aware tier selection. Three-phase installations use their
  // own tier table (cablingTiersThreePhase); if it's missing or empty (e.g. a
  // stale blob predating the migration seed), fall back to the single-phase
  // table — the pre-v3-62 behavior — rather than the bare hardcoded tier.
  const singleTiers =
    adminParams && Array.isArray(adminParams.cablingTiers)
      ? adminParams.cablingTiers
      : [];
  const threeTiers =
    adminParams && Array.isArray(adminParams.cablingTiersThreePhase)
      ? adminParams.cablingTiersThreePhase
      : [];
  const tiers =
    phase === "three" && threeTiers.length > 0 ? threeTiers : singleTiers;
  if (tiers.length === 0) {
    if (typeof console !== "undefined") {
      console.warn(
        "[cablingTotalPct] No cabling tiers available; falling back to default tier.",
      );
    }
    const t = FALLBACK_CABLING_TIER;
    return t.dcCablePct + t.acCablePct + t.conduitsPct + t.panelBoardPct;
  }
  // ─── v3-174 · COST-SPACE INTERPOLATION (user-directed, Pat) ───────────────
  // Until v3-173 this was a step lookup: the band-start percentage held flat
  // to the next boundary, so cost PEAKED at minPanels[next] − 1 and then fell
  // — a 23-panel quote priced ₱22,625 MORE cabling than a 24-panel one, on
  // production data that satisfies the anchor rule. The tier rows are treated
  // as ANCHORS on a cost curve instead: cost is exact at each anchor, a
  // straight line between adjacent anchors, and the last tier's percentage
  // holds flat beyond the ladder (cost keeps growing linearly — the pre-v3-174
  // live behavior above 31 panels, unchanged).
  //
  // Monotone BY CONSTRUCTION whenever the anchors are: a straight line
  // between two anchors is bounded by them, so anchors in order ⇒ curve in
  // order — which is exactly the floor the editor and both validators enforce.
  // The function still RETURNS a percentage (interpolated cost ÷ panelCount)
  // so every caller — package pricing, captions, gates — is untouched. The
  // panel price cancels out of the interpolation, so anchors are computed as
  // pct × minPanels without ever touching a price here.
  // v3-212 — production parity: the pre-v3-174 STEP lookup, byte-for-byte the
  // logic main still runs (last tier whose minPanels <= panelCount; tiers are
  // read in STORED order, not sorted, exactly as production does). See
  // MATCH_PRODUCTION_PRICING above for why, and for the cliffs this reinstates.
  if (MATCH_PRODUCTION_PRICING) {
    let chosen = tiers[0];
    for (const tier of tiers) {
      if (tier.minPanels <= panelCount) chosen = tier;
      else break;
    }
    return (
      chosen.dcCablePct +
      chosen.acCablePct +
      chosen.conduitsPct +
      chosen.panelBoardPct
    );
  }
  const sorted = [...tiers].sort(
    (a, b) => (a.minPanels || 0) - (b.minPanels || 0),
  );
  const n = Math.max(1, panelCount || 0);
  const anchorCost = (t) => cablingTierTotal(t) * (t.minPanels || 1);
  if (n <= sorted[0].minPanels) return cablingTierTotal(sorted[0]);
  const last = sorted[sorted.length - 1];
  if (n >= last.minPanels) return cablingTierTotal(last);
  let hi = 1;
  while (sorted[hi].minPanels < n) hi++;
  const a = sorted[hi - 1],
    b = sorted[hi];
  const cost =
    anchorCost(a) +
    ((anchorCost(b) - anchorCost(a)) * (n - a.minPanels)) /
      (b.minPanels - a.minPanels);
  return cost / n;
}

// ─── Single-phase panel direct-purchase price (Inventory D3) ─────────────────
// Excel D3 formula: =9008*70%/(1-A2) where A2 = Admin!A1.
// At runtime, the markup helper in adminParams.js computes:
//   directPrice = supplierCost * 0.7 / (1 - 0.26144542543429433) = ~0.948 * supplierCost
//
// Single-phase panel direct price is computed via that helper at module load
// time (PANEL_SETTINGS.singlePhase.panelDirectPrice). 3-phase is hardcoded.

export function panelDirectPrice(phase) {
  return phase === "three"
    ? PANEL_SETTINGS.threePhase.panelDirectPrice
    : PANEL_SETTINGS.singlePhase.panelDirectPrice;
}

// =============================================================================
// PACKAGE PRICING — produces every line item for the Summary sheet
// -----------------------------------------------------------------------------
// Returns a list of line items, each with:
//   { description, directPrice, isShown }
// "isShown" = whether this line is in the visible Summary FILTER (B<>0).
// =============================================================================

// ─── v3-150 · line item → Quote Summary category ─────────────────────────────
// User-directed assignment (Pat, v3-150). Every key the engine can emit is
// listed EXACTLY once; the smoke suite asserts the partition is exhaustive and
// disjoint, so adding a line item without categorizing it fails the gate
// rather than silently defaulting into Misc.
//
// `misc0..N` are deliberately ABSENT: a 2F line takes its category from the
// catalog item the rep picked (Anjon sets it per item), and free-form "Other"
// rows fall through to 'misc'. Resolved per-row inside the misc loop below.
const LINE_ITEM_CATEGORY = {
  // A · Solar Package
  panels: "solar",
  mounting: "solar",
  cabling: "solar",
  dcExtra: "solar",
  acExtra: "solar",
  labor: "solar",
  rsd: "solar",
  rsdLabor: "solar",
  inverter0: "solar",
  inverter1: "solar",
  inverter2: "solar",
  invMob: "solar",
  // B · Battery Package
  battery: "battery",
  rack: "battery",
  ats: "battery",
  critLoads: "battery",
  batteryLabor: "battery",
  // C · Misc. Materials, Labor, Services & Other Adjustments
  roof: "misc",
  location: "misc",
};

export { LINE_ITEM_CATEGORY };

export function buildPackageLineItems(state, adminParams, schedule) {
  const {
    phase,
    panelCount,
    mountingSupportOverride,
    // v3-18 rename: these now hold the TOTAL meters required (panels-to-
    // inverter for DC, inverter-to-CB-panel for AC), not just the meters
    // beyond the included baseline. The math below subtracts the baseline
    // before billing so the customer is only charged for excess.
    dcCableMeters,
    acCableMeters,
    rsdEnabled,
    rsdStandalonePanelCount,
    selectedInverters,
    batteryKwh,
    roofMaterial, // NEW v3: 'metal' | 'asphalt' | 'concrete'
    location, // NEW v3: 'luzon' | 'cebu' | 'siargao'
    locationKm, // NEW v3: road-km from the Parañaque logistics hub (v3-114; was Rizal Park)
    miscMaterials, // [{ description, count, unitPrice }, ...]
  } = state;

  // v3-80 — the RTO catalogue is gone. There is no longer a "60-Mo RTO price"
  // for a line item: OpCo sells at the Direct Purchase Price, and AssetCo
  // finances whatever balance remains after the down payment. Line items carry
  // a direct price and nothing else.

  const panelWatts =
    phase === "three"
      ? PANEL_SETTINGS.threePhase.panelWatts
      : PANEL_SETTINGS.singlePhase.panelWatts;
  const systemKwp = (panelCount * panelWatts) / 1000;

  // v3-175/176 — the expansion flag and the order's effective inverter list are
  // resolved BEFORE the margin, because the margin now depends on whether the
  // order carries an inverter at all. On an expansion the three selections are
  // ignored outright (enforced HERE, not only in the App view — the smoke
  // harness assembles state directly and gate 9.1 caught the first cut pricing
  // an inverter through exactly that path); App's forced-empty effective slots
  // and this line agree by construction.
  // v3-204 — the expansion input is the existing array's RATED kWp (Pat:
  // older systems had lower per-panel wattages, but homeowners know their
  // rated capacity), replacing the panel count. The gate keys on it here and
  // in App's forced-empty-slots mirror identically.
  const expansionMode =
    !!state.expansionMode && (state.existingKwp || 0) > 0 && panelCount > 0;
  const invSelected = expansionMode ? [null, null, null] : selectedInverters;
  const orderHasInverter = invSelected.some((i) => i);

  // v3-92 — each quote re-prices every COGS-derived line at ITS OWN margin.
  // deriveDirectPrices runs on a CLONE so the global objects stay at the
  // boot/reference margin (admin display) and concurrent quotes can never
  // corrupt each other.
  // v3-191 — the single quoteMargin scalar is REPLACED by a per-component
  // resolver (user-directed, Pat). The rule, confirmed verbatim: Follow /
  // Fixed apply ONLY when the order contains BOTH panels AND an inverter;
  // `otherwise` applies whenever either leg is missing. The panels line
  // itself rides the PHASE's curve on a full system, and the phase's
  // panels-without-inverter parameter on a panels-only order — never the
  // curve. Preventive maintenance stays at grossMarginReference via the
  // resolver's 'PM' route.
  // v3-208 — the resolver now also receives the quote's batteryKwh: the 'K'
  // route prices the six battery lines off the battery curve at that kWh,
  // whatever the panels/inverter shape (user-directed — production main).
  const marginFor = buildMarginResolver(
    adminParams,
    systemKwp,
    panelCount,
    orderHasInverter,
    phase,
    batteryKwh,
  );
  const ap = {
    ...adminParams,
    batteryPackages: (adminParams.batteryPackages || []).map((p) => ({ ...p })),
  };
  deriveDirectPrices(ap, null, null, null, marginFor);

  const panelCogsEa =
    phase === "three"
      ? PANEL_SETTINGS.threePhase.panelCogs
      : PANEL_SETTINGS.singlePhase.panelCogs;
  const panelPriceEa = directFromCogs(panelCogsEa, ap, marginFor("A"));

  // v3-134 — every line item also carries `cogs`: the SAME composition as its
  // directPrice but on the ENTERED pre-VAT COGS keys (Anjon's numbers, exact —
  // NOT reverse-derived from the ceilinged DP). Rep-entered misc lines have no
  // COGS → null. Surfaced in the Summary's admin price-reveal beside DP.

  const items = [];

  // 1. Solar panels
  const panelsTotal = panelCount * panelPriceEa;
  const panelsCogsTotal = panelCount * panelCogsEa;
  items.push({
    key: "panels",
    description: `${panelCount} units ${panelWatts}W Solar Panels`,
    directPrice: panelsTotal,
    cogs: panelsCogsTotal,
  });

  // 2. Mounting support — max(floor, 13% of panels) [skip if no panels]
  // v3-191 (2b, decision D2) — the floor-vs-percentage winner is decided in
  // COGS SPACE and the result priced at the P component margin. Pre-v3-191
  // the max was taken in PRICE space (floor price vs 13% of panels price),
  // which coincided only because both legs shared one margin; under an
  // independent P margin the two spaces could disagree, so COGS space is the
  // single authority. The line's cogs field is that same notional COGS.
  const mountingCogs =
    panelsTotal === 0
      ? 0
      : Math.max(
          ap.mountingSupportFloorCogs,
          panelsCogsTotal * ap.mountingSupportPctOfPanels,
        );
  // v3-212 — production parity: production takes the floor-vs-percentage max
  // in PRICE space off the panels' selling price, which implicitly prices this
  // line at the PANEL margin (marginFor("P") is not consulted). The COGS field
  // above is unchanged either way, so the quote's cost column is identical.
  const mountingDirect =
    panelsTotal === 0
      ? 0
      : MATCH_PRODUCTION_PRICING
        ? Math.max(
            ap.mountingSupportFloorPrice,
            panelsTotal * ap.mountingSupportPctOfPanels,
          )
        : directFromCogs(mountingCogs, ap, marginFor("P"));
  items.push({
    key: "mounting",
    description: "Mounting Support",
    directPrice: mountingDirect,
    cogs: mountingCogs,
  });

  // 3. Cables, conduits, fittings, panel board & other devices
  // v3-62: phase-aware — 3-phase installs use cablingTiersThreePhase.
  //
  // v3-175 — PANELS-ONLY EXPANSION prices this line MARGINALLY (user-directed,
  // Pat): the customer already has an array wired, so the charge is what the
  // combined system costs MINUS what the existing system alone would cost —
  // C(existing + new) − C(existing) — all four bundled components (DC, AC,
  // conduits, panel board) sharing the treatment because the tier percentage
  // prices them as one bundle. Non-negative BY CONSTRUCTION under the v3-174
  // cost-interpolation (anchors monotone ⇒ curve monotone), which is the
  // release that made this rule safe to ship without a clamp; Math.max(0, ·)
  // stays as defense-in-depth only. The separate Add'l DC/AC Cable per-metre
  // lines are NOT marginal — those metres are the new run, entered as such.
  // Mounting, labor, and RSD price on the new panels only (the crew rails and
  // mobilizes for the new array regardless of what is already on the roof).
  //
  // v3-204 (D2, Pat as Math Owner) — the existing side enters as FRACTIONAL
  // panel-equivalents derived from the customer's stated RATED kWp at the
  // LIVE per-phase wattage parameter: exEq = existingKwp × 1000 / panelWatts.
  // No rounding — the v3-174 cost curve is continuous, and rounding would
  // re-quantize an exactly-stated capacity. Floored at 1.0 (the old
  // max(1, round(count)) guard's spirit) so a sub-panel-equivalent input
  // never lands below the first tier anchor. EQUIVALENCE BRIDGE, pinned in
  // smoke-v204: existingKwp = k × panelWatts/1000 at integer k reproduces the
  // v3-203 quote at existingPanelCount = k to the centavo.
  const exEq = expansionMode
    ? Math.max(1, (state.existingKwp * 1000) / panelWatts)
    : 0;
  // cost in PANEL-COGS UNITS: pct(n) × n — the panel COGS multiplies once below.
  const cablingUnits = (n) => (n <= 0 ? 0 : cablingTotalPct(n, ap, phase) * n);
  const cablingUnitsCharged = expansionMode
    ? Math.max(0, cablingUnits(exEq + panelCount) - cablingUnits(exEq))
    : cablingUnits(panelCount);
  // v3-191 (2b, decision D2 — Pat chose the unified, Excel-auditable form):
  // the bundle's NOTIONAL COGS is the tier percentage applied to the panels'
  // COGS, priced at the B/C component margin through the same one-line DP
  // formula as every other component. Pre-v3-191 this line was pct × the
  // CEILINGED per-panel price — margin implicitly the panels', CEILING per
  // panel. The CEILING now applies once per line, so default-settings quotes
  // shift by centavos versus v3-190 (re-based in smoke-v3-191). Expansion
  // marginality — C(existing+new) − C(existing) — is unchanged, applied in
  // COGS units before pricing.
  const cablingCompId = phase === "three" ? "C" : "B";
  const cablingCogs = panelsTotal === 0 ? 0 : cablingUnitsCharged * panelCogsEa;
  // v3-212 — production parity: pct × the panels' SELLING price, unrounded,
  // which implicitly prices this line at the PANEL margin (marginFor is not
  // consulted). Expansion marginality still comes through cablingUnitsCharged,
  // so the expansion path keeps its C(existing+new) − C(existing) shape; the
  // per-panel price is the one production multiplies by. Note this yields a
  // FRACTIONAL line price, as production's does — which is why production's
  // equipment table and payment summary can disagree by ₱1 on the same quote.
  const cablingDirect =
    panelsTotal === 0
      ? 0
      : MATCH_PRODUCTION_PRICING
        ? cablingUnitsCharged * panelPriceEa
        : directFromCogs(cablingCogs, ap, marginFor(cablingCompId));
  items.push({
    key: "cabling",
    description: expansionMode
      ? `Cables, Conduits, Fittings, Panel Board & Other Devices — expansion rate at ${(((exEq + panelCount) * panelWatts) / 1000).toFixed(2)} kWp combined`
      : "Cables, Conduits, Fittings, Panel Board & Other Devices",
    directPrice: cablingDirect,
    cogs: cablingCogs,
  });

  // 4. Additional DC cable — only meters beyond the included baseline are
  // billed. v3-18 changed the customer-facing input from "additional meters"
  // to "total meters", so the calc now subtracts the included baseline
  // before multiplying by the per-meter rate. At the default (30m total =
  // 30m included) the line item is ₱0 and no charge appears.
  const dcExtraMeters = Math.max(
    0,
    (dcCableMeters || 0) - INCLUDED_DC_CABLE_METERS,
  );
  const dcExtraDirect =
    panelsTotal === 0 ? 0 : dcExtraMeters * ap.additionalDcCablePerMeter;
  items.push({
    key: "dcExtra",
    description: `${dcExtraMeters}m of Add'l. DC Cable`,
    // Metered length beyond the included baseline. The PDF's package-detail
    // page lists this line by length rather than by price, so a run priced at
    // ₱0/m still shows up and a 0m run drops out.
    meters: dcExtraMeters,
    directPrice: dcExtraDirect,
    cogs:
      panelsTotal === 0 ? 0 : dcExtraMeters * ap.additionalDcCablePerMeterCogs,
  });

  // 5. Additional AC cable — same pattern as DC.
  const acExtraMeters = Math.max(
    0,
    (acCableMeters || 0) - INCLUDED_AC_CABLE_METERS,
  );
  const acExtraDirect =
    panelsTotal === 0 ? 0 : acExtraMeters * ap.additionalAcCablePerMeter;
  items.push({
    key: "acExtra",
    description: `${acExtraMeters}m of Add'l. AC Cable`,
    meters: acExtraMeters, // see dcExtra
    directPrice: acExtraDirect,
    cogs:
      panelsTotal === 0 ? 0 : acExtraMeters * ap.additionalAcCablePerMeterCogs,
  });

  // 6. Solar Labor & Installation (variable per kWp + fixed overhead bundle)
  const fixedOverheadDirect =
    ap.fixedOverheadDeliveryLogistics +
    ap.fixedOverheadWarehouse +
    ap.fixedOverheadCustoms +
    ap.fixedOverheadSafetySupervision +
    ap.fixedOverheadTesting;
  const laborDirect =
    systemKwp * ap.laborInstallationPerKwp +
    (panelsTotal === 0 ? 0 : fixedOverheadDirect);
  items.push({
    key: "labor",
    description: "Solar Labor & Installation",
    directPrice: laborDirect,
    cogs:
      systemKwp * ap.laborInstallationPerKwpCogs +
      (panelsTotal === 0
        ? 0
        : ap.fixedOverheadDeliveryLogisticsCogs +
          ap.fixedOverheadWarehouseCogs +
          ap.fixedOverheadCustomsCogs +
          ap.fixedOverheadSafetySupervisionCogs +
          ap.fixedOverheadTestingCogs),
  });

  // 7. RSD bundled with solar package
  // Excel: AA14 = (panelCount * Admin!E56 + Admin!E57) * H11
  //   where E56/E57 are the 60-Mo.RTO prices, but the line uses RTO totals.
  //   Working in DIRECT, this equals:
  //     RsdBundle direct = panelCount * D56 + D57
  let rsdDirect = 0;
  if (rsdEnabled && panelsTotal > 0) {
    rsdDirect = panelCount * ap.rsdVariablePerPanel + ap.rsdFixedTransmitter;
  }
  // 8. RSD as standalone (when no solar package is being purchased)
  let rsdStandaloneDirect = 0;
  if (rsdEnabled && panelsTotal === 0 && (rsdStandalonePanelCount || 0) > 0) {
    rsdStandaloneDirect =
      rsdStandalonePanelCount * ap.rsdVariablePerPanel + ap.rsdFixedTransmitter;
  }
  // RSD Labor for standalone
  let rsdStandaloneLaborDirect = 0;
  if (rsdStandaloneDirect > 0) {
    rsdStandaloneLaborDirect =
      rsdStandalonePanelCount * ap.rsdStandaloneLaborPerPanel +
      ap.rsdStandaloneLaborMobilization;
  }
  const rsdPanelsForLabel = Math.max(panelCount, rsdStandalonePanelCount || 0);
  const rsdAnyDirect = rsdDirect + rsdStandaloneDirect;
  items.push({
    key: "rsd",
    description: `Rapid Shutdown Device (RSD) for ${rsdPanelsForLabel} Solar Panels`,
    directPrice: rsdAnyDirect,
    cogs:
      (rsdEnabled && panelsTotal > 0
        ? panelCount * ap.rsdVariablePerPanelCogs + ap.rsdFixedTransmitterCogs
        : 0) +
      (rsdEnabled && panelsTotal === 0 && (rsdStandalonePanelCount || 0) > 0
        ? rsdStandalonePanelCount * ap.rsdVariablePerPanelCogs +
          ap.rsdFixedTransmitterCogs
        : 0),
  });
  items.push({
    key: "rsdLabor",
    description: "Labor & Installation for Standalone RSD order",
    directPrice: rsdStandaloneLaborDirect,
    cogs:
      rsdStandaloneLaborDirect > 0
        ? rsdStandalonePanelCount * ap.rsdStandaloneLaborPerPanelCogs +
          ap.rsdStandaloneLaborMobilizationCogs
        : 0,
  });

  // 9. Inverters (each slot)
  invSelected.forEach((inv, i) => {
    // v3-191 — inverters price at the phase's component margin (I single /
    // J three-phase). On a full system that is Follow (= the panels curve)
    // or Fixed; an inverter-only retrofit prices at the Otherwise margin.
    const invDirect = inv
      ? directFromCogs(inv.cogs, ap, marginFor(phase === "three" ? "J" : "I"))
      : 0;
    const desc = inv ? `${inv.ratedKw.toFixed(2)} kW Inverter` : "None";
    items.push({
      key: `inverter${i}`,
      description: desc,
      directPrice: invDirect,
      cogs: inv ? inv.cogs : 0,
    });
  });

  // 10. Battery package (v3-54 — package-driven)
  // The active battery package is resolved from state.batteryPackageId via
  // ap.batteryPackages[]. Each package carries its own unit size,
  // rack capacity, and pricing. For a default-state customer who hasn't
  // touched the package selector (no batteryPackageId in state), packages[0]
  // is used — which by design preserves v3-53's "5 kWh / 3-cap" defaults
  // exactly. So a default-state quote produces bit-exact identical numbers
  // to v3-53.
  //
  // Math:
  //   batteryCount = ceil(batteryKwh / pkg.batteryUnitKwh)
  //   rackCount    = ceil(batteryCount / pkg.batteryRackCapacity)
  //   batteryDirect = batteryCount * pkg.batteryUnitPrice
  //   rackDirect    = rackCount    * pkg.batteryRackPrice
  //   ATS / critical loads / labor — same as v3-53, but pulled from pkg
  //   instead of flat ADMIN_PARAMS keys.
  //
  // The kWh dropdown in Step 2 steps in multiples of pkg.batteryUnitKwh
  // (5's for the 5 kWh pack; 16's for the 16 kWh pack), so batteryKwh
  // should always be a clean integer multiple of pkg.batteryUnitKwh at
  // call time. The ceil() is defensive: any legacy session that captured
  // an off-grid value (e.g. 25 kWh under a 16 kWh pack) still produces a
  // sane cost — it rounds up to the next physical pack count.
  const pkg = resolveBatteryPackage(ap, state.batteryPackageId);
  const batteryCount =
    (batteryKwh || 0) > 0
      ? Math.ceil((batteryKwh || 0) / pkg.batteryUnitKwh)
      : 0;
  // v3-151 — rack count now respects the package's rackRequiredFromUnits
  // threshold via the shared racksNeeded() helper. Below the threshold no rack
  // is quoted at all; the 5 kWh pack ships at 3, so one and two unit quotes
  // lose the rack they used to carry. This IS a price change and is intended.
  const rackCount = racksNeeded(pkg, batteryCount);

  // v3-151 — the rep can drop any of the three bundled components from a quote
  // (Step 2A checkboxes). Absent state reads as INCLUDED, so a session restored
  // from an earlier build is unaffected. Zeroing directPrice also drops the
  // line out of the Summary, which already filters zero-priced items — so an
  // excluded component leaves no trace on the customer's quote rather than
  // printing a PHP 0 row.
  const rackOn = state.batteryRackIncluded !== false;
  const atsOn = state.batteryAtsIncluded !== false;
  const critOn = state.batteryCritLoadsIncluded !== false;

  const batteryDirect = batteryCount * pkg.batteryUnitPrice;
  const rackDirect = rackOn ? rackCount * pkg.batteryRackPrice : 0;
  const atsDirect = atsOn && batteryKwh > 0 ? pkg.atsPrice : 0;
  const critLoadDirect =
    critOn && batteryKwh > 0 ? pkg.criticalLoadsMaterials : 0;

  // Labor with solar OR standalone
  const hasSolar = panelsTotal > 0;
  const battLaborDirect =
    batteryKwh > 0
      ? hasSolar
        ? pkg.laborWithSolarInstall
        : pkg.standaloneLabor
      : 0;
  const battLaborLabel = hasSolar
    ? "Battery Labor & Installation w/ Solar Package Installation"
    : "Battery Standalone Labor & Installation";

  items.push({
    key: "battery",
    description: `${batteryCount} unit/s ${pkg.batteryUnitKwh}kWh Battery w/ Cables & Lugs`,
    directPrice: batteryDirect,
    cogs: batteryCount * pkg.batteryUnitCogs,
  });
  items.push({
    key: "rack",
    description: `${rackCount} unit/s Battery Rack`,
    directPrice: rackDirect,
    cogs: rackOn ? rackCount * pkg.batteryRackCogs : 0,
  });
  items.push({
    key: "ats",
    description: "Automatic Transfer Switch (ATS)",
    directPrice: atsDirect,
    cogs: atsOn && batteryKwh > 0 ? pkg.atsCogs : 0,
  });
  items.push({
    key: "critLoads",
    description: "Materials for Critical Loads",
    directPrice: critLoadDirect,
    cogs: critOn && batteryKwh > 0 ? pkg.criticalLoadsMaterialsCogs : 0,
  });
  items.push({
    key: "batteryLabor",
    description: battLaborLabel,
    directPrice: battLaborDirect,
    cogs:
      batteryKwh > 0
        ? hasSolar
          ? pkg.laborWithSolarInstallCogs
          : pkg.standaloneLaborCogs
        : 0,
  });

  // 11. Standalone-inverter mobilization
  // Excel AA23: when no solar, but inverters selected, charge mobilization fee
  let invMobDirect = 0;
  const invCount = invSelected.filter((i) => i).length;
  if (panelsTotal === 0 && invCount > 0) {
    invMobDirect =
      ap.inverterStandaloneLaborPerUnit * invCount +
      ap.inverterStandaloneMobilization;
  }
  items.push({
    key: "invMob",
    description: "Mobilization for StandAlone Inverter Order",
    directPrice: invMobDirect,
    cogs:
      invMobDirect > 0
        ? ap.inverterStandaloneLaborPerUnitCogs * invCount +
          ap.inverterStandaloneMobilizationCogs
        : 0,
  });

  // 12. Roof Material (v3 — Excel CALCULATOR AA34)
  // Charge depends on which surface the panels mount to.
  //   metal     → ₱0       (no roof prep needed)  ← DEFAULT
  //   asphalt   → kWp × roofAsphaltPerKwp
  //   concrete  → kWp × roofConcretePerKwp
  let roofDirect = 0;
  let roofLabel = "Roof Preparation (Metal — no prep needed)";
  if (panelsTotal > 0) {
    if (roofMaterial === "asphalt") {
      roofDirect = systemKwp * ap.roofAsphaltPerKwp;
      roofLabel = "Roof Preparation — Asphalt / Shingles / Tiled";
    } else if (roofMaterial === "concrete") {
      roofDirect = systemKwp * ap.roofConcretePerKwp;
      roofLabel = "Roof Preparation — Concrete";
    }
  }
  items.push({
    key: "roof",
    description: roofLabel,
    directPrice: roofDirect,
    cogs:
      roofDirect === 0
        ? 0
        : systemKwp *
          (roofMaterial === "asphalt"
            ? ap.roofAsphaltPerKwpCogs
            : ap.roofConcretePerKwpCogs),
  });

  // 13. Location / Delivery (v3 — Excel CALCULATOR AA38)
  //   luzon  + km≤30 → ₱0                                            ← DEFAULT
  //   luzon  + km>30 → luzonOver30FixedFee + MAX(0, km−30) × luzonOver30PerKm   (AA38, v3-115 fix)
  //   dynamic row    → row.fixedFee + panels × row.perPanel   (v3-116)
  let locationDirect = 0;
  // v3-199 — the free radius is the luzonFreeTravelKm param (?? 30 belt for
  // a partial ap in harnesses; a real blob without the key merges the
  // bundled default).
  const luzonFreeKm = ap.luzonFreeTravelKm ?? 30;
  let locationLabel = `Location / Delivery — Luzon (within ${luzonFreeKm}km)`;
  if (panelsTotal > 0) {
    // v3-116 — dynamic delivery locations. Any non-luzon/non-other location
    // id resolves against ap.deliveryLocations (derived per-row at quote
    // margin above); a missing/deleted id defensively prices ₱0 here —
    // App.jsx already falls a stale pick back to 'luzon' before pricing, so
    // this branch is a belt-and-braces guard, not the enforcement point.
    const dynamicLoc =
      location !== "luzon" && location !== "other"
        ? (ap.deliveryLocations || []).find((l) => l.id === location)
        : null;
    if (dynamicLoc) {
      locationDirect = dynamicLoc.fixedFee + panelCount * dynamicLoc.perPanel;
      locationLabel = `Location / Delivery — ${dynamicLoc.label}`;
    } else if (location === "luzon" && (locationKm || 0) > luzonFreeKm) {
      // v3-115 PARITY FIX — workbook AA38 is MAX(0, Y39-30) × D41 + D40: the
      // per-km rate applies ONLY to the EXCESS beyond the free zone. The app
      // had charged the FULL distance since Luzon location pricing was
      // introduced, overbilling every billable Luzon quote by radius × perKm
      // and contradicting the proposal's own Logistics Add-On T&C ("any
      // excess distance beyond the first … kilometers"). User-reported
      // v3-114; verified against Solviva_Calc_v_B_5_1.xlsm CALCULATOR!AA38.
      // v3-199 — the radius (workbook's literal 30) is the luzonFreeTravelKm
      // param; the workbook still hardcodes 30 (deferred-sync list).
      locationDirect =
        ap.luzonOver30FixedFee +
        Math.max(0, (locationKm || 0) - luzonFreeKm) * ap.luzonOver30PerKm;
      locationLabel = `Location / Delivery — Luzon (${locationKm} km from Parañaque hub)`; // v3-114 origin rebase
    }
  }
  // v3-134 — location COGS mirror: dynamic row → fixedFeeCogs + panels ×
  // perPanelCogs; Luzon beyond the free radius → luzonOver30FixedFeeCogs + excess-km ×
  // luzonOver30PerKmCogs (same AA38 shape on Anjon's entered values).
  let locationCogs = 0;
  if (panelsTotal > 0) {
    const dynRow =
      location !== "luzon" && location !== "other"
        ? (ap.deliveryLocations || []).find((l) => l.id === location)
        : null;
    if (dynRow) {
      locationCogs =
        (dynRow.fixedFeeCogs || 0) + panelCount * (dynRow.perPanelCogs || 0);
    } else if (location === "luzon" && (locationKm || 0) > luzonFreeKm) {
      locationCogs =
        ap.luzonOver30FixedFeeCogs +
        Math.max(0, (locationKm || 0) - luzonFreeKm) * ap.luzonOver30PerKmCogs;
    }
  }
  items.push({
    key: "location",
    description: locationLabel,
    directPrice: locationDirect,
    cogs: locationCogs,
  });

  // 12. Misc materials (V35:Y36 — up to 12 lines, dynamic)
  // v3-138 — two kinds of row now share this loop:
  //
  //   CATALOG row (catalogId resolves): price is read LIVE off `ap.miscCatalog`
  //     — already re-derived above at THIS quote's capacity margin — not off
  //     whatever unitPrice the session happens to be holding. An Anjon price
  //     change therefore reprices open sessions, matching how batteries and
  //     delivery locations already behave. The row carries a real COGS, so it
  //     contributes to totalCogs in the admin price reveal (user-directed).
  //     A catalogId that no longer resolves (deleted, or marked out of stock)
  //     prices at ZERO rather than falling back to a stale stored number —
  //     Step 2F flags it in amber so the rep can't miss it.
  //
  //   FREE-FORM row (no catalogId, or the 'other' sentinel — which is also
  //     every row restored from a pre-v3-138 session): unchanged from v3-137.
  //     Rep-entered description and price, cogs null, excluded from totalCogs.
  // v3-150 — a 2F line reports into whichever Summary category Anjon assigned
  // to the catalog item behind it. Free-form "Other" rows, rows whose catalog
  // id no longer resolves, and rows from a pre-v3-150 blob all fall through
  // normalizeCategory() to 'misc' — the default Pat specified. Collected here
  // and applied in the single stamping pass after the loop.
  const miscCategoryByKey = {};
  (miscMaterials || []).forEach((row, i) => {
    const empty = {
      key: `misc${i}`,
      description: "",
      directPrice: 0,
      cogs: null,
    };
    miscCategoryByKey[`misc${i}`] = "misc";
    if (!row || !row.count) {
      items.push(empty);
      return;
    }

    const catId = row.catalogId;
    const isCatalog = catId && catId !== "other";
    if (isCatalog) {
      const item = (ap.miscCatalog || []).find((m) => m && m.id === catId);
      if (!item || item.available === false) {
        items.push(empty);
        return;
      }
      // A REVERSAL row assigned to 'battery' nets against the Battery Package
      // subtotal and cancels its counterpart in place — the reason the category
      // is per-ITEM rather than a fixed rule for all of 2F.
      miscCategoryByKey[`misc${i}`] = normalizeCategory(item.category);
      items.push({
        key: `misc${i}`,
        description: `${row.count} Unit/s ${item.label}`,
        directPrice: row.count * (item.price || 0),
        cogs: row.count * (Number(item.cogs) || 0),
      });
      return;
    }

    if (!row.description || !row.unitPrice) {
      items.push(empty);
      return;
    }
    items.push({
      key: `misc${i}`,
      description: `${row.count} Unit/s ${row.description}`,
      directPrice: row.count * row.unitPrice,
      cogs: null, // rep-entered PRICE — no COGS basis (shown as — in the reveal)
    });
  });

  // v3-150 — stamp every line with its Quote Summary category. Done in ONE
  // place after the fact rather than at each of the ~18 push sites: the map is
  // then the single readable statement of the assignment, and a new line item
  // that forgets to categorize itself is caught by the smoke suite's
  // exhaustiveness check instead of hiding in one branch of one push.
  // A misc row's category comes from its catalog item (miscCategoryByKey,
  // populated in the loop above); everything else from the static map. The
  // ?? 'misc' tail is the belt-and-braces fallback normalizeCategory already
  // guarantees — an uncategorized line renders in Misc rather than vanishing.
  items.forEach((i) => {
    i.category =
      miscCategoryByKey[i.key] ?? LINE_ITEM_CATEGORY[i.key] ?? "misc";
  });

  // Totals
  const totalDirect = items.reduce((s, i) => s + i.directPrice, 0);
  // v3-134 — total entered COGS across lines that HAVE a COGS basis (misc
  // excluded via null). Admin price-reveal shows it under the COGS column.
  const totalCogs = items.reduce((s, i) => s + (i.cogs ?? 0), 0);

  return {
    items,
    totalDirect,
    totalCogs,
    systemKwp,
    panelPriceEa,
  };
}

// =============================================================================
// PAYMENT SCHEDULE — Step 3 calculations
// -----------------------------------------------------------------------------
// Inputs: tenor (months), down payment %, promo code
// Returns: monthly payment, DP amount, total balance, all the fields shown in
// Step 3 of the Calculator.
// =============================================================================

// ─── v3-75: tiered minimum-DP resolution ─────────────────────────────────────
// Resolves the effective minimum down-payment fraction for a quote from the
// Product-configured adminParams.minDpTiers table, keyed on the quote's
// Net Price (v3-80: terms.netDirectPrice — the Direct Purchase Price less any
// promo. Tenor-INDEPENDENT, so a longer tenor can no longer cross a tier
// boundary and silently raise the customer's minimum DP mid-quote).
// The applicable tier is the LAST row whose fromNetPrice ≤ netPrice.
// Pure function — no pricing impact; it only gates which Step 3A options the
// UI offers. Defensive: sorts a copy (server enforces ascending order, but a
// hand-edited blob shouldn't break the floor), tolerates a missing/empty
// array (→ 0, no floor), and clamps each tier's fraction to [0, 0.5] to match
// the server-side validation bounds.
// ─── v3-153 · down-payment option set ────────────────────────────────────────
// Lifted out of Step3PaymentTerms so the Summary's "Compare your payment terms"
// selector offers EXACTLY the same values under EXACTLY the same tier floor.
// Two components now set state.downPaymentPct; a copied array is how the
// minimum-DP tier ends up enforced in one of them and not the other.
export const DP_PCT_OPTIONS = [
  0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65,
  0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0,
];

// Float-safe comparison epsilon for DP fractions (0.15 vs 0.15000000000002).
export const DP_EPS = 1e-9;

// The DP values a customer may actually choose at this price. `excludeFull`
// drops 100%: the Summary's compare block is hidden entirely when the quote is
// fully paid (!terms.isFullyPaid), so offering 100% there would make the very
// control that set it disappear. Step 3's selector lives outside that block and
// keeps the full range.
export function allowedDpOptions(minDpPct, excludeFull = false) {
  return DP_PCT_OPTIONS.filter(
    (p) => p >= minDpPct - DP_EPS && !(excludeFull && p >= 1 - DP_EPS),
  );
}

export function resolveMinDpPct(minDpTiers, netPrice) {
  if (!Array.isArray(minDpTiers) || minDpTiers.length === 0) return 0;
  const sorted = [...minDpTiers].sort(
    (a, b) => (a.fromNetPrice || 0) - (b.fromNetPrice || 0),
  );
  let pct = 0;
  for (const t of sorted) {
    const from = Number(t.fromNetPrice) || 0;
    if ((Number(netPrice) || 0) >= from) {
      pct = Math.max(0, Math.min(0.5, Number(t.minDpPct) || 0));
    } else {
      break;
    }
  }
  return pct;
}

export function computePaymentTerms(state, adminParams, packageData) {
  const { tenor, downPaymentPct, promoCode } = state;
  const { totalDirect } = packageData;

  // ═══ v3-80 — OpCo / AssetCo LOAN MODEL ═══════════════════════════════════
  // Solviva is separating OpCo (builds and sells the system) from AssetCo
  // (finances it). The pricing model now mirrors that split exactly:
  //
  //   OpCo's revenue    = the Direct Purchase Price. Full stop.
  //   AssetCo lends     = Net Price − Down Payment, and collects the monthly
  //                       payments. Its revenue is the interest.
  //
  // That is a plain amortising loan, and it DELETES the entire Rent-to-Own
  // apparatus that preceded it: the 60-Mo RTO catalogue, `catalogueRate`, the
  // PV/PMT round-trip that recovered `directPurchasePrice`, the Early Payment
  // Discount, "Additional Savings from your Down Payment", and
  // `totalPaymentsOverTenor`. None of them have a referent any more.
  //
  // WHY THAT MATTERS BEYOND TIDINESS: under the old model the down payment was
  // a percentage of an interest-inflated total, so "50% down" cost 86% of the
  // system's cash price at 60 months and only 50% at 1 month — the same label
  // meaning wildly different things, and at a 48% catalogue rate it broke
  // outright (the DP exceeded the asset and the balance went negative). Here
  // the DP is a percentage of the Net Price. 40% down means 40% down, at every
  // tenor, and `amountForFinancing = Net × (1 − dp)` cannot go negative — so
  // the v3-56 guard is now unreachable by construction.
  //
  // Mirrors CALCULATOR!AH5:AH15 and SUMMARY!G8:H19 of Solviva_Calc_v_B_4_2.

  // AH5 → AH7. v3-151 — a promo is EITHER a percentage of the package price or
  // a flat peso amount, per the code's `type`. promoDiscountAmount() owns both
  // branches and the peso clamp (a peso code larger than the order discounts
  // the order, never more), so the cascade below is unchanged in shape.
  // `promoDiscount` stays the EFFECTIVE FRACTION for display and for anything
  // downstream that reasons in percentages — on a peso code that is the clamped
  // amount over the total, which is what the customer actually got.
  const promo = adminParams.promoCodes.find(
    (p) => p.code === (promoCode || "").trim().toUpperCase(),
  );
  const discountValue = promoDiscountAmount(promo, totalDirect);
  const promoDiscount = totalDirect > 0 ? discountValue / totalDirect : 0;
  const discountAmount = -discountValue; // AH6 (≤ 0)
  const netDirectPrice = totalDirect + discountAmount; // AH7

  // The rate comes from the tenor × DP surface (Admin!C22 in the workbook is an
  // XLOOKUP into the Rate Grid sheet; `rtoRate` IS that grid, in closed form).
  const rate = rtoRate(tenor, downPaymentPct, adminParams);
  const monthlyRate = rate / 12;

  // AH9 → AH11
  const dpTotalCharge = downPaymentPct * netDirectPrice; // AH9
  const amountForFinancing = netDirectPrice - dpTotalCharge; // AH11

  // AH14 — ANNUITY-DUE (type 1): payments fall at month START, matching the
  // workbook's PMT(Admin!C22/12, tenor, -AH11, , 1) (v4.7). This is a real
  // change to every monthly payment vs the v3-80→v3-95 ordinary-annuity (type
  // 0) model, not a rounding difference — the whole payment ladder shifts DOWN.
  // WHY: paying at the start of each period means the FIRST payment retires
  // principal before any interest accrues, so at tenor 1 the single payment
  // equals the financed amount EXACTLY (zero interest) — a Direct Purchase is
  // now genuinely interest-free, which is the alignment this change is for. The
  // diminishing-balance IRR of the customer's own cash flows is still exactly
  // rtoRate/12 per month (an annuity-due is an ordinary annuity shifted one
  // period earlier; its IRR is unchanged), so the RA 3765 effective-rate
  // disclosure still holds — only the finance-charge figures re-baseline.
  //
  // v3-99 — PMT reverts to ORDINARY ANNUITY (type 0), matching
  // Solviva_Calc_v_B_5_1.xlsm AH15 `=PMT(PRODUCT!C2/12, AG12, -AH10)` (no type
  // arg). This UNDOES the v3-96 annuity-due (type 1) switch: v5.0/v5.1 collect
  // each payment at month END. Every financed monthly rises by a factor of
  // (1 + rate/12) vs type 1, lifting the total due and finance charge.
  //
  // v3-100 — DIRECT PURCHASE (tenor 0). v5.1's AH15 is
  // IFERROR(PMT(rate/12, AG12, -AH10), AH10): with AG12 = "Direct Purch" the
  // PMT errors and falls back to AH10 — the WHOLE balance, due in one payment
  // upon installation, at 0% interest. Mirrored here without the IFERROR
  // theatrics. The numeric tenor 1 now goes through PMT like any other term
  // and bears one month of interest at the curve's N-column rate.
  const isDirectPurchase = tenor < 1;
  const customerMonthlyPmt = isDirectPurchase
    ? amountForFinancing
    : PMT(monthlyRate, tenor, -amountForFinancing);

  // AH16 = IF("Direct Purch", AH10, AH15·AG12) — the balance itself for a
  // Direct Purchase, monthly × tenor otherwise.
  const finalPostInstallBalance = isDirectPurchase
    ? amountForFinancing
    : customerMonthlyPmt * tenor; // AH16
  const totalAmountDue = dpTotalCharge + finalPostInstallBalance; // AG29

  // v3-99 — DOCUMENTARY STAMP TAX (CALCULATOR!AH13). ₱1.50 per ₱200 (or part)
  // of the financed amount, prorated by the loan's fraction of a year and
  // capped at 1. Zero for a Direct Purchase (tenor 0, v3-100) — no loan, no
  // DST. The numeric 1-month term IS a loan now and pays DST at 1/12 proration.
  //   AH13 = IF(Direct Purch, 0,
  //             ROUNDUP(AH10/200,0) · PRODUCT!D3 · MIN(1, loanDays/365))
  // The workbook prorates on the ACTUAL last-payment due date; here we use
  // MIN(1, tenor/12), which is exact for tenor ≥ 12 (proration = 1) and for
  // Direct Purchase (0), and differs only by a rounding for 1–11 month financed
  // deals — a negligible amount on a small tax line. `documentaryStampTaxRate`
  // (0.0075, Product-editable as of v3-100) × 200 = the ₱1.50 per-₱200 charge.
  const dstPerTwoHundred = 200 * (adminParams.documentaryStampTaxRate ?? 0);
  const dst = isDirectPurchase
    ? 0
    : Math.ceil(amountForFinancing / 200) *
      dstPerTwoHundred *
      Math.min(1, tenor / 12);

  // v3-100 — the DST-INCLUSIVE grand total: SUMMARY!H20 = H18 + H14 + H11
  // (balance + DST + DP) = ANNEX!E8. Deliberately a NEW field: totalAmountDue
  // keeps its AG29 (DST-exclusive) definition so the pinned goldens and the
  // tenor-comparison tables (Excel AH20:AH27, which also exclude DST) are
  // untouched. Everything customer-facing that says "TOTAL AMOUNT DUE" prints
  // THIS number (per user decision — one label, one value; the workbook itself
  // shows two different totals under the same label, AG29 vs H20).
  const summaryTotalDue = totalAmountDue + dst;
  // AssetCo's revenue. Internal — the workbook's SUMMARY does not show it and
  // neither do we.
  const totalInterest = totalAmountDue - netDirectPrice; // AH19

  // v3-82 — a 100% down payment leaves nothing to finance. PMT() returns a clean
  // 0 here (no NaN), but the TENOR then means nothing: without this flag the
  // ANNEX would print up to 60 rows of ₱0 into the customer's PDF, and Step 3B
  // would offer a term for a loan that doesn't exist. Consumers use this to
  // collapse to a pure cash purchase.
  const isFullyPaid = amountForFinancing < 0.005;

  // ─── v3-86 — RA 3765 (Truth in Lending Act) DISCLOSURE FIGURES ────────────
  // The statute requires the creditor to disclose, before the credit transaction
  // is consummated: the cash price, the down payment, the AMOUNT FINANCED, the
  // FINANCE CHARGE, the total payable, and the effective interest rate.
  //
  // WE ALREADY CHARGE THE EFFECTIVE RATE. `customerMonthlyPmt` is PMT() on the
  // DIMINISHING BALANCE, so the IRR of the customer's own cash flows comes back
  // to exactly rtoRate/12 per month — verified in smoke. The rate disclosure that
  // RA 3765 exists to force is aimed at ADD-ON lenders, who compute interest on
  // the ORIGINAL principal for the whole term: at a headline 14.375% over 36
  // months that would charge ₱18,900/mo instead of ₱16,335 and a true rate near
  // 25%. PMT on a declining balance structurally cannot do that. So the rate we
  // print IS the effective rate, and the correct phrasing — the term of art that
  // distinguishes us from add-on lenders — is "per annum on the diminishing
  // balance". No second "effective" number is disclosed: one rate, one convention.
  //
  // The one thing that was genuinely missing is the FINANCE CHARGE. v3-80 kept
  // `totalInterest` out of the customer view (matching the workbook's SUMMARY).
  // The statute puts it back. It is the same number, now surfaced.
  const disclosure = {
    cashPrice: netDirectPrice,
    downPayment: dpTotalCharge,
    amountFinanced: amountForFinancing,
    financeCharge: totalInterest, // <- REQUIRED. Was hidden pre-v3-86.
    totalPayable: totalAmountDue,
    nominalAnnualRate: rate, // disclosed as "% p.a., diminishing balance"
    monthlyRate,
    monthlyPayment: customerMonthlyPmt,
    tenor,
  };

  return {
    rtoRate: rate,
    promo,
    promoDiscount,
    discountAmount,
    netDirectPrice,
    dpTotalCharge,
    amountForFinancing,
    customerMonthlyPmt,
    finalPostInstallBalance,
    totalAmountDue,
    summaryTotalDue,
    totalInterest,
    dst,
    isDirectPurchase,
    isFullyPaid,
    disclosure,
    // v3-80 — the DP is now a share of a price that cannot be exceeded, so this
    // can never be true. Kept (always false) so App.jsx's v3-56 tab-gating and
    // PDF-disabling logic stays intact rather than being surgically removed.
    negativeBalance: false,
  };
}

// =============================================================================
// DATA TABLE — Step 3 "Most popular tenors" mini-table
// -----------------------------------------------------------------------------
// Excel CALCULATOR!AF27:AI33 is a 1-variable Excel data table that recomputes
// the model with AH7 substituted by each value in {1, 6, 12, 24, 36, 48, 60}.
// We re-derive that here. It's a small extra cost — recompute the payment
// terms at each tenor.
// =============================================================================

// v3-102 — PROPOSAL_BASE_TENORS / proposalTenorSet / proposalTenorRows deleted:
// their only consumer (the PDF payment-options milestone matrix) was replaced
// by the popularTenorsTable below, so the PDF and the Summary now share one
// comparison with one set of (DST-inclusive) totals.
// v3-118 — Monthly Add-On Rate for the Compare-your-payment-terms table
// (Summary + PDF share this; smoke-asserted). User-CORRECTED formula
// (supersedes the v3-117 TAD-vs-baseline version, which folded DST into the
// rate):
//   ((Monthly_Payment × Tenor − Amount_for_Financing) / Tenor) / Amount_for_Financing
// Monthly_Payment × Tenor = total installments; minus the financed amount =
// pure interest; per month, over the financed principal — the classic
// add-on-rate definition on the LOAN itself. Amount_for_Financing is
// tenor-invariant, so one base serves every row. Direct Purchase (tenor 0)
// is ZERO (user decision C); the guard also covers a 100%-DP quote where
// nothing is financed.
// v3-135 — per-line Direct-Purchase waterfall for the Summary price reveal
// (user-directed five-column view): COGS + Gross Margin + MDR allowance +
// VAT = Direct Purchase Price, EXACTLY. Definitions per the pricing formula:
//   net revenue = DP × (1.12 × (1 − MDR) − 0.12) / 1.12
//   GM ₱        = net revenue − COGS      MDR ₱ = MDR × DP      VAT ₱ = DP × 12/112
// (algebraic identity: the four sum to DP). Display values are rounded to
// whole pesos with the RESIDUAL absorbed by the GM cell, so the printed
// columns also sum exactly. cogs == null (misc lines, rep-entered prices with
// no COGS basis) books the entire net revenue as margin — flagged by
// `cogsKnown: false` so the UI can dash the COGS cell.
export function decomposeDirectPrice(directPrice, cogs, merchantDiscountRate) {
  const dp = Number(directPrice) || 0;
  const m = Number(merchantDiscountRate) || 0;
  const vat = Math.round((dp * VAT_RATE) / (1 + VAT_RATE));
  const mdrAmt = Math.round(dp * m);
  const cogsR = Math.round(cogs ?? 0);
  const dpR = Math.round(dp);
  const gm = dpR - cogsR - mdrAmt - vat; // residual → exact identity
  return { cogs: cogsR, gm, mdrAmt, vat, dp: dpR, cogsKnown: cogs != null };
}

export function monthlyAddOnRate(monthlyPmt, amountForFinancing, tenor) {
  if (!tenor || tenor <= 0) return 0;
  const amt = Number(amountForFinancing);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  return (monthlyPmt * tenor - amt) / tenor / amt;
}

export function popularTenorsTable(state, adminParams, packageData) {
  // v3-80 — mirrors the Excel data table at CALCULATOR!AE20:AH26. For the
  // customer's CHOSEN down payment, recompute the loan at each tenor.
  //
  // Was {tenor, dpAmount, monthlyPmt}. The dpAmount column is dropped: under the
  // loan model the down payment is a share of the Net Price, so it is IDENTICAL
  // at every tenor — a constant column earns no space. `rate` replaces it, and
  // is the more useful number anyway: it is *why* the total climbs with tenor.
  //
  // v3-101 — three user-directed changes vs the workbook's data table:
  //   1. The 1-month row is OUT and Direct Purchase (tenor 0) is IN — the
  //      interest-free option is the comparison that matters, not the oddball
  //      1-month loan.
  //   2. The customer's SELECTED tenor is spliced in (sorted) when it isn't a
  //      base row, so the highlighted "your selection" row always exists.
  //   3. `totalDue` is DST-INCLUSIVE (summaryTotalDue) — the selected row's
  //      total must equal the Summary's TOTAL AMOUNT DUE printed just above
  //      this table (one label, one number). Deliberate deviation from Excel's
  //      AH20:AH27, which exclude DST. DST prorates by tenor, so each row
  //      carries its own figure.
  // v3-154 — 3 and 9 months added at Pat's request, giving customers the two
  // short terms the ladder was missing between Direct Purchase and 12 months.
  // Base set is now NINE rows (ten when a selected tenor outside the set is
  // spliced in). Verified against the PDF's payment-options page, which renders
  // this same array into a hand-laid page with no page-break guard: at 6.4mm
  // per row the two extra rows cost 12.8mm against 85.4mm of measured
  // headroom, so the disclosure block below is never displaced.
  const tenors = [0, 3, 6, 9, 12, 24, 36, 48, 60];
  const sel = state.tenor ?? 0;
  if (!tenors.includes(sel)) tenors.push(sel);
  tenors.sort((a, b) => a - b);
  return tenors.map((t) => {
    const terms = computePaymentTerms(
      { ...state, tenor: t },
      adminParams,
      packageData,
    );
    return {
      tenor: t,
      rate: terms.rtoRate,
      monthlyPmt: terms.customerMonthlyPmt,
      totalDue: terms.summaryTotalDue,
    };
  });
}
