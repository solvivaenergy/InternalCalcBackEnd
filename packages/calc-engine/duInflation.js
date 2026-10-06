// =============================================================================
// DU RATE INFLATION — REFERENCE CALCULATOR (v3-183)
// -----------------------------------------------------------------------------
// Mirrors Meralco_Rate_Inflation.xlsx (uploaded Aug 2026):
//
//   C7:  =RATE(DATEDIF(B3,B4,"m"),,-C3,C4)*12
//   B8:  ="Per Meralco's Rates Archives, the typical Rate @ 500 kWh consumption
//         was "&TEXT(C3,"₱#.0000")&"/kWh in "&TEXT(B3,"mmm-yyyy")&", and "
//         &TEXT(C4,"₱#.0000")&"/kWh in "&TEXT(B4,"mmm-yyyy")&"."
//
// WHY THIS IS ITS OWN MODULE AND NOT PART OF calculations.js.
// Nothing here touches a quote. This derives an ADVISORY figure shown beside
// the Step 4 adjuster; the customer's assumed rate still comes from their own
// stepper, seeded by the FinCo default. Keeping it out of calculations.js
// preserves the byte-identity assertion on that file, which is how every
// release since v3-157 proves the pricing engine did not move. A reference
// calculator living next to PMT() would quietly destroy that signal.
//
// WHAT RATE() ACTUALLY DOES HERE. With pmt omitted, pv = -C3 and fv = C4, it
// solves  C3 * (1 + r)^nper = C4  for the MONTHLY rate r, over nper = the whole
// months between the two dates. The `*12` then annualises it.
//
// ⚠ THAT `*12` IS A NOMINAL ANNUALISATION, NOT AN EFFECTIVE ONE.
// Excel's RATE returns a periodic (monthly) rate; multiplying by 12 gives a
// nominal annual rate that ignores intra-year compounding. The true effective
// annual rate is (1+r)^12 - 1. On the reference figures these are 4.8997% and
// 5.0112% — a real difference, because the calculator's engine applies the
// customer's assumed rate as an EFFECTIVE annual factor (Schedule AB9:AB37
// compounds once per year). Both are returned. The headline shown to admins and
// customers is the NOMINAL one, because that is what the reference file
// computes and this feature exists to restate that file — but the difference is
// surfaced in the admin panel rather than buried, and on the 0.25% customer
// grid both round to the same 5.00% step.
//
// ⚠ CLOSED FORM, NOT EXCEL'S ITERATION. Excel's RATE() is an iterative solver
// with a tolerance; `Math.pow(r2/r1, 1/nper) - 1` is the EXACT solution to the
// same equation. On the reference figures they differ by ~1.8e-10 (Excel:
// 0.048996529269222946, exact: 0.04899652909311669) — eleven orders of
// magnitude below the 2dp the figure is ever displayed at. Reimplementing the
// iteration to reproduce Excel's approximation error would be worse, not more
// faithful.
// =============================================================================

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Dates are stored as 'YYYY-MM' strings — the reference file's cells are the
// 1st of a month displayed as mmm-yy, so month granularity is the real
// precision and a full date would invite a false one.
export function parseYearMonth(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  if (y < 1900 || y > 2999) return null;
  return { y, m: mo };
}

// DATEDIF(a, b, "m") on first-of-month dates is just the whole-month span.
export function monthsBetween(a, b) {
  return (b.y - a.y) * 12 + (b.m - a.m);
}

export function formatMmmYyyy(ym) {
  return ym ? `${MONTH_NAMES[ym.m - 1]}-${ym.y}` : '';
}

/**
 * Mirror of C7. Returns null when the inputs cannot produce a rate, so every
 * caller has exactly one thing to check — an admin mid-edit and an admin who
 * has deliberately blanked the section look the same to the customer surface,
 * which is what we want: no note rather than a broken one.
 */
