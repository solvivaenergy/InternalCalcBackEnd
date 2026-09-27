// =============================================================================
// PAYOFF PANEL MODEL (v3-192)
// -----------------------------------------------------------------------------
// Shared by the desktop Step 3 graphic and the mobile screen-6 graphic.
//
// WHY THIS IS A MODULE AND NOT DUPLICATED IN THE TWO COMPONENTS.
// The panel makes a CLAIM ABOUT A SIGN — whether the monthly saving rises or
// falls — and that claim is wrong in the obvious formulation. It is NOT "is
// inflation zero"; it is the sign of (1 - degradation)(1 + inflation) - 1,
// which crosses at inflation = degradation/(1-degradation), i.e. 0.5025% at the
// standard 0.5% degradation. A first pass of the desktop panel shipped
// "0.25% outpaces panel ageing, so it climbs" — false, and caught only in
// mockup. Writing that test a second time for mobile is precisely how the two
// surfaces would come to disagree, so it is written once, here, and both
// surfaces render what this returns.
//
// The savings series is read from the ENGINE's own cash-flow rows, never
// re-derived. Re-implementing the AB9:AB37 recurrence would create a second
// definition of the savings curve, free to drift from the one the quote is
// priced on (the v3-181 M8 lesson: a copy of the model is not the model).
// =============================================================================

// Where the combined factor sits close enough to 1 that calling it a rise or a
// fall overstates what the customer will see. At 0.50% the saving moves
// ₱8,800 → ₱8,795 across 25 years; "steady" is the honest word.
const FLAT_BAND = 0.0005;

// The panels are warranted for 25 years. Horizons short of that understate the
// system's life; beyond it the later years are an estimate.
export const WARRANTY_YEARS = 25;

/**
 * @param {object}  a
 * @param {object}  a.state        session state (irrYears, tenor)
 * @param {object}  a.model        the live model (cashFlows, terms)
 * @param {object}  a.adminParams  ADMIN_PARAMS (panelAnnualDegradation)
 * @param {number} [a.maxYears]    cap the horizon — mobile passes 25, because
 *                                 the mobile flow has NO horizon selector and
 *                                 would otherwise inherit a 30-year FinCo
 *                                 default with no way for the customer to
 *                                 shorten it, at which point the bars are an
 *                                 unreadable ~8px block.
 * @returns {object|null} null when there is nothing honest to draw
 */
export function buildPayoffModel({ state, model, adminParams, maxYears }) {
  const cf = model?.cashFlows;
  const rows = cf?.cashflows;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const requested = state?.irrYears ?? WARRANTY_YEARS;
  const years = Math.max(
    1,
    Math.min(rows.length, maxYears || requested, requested),
  );
  const monthlySave = rows.slice(0, years).map((r) => (r?.duSavings ?? 0) / 12);
  if (monthlySave.length === 0) return null;
  if (monthlySave.some((v) => !Number.isFinite(v) || v <= 0)) return null;

  const pmt = Math.round(model?.terms?.customerMonthlyPmt ?? 0);
  const tenor = state?.tenor ?? 0;
  const payYears = tenor / 12;
  const directPurchase = tenor === 0 || pmt <= 0;

  const degradation = adminParams?.panelAnnualDegradation ?? 0;
  const inflation = cf.duRateInflation ?? 0;
  const netFactor = (1 - degradation) * (1 + inflation);

  const degPct = (degradation * 100).toFixed(1);
  const inflPct = (inflation * 100).toFixed(2);
  let direction;
  // v3-194 — "the 0.5% a year the panels age" was an awkward nominalisation and
  // did not say WHAT the 0.5% measures (Pat). It is `panelAnnualDegradation`:
  // the fraction of generation the array loses each year, and the saving falls
  // with it because a panel producing less offsets less of the bill.
  //
  // WORDING IS PAT'S CHOICE (option A of three offered), and it is deliberate
  // in two ways. It reuses "yield", the term the three payback disclaimers on
  // this same screen already use — "the annual reduction in solar yield from
  // panel degradation" — rather than inventing a fourth phrasing for one
  // concept. And it does NOT use the bare word "degradation": that appears in
  // the explanatory disclaimers but has never been in this live sentence, and
  // at this position it is jargon. Built as one clause so all three branches
  // cannot drift apart.
  const degClause = `${degPct}% a year your panels lose in yield`;
  if (Math.abs(netFactor - 1) < FLAT_BAND) {
    direction =
      `holds roughly steady — an assumed ${inflPct}% tariff rise almost exactly ` +
      `offsets the ${degClause}`;
  } else if (netFactor > 1) {
    direction = `climbs — the assumed ${inflPct}% tariff rise outpaces the ${degClause}`;
  } else {
    direction =
      `eases down — an assumed ${inflPct}% tariff rise does not quite offset the ` +
      `${degClause}`;
  }

  const headline = directPurchase
    ? "Nothing to pay after installation"
    : "Your payment stops. Your savings don’t.";
  const subtitle = directPurchase
    ? `Every peso saved is yours from month one. Your monthly bill saving ${direction}.`
    : `Your monthly bill saving ${direction}. Your payment is fixed, and stops after ` +
      `${payYears} year${payYears === 1 ? "" : "s"}.`;

  // const horizonNote = years < WARRANTY_YEARS
  //   ? ` The panels are warranted for ${WARRANTY_YEARS} years, so this period understates the life of the system.`
  //   : years > WARRANTY_YEARS
  //     ? ` Beyond the ${WARRANTY_YEARS}-year warranty the later years are an estimate.`
  //     : '';

  return {
    years,
    monthlySave,
    pmt,
    payYears,
    directPurchase,
    netFactor,
    direction,
    headline,
    subtitle,
    // horizonNote,
    totalOverHorizon: monthlySave.reduce((a, b) => a + b, 0) * 12,
    // The payment exceeds the monthly saving on most down-payment/tenor
    // combinations, so this is the COMMON case and is styled as information
    // rather than as a warning.
    anyShortfall:
      !directPurchase &&
      monthlySave.slice(0, Math.ceil(payYears)).some((v) => v < pmt),
    // v3-197 — the opposite case, for the legend: some year inside the payment
    // window where the saving already covers the payment (the LIGHT amber
    // bars). Same comparison as the bar fill, opposite side, so the legend
    // can name both shades instead of showing one swatch whose colour
    // silently depended on which case happened to exist (user-reported, Pat).
    anySurplus:
      !directPurchase &&
      payYears > 0 &&
      monthlySave.slice(0, Math.ceil(payYears)).some((v) => v >= pmt),
    showEndMarker: !directPurchase && payYears > 0 && payYears < years,
  };
}