export function computeDuInflationReference(params) {
  const d1 = parseYearMonth(params?.duInflationDate1);
  const d2 = parseYearMonth(params?.duInflationDate2);
  const r1 = Number(params?.duInflationRate1);
  const r2 = Number(params?.duInflationRate2);

  if (!d1 || !d2) return null;
  if (!Number.isFinite(r1) || !Number.isFinite(r2)) return null;
  if (!(r1 > 0) || !(r2 > 0)) return null;

  const nper = monthsBetween(d1, d2);
  if (!(nper > 0)) return null;

  const monthly   = Math.pow(r2 / r1, 1 / nper) - 1;
  const nominal   = monthly * 12;                  // the reference file's *12
  const effective = Math.pow(1 + monthly, 12) - 1; // true annual compounding
  if (!Number.isFinite(nominal) || !Number.isFinite(effective)) return null;

  return {
    nper,
    years: nper / 12,
    monthly,
    nominal,
    effective,
    totalChange: r2 / r1 - 1,
    d1, d2, r1, r2,
  };
}

/**
 * Mirror of B8. Assembled from the admin fields rather than hardcoded, so a
 * re-base to another utility or another consumption level carries the sentence
 * with it instead of leaving a stale claim on a customer screen.
 */
export function duInflationSentence(params, ref, opts) {
  if (!ref) return '';
  const src   = String(params?.duInflationSourceName || '').trim();
  const basis = String(params?.duInflationBasis || '').trim();
  if (!src || !basis) return '';
  // v3-190 — the PDF's vector pages use jsPDF's core Helvetica, which has NO
  // U+20B1 glyph (see the currency note at the top of pdfGenerator.js); every
  // other peso figure there is written "PHP ". Passing this sentence through
  // unchanged would print a missing-glyph box on an issued proposal. The
  // calculator keeps the real symbol.
  const sym = (opts && opts.currency) || '\u20B1';
  const peso4 = (n) => `${sym}${Number(n).toFixed(4)}`;
  return `Per ${src}, the typical Rate @ ${basis} was `
       + `${peso4(ref.r1)}/kWh in ${formatMmmYyyy(ref.d1)}, and `
       + `${peso4(ref.r2)}/kWh in ${formatMmmYyyy(ref.d2)}.`;
}

// The customer's stepper moves on a 0.25% grid, so the derived rate is almost
// never directly settable. Callers show this alongside the true figure rather
// than instead of it.
export function nearestDuStep(rate, stepBp = 25, maxBp = 1000) {
  const bp = Math.round((rate * 10000) / stepBp) * stepBp;
  return Math.min(maxBp, Math.max(0, bp)) / 10000;
}


/**
 * v3-190 — builds the non-zero DU tariff note for ONE surface.
 *
 * The calculator and the PDF share the first and last sentences and differ only
 * in the middle clause. Both call this rather than each doing its own two-token
 * replace: the v3-181 note-swap already shipped one wiring bug that printed the
 * WRONG note with no error anywhere, and two hand-rolled substitutions are two
 * chances to repeat it. Returns null when no inflated variant is configured,
 * which callers render as "fall back to the flat-rate note".
 *
 * @param {object} disclaimers  DISCLAIMERS, or a live override of it
 * @param {number} rate         the customer's assumed rate, as a fraction
 * @param {'calculator'|'pdf'} surface
 */
export function buildDuTariffNote(disclaimers, rate, surface) {
  const base = disclaimers?.duTariffNoteInflated;
  if (!base || typeof base.rest !== 'string') return null;
  const context = surface === 'pdf'
    ? disclaimers?.duTariffNoteContextPdf
    : disclaimers?.duTariffNoteContextCalculator;
  return {
    ...base,
    rest: base.rest
      .replace('{rate}', `${(Number(rate) * 100).toFixed(2)}%`)
      .replace('{context}', String(context || '').trim()),
  };
}


/**
 * v3-190 — the historical reference disclosure, as ONE string.
 *
 * Step 4 has shown this since v3-183; the PDF now carries it too, so it is
 * assembled here rather than in each surface. NOT hardcoded anywhere: every
 * figure comes from the FinCo reference parameters, which is the whole lesson
 * of v3-189 — prose that names a value which later became a parameter goes
 * stale silently and states a false figure beside a correct one.
 *
 * @param {object} params   ADMIN_PARAMS (or a live override)
 * @param {object} opts     { currency } — pass 'PHP ' for the PDF
 * @returns {string} '' when the FinCo inputs are absent or invalid
 */
export function duInflationReferenceDisclosure(params, opts) {
  const ref = computeDuInflationReference(params);
  if (!ref) return '';
  const sentence = duInflationSentence(params, ref, opts);
  if (!sentence) return '';
  return `${sentence} That works out to about `
       + `${(ref.nominal * 100).toFixed(2)}% a year over ${Math.round(ref.years)} years.`;
}
