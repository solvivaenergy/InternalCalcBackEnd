// =============================================================================
// SCHEDULE — 24-hour energy simulation + investment metrics + payment annex
// -----------------------------------------------------------------------------
// Mirrors:
//   • Excel "Schedule" sheet rows 13–36 (the hourly simulation),
//   • Excel rows 40–47 (LCOE / IRR / DU savings),
//   • Excel "ANNEX" sheet (the 60-month payment schedule with early-payoff
//     amounts and savings-from-early-payoff).
//
// Math summary:
//   - The Excel uses a fixed daily radiance distribution at A55:A66 — 12 ratios
//     summing to 1.0, weighting hours 6 AM through 5 PM. We mirror it here.
//   - For each hour 0..23 we simulate consumption vs solar production. Excess
//     solar charges the battery; battery covers any uncovered consumption;
//     remaining excess (if net-metering enabled) banks credits at the
//     net-metering efficiency rate.
//   - The recommended battery size (Y25) = ROUNDUP(round(G37)/5)*5.
//   - Cash flow table (Y6..AC38) drives IRR, LCOE, and DU savings.
// =============================================================================

import { PV, NPER, IRR, NPV,
         buildPackageLineItems, recommendInverters, availableInverters } from './calculations.js';
// v3-110 — optimizeSystem needs the panel spec (watts, max DC/AC ratio), the
// full inverter tables (cap fallback when every inverter is out of stock),
// and the in-stock battery package list to build its search ladder.
import { PANEL_SETTINGS, INVERTERS_SINGLE_PHASE, INVERTERS_THREE_PHASE } from './data/inventory.js';
import { availableBatteryPackages, optimizeBatteryPackage } from './data/adminParams.js';   // optimizeBatteryPackage: v3-130 mode-'panels' store-all-excess sizing

// ─── Payment due-date helper (Excel ANNEX H column) ──────────────────────────
// Excel formula:
//   IF(DAY(EDATE(installDate, n)) <= 15, DATE(year, month, 15),
//                                        IF(month=Feb, EOMONTH, DATE(year, month, 30)))
// i.e. payments fall on the 15th if the install date's day is ≤15, else end
// of month (Feb has no 30th, so use 28/29). Exported so App.jsx can use it to
// back-derive install date from a minimum-days-to-first-payment floor set by
// the Engineering Admin (ADMIN_PARAMS.minDaysToFirstPostInstallPayment).
export function dueDateForMonth(installationDate, n) {
  // v3-90 — BUG FIX. The old body did:
  //     d.setMonth(d.getMonth() + n);
  // which SILENTLY ROLLS OVER. Install on 30 Jul, ask for payment 7, and JS is
  // asked for "30 Feb" — it hands back 2 MARCH. `day` is then 2, so the `day<=15`
  // branch fired and the payment landed on 15 MARCH: out of order (payment 8 was
  // 30 Mar), 15 days from its neighbour, and February skipped entirely. The
  // February special-case below could never fire because by then the month WAS
  // March. Any install on the 29th-31st hit this.
  //
  // Excel's EDATE does not roll over — it CLAMPS to the target month's last day.
  // So build the target month arithmetically and clamp, exactly as EDATE does:
  //     IF(DAY(EDATE(installDate,n)) <= 15, DATE(y,m,15),
  //                                         IF(m=Feb, EOMONTH, DATE(y,m,30)))
  const src = new Date(installationDate);
  const monthIndex = src.getMonth() + n;
  const year  = src.getFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;

  // Day 0 of the NEXT month === last day of THIS month. Handles Feb 28/29.
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = Math.min(src.getDate(), lastDay);   // EDATE's clamp

  if (day <= 15) return new Date(year, month, 15);
  return new Date(year, month, Math.min(30, lastDay));   // 30th, or EOM in Feb
}

// Convenience: first post-installation payment due date (n=1).
export function firstPostInstallDueDate(installationDate) {
  return dueDateForMonth(installationDate, 1);
}

// ─── Daily radiance distribution (Schedule!A55:A66, B55:B66) ─────────────────
// 12 ratios for hours 6 AM through 5 PM. They sum to 1.0.
// production(hour) = ratio[hour-6] * kWhPerKwpPerDay * systemKwp

const RADIANCE_RATIOS = [
  0.017, 0.049, 0.078, 0.103, 0.121, 0.132,   // 6 AM – 11 AM
  0.132, 0.121, 0.103, 0.078, 0.049, 0.017,   // 12 PM – 5 PM
];

// Formats an hour 0..23 in 12-hour AM/PM style with Filipino conventions
// for the two endpoints, and no spaces:
//   0  → "12MN"  (midnight, not "12 AM")
//   12 → "12NN"  (noon, not "12 PM")
//   1..11  → "1AM"  .. "11AM"
//   13..23 → "1PM"  .. "11PM"
// Exported so other components (e.g. Step 1's device-time dropdown) reuse
// the same labeling and can't drift.
export function formatHour12(h) {
  if (h === 0) return '12MN';
  if (h === 12) return '12NN';
  if (h < 12) return `${h}AM`;
  return `${h - 12}PM`;
}

// ─── Per-device hourly consumption ───────────────────────────────────────────
// To populate the chart we need consumption broken out hour-by-hour, not just
// day-vs-night. Excel Schedule!O13:U36 has one column per device; each cell
// indicates whether device is ON during that hour. We replicate that.

function isOnAtHour(hour, onTime, offTime) {
  // onTime, offTime are fractions of a day (0..1). hour is integer 0..23.
  if (onTime == null || offTime == null) return 0;
  const tFrac = hour / 24;
  if (onTime === offTime) return 1;
  if (offTime > onTime) {
    return (tFrac >= onTime && tFrac < offTime) ? 1 : 0;
  } else {
    return (tFrac >= onTime || tFrac < offTime) ? 1 : 0;
  }
}

/**
 * Build the 24-hour load + production curve.
 * Returns an array of 24 rows, each:
 *   { hour, hourLabel, baseLoad, devicesLoad, totalLoad, solar, excessSolar,
 *     batteryStored, batteryUsed, afterBattery,
 *     creditsStored, creditsUsed, afterCreditsAndBattery }
 *
 * `baseload` is the hourly baseload (kWh) — distributed evenly across 24 hours.
 * `devicesLoad` sums each device's hourly contribution weighted by daysPerWeek.
 */
export function buildHourlyCurve(inputs, adminParams, recommended) {
  const { deviceRows, batteryKwh, netMeteringEnabled } = inputs;

  // ─── Average hourly device consumption (kWh per hour, weighted) ───────────
  // Excel formulas at C13:C36 sum across columns O..U for each hour.
  // Per-device-per-hour kWh = onAtHour * avgKw * (daysPerWeek/7) * count
  //
  // We're computing "average daily" kWh for each hour — this is the value
  // shown in the chart and used to drive the energy-balance simulation.
  const hourlyDevicesLoad = Array(24).fill(0);
  for (const row of deviceRows) {
    if (!row.deviceName || !row.count || row.onTime == null || row.offTime == null) continue;
    const device = inputs.deviceLibrary.find(d => d.name === row.deviceName);
    if (!device) continue;
    const avgKw = device.peakKw * device.dutyFactor;
    const dwFrac = (row.daysPerWeek || 0) / 7;

    // Per-hour avg consumption (kWh) for this device:
    // = isOnAtHour * avgKw * (daysPerWeek/7) * count   (if avgKw is in kW
    //   and we're integrating over 1 hour, kWh = kW * 1 hr)
    for (let h = 0; h < 24; h++) {
      hourlyDevicesLoad[h] += isOnAtHour(h, row.onTime, row.offTime) * avgKw * dwFrac * row.count;
    }
  }

  // ─── Baseload: split CALCULATOR!Q27 evenly across 24 hours ───────────────
  // Excel: B13:B36 = Q27 * 12/365/24  (constant across hours — see B14 = $B$13)
  // i.e. baseload monthly kWh → daily kWh / 24
  const baseloadKwh = recommended.baseloadKwh;
  const baseloadPerHour = baseloadKwh * 12 / 365 / 24;

  // ─── Solar production curve ──────────────────────────────────────────────
  // production at hour h = ratio[h-6] * kWhPerKwpPerDay * systemKwp
  // production at non-daylight hours = 0
  const solarProductionPerHour = Array(24).fill(0);
  const dailyKwhPerKwp = adminParams.kWhPerKwpPerDay;
  for (let h = 6; h <= 17; h++) {
    solarProductionPerHour[h] = RADIANCE_RATIOS[h - 6] * dailyKwhPerKwp * recommended.systemKwp;
  }

  // ─── Energy balance simulation (Schedule!H,I,J,K,L,M columns) ────────────
  // H = battery storage carried over (decrements as it discharges)
  // I = battery used this hour
  // J = grid (distribution utility) consumption after solar+battery
  // K = net-metering credits store
  // L = NM credits used this hour
  // M = grid consumption after solar+battery+NM
  //
  // Excel pattern:
  //   batteryEnergyAvailable (H12) = MIN(totalDailyExcess, batteryCapacity * eff) * dod
  //   creditsAvailable        (K12) = (totalDailyExcess - usableBatteryStored) * netMetEff * netMeteringFlag
  //
  // Then row by row:
  //   H_t = MAX(0, H_{t-1} - (D_t - F_t))           # battery carryover after discharge
  //   I_t = H_{t-1} - H_t                           # battery used this hour
  //   J_t = D_t - F_t - I_t                         # grid use this hour
  //   K_t = MAX(0, K_{t-1} - J_t)
  //   L_t = K_{t-1} - K_t
  //   M_t = J_t - L_t

  const totalLoad = Array(24).fill(0);              // D
  const solarUsed = Array(24).fill(0);              // F = MIN(D, E)
  const excessSolar = Array(24).fill(0);            // G = E - F

  for (let h = 0; h < 24; h++) {
    totalLoad[h] = baseloadPerHour + hourlyDevicesLoad[h];
    solarUsed[h] = Math.min(totalLoad[h], solarProductionPerHour[h]);
    excessSolar[h] = solarProductionPerHour[h] - solarUsed[h];
  }
  const dailyExcessSolar = excessSolar.reduce((s, v) => s + v, 0);

  // Battery configuration
  // Schedule!H12 = MIN(G37, batteryKwh * batteryEfficiency) * batteryDOD
  //   (the usable energy stored each day, capped at daily excess and battery cap)
  const usableBatteryStorage = Math.min(
    dailyExcessSolar,
    (batteryKwh || 0) * adminParams.batteryEfficiency
  ) * adminParams.batteryDepthOfDischarge;

  // Credits: Schedule!K12 = (G37 - H12 / DOD) * netMetEff * netMeteringFlag
  const usableNmCredits = (dailyExcessSolar - usableBatteryStorage / adminParams.batteryDepthOfDischarge)
                        * adminParams.netMeteringEfficiency
                        * (netMeteringEnabled ? 1 : 0);

  // Iterate hours
  const battStored = Array(24).fill(0);
  const battUsed = Array(24).fill(0);
  const afterBatt = Array(24).fill(0);
  const creditsStored = Array(24).fill(0);
  const creditsUsed = Array(24).fill(0);
  const afterCredits = Array(24).fill(0);

  let prevBatt = usableBatteryStorage;
  let prevCredits = usableNmCredits;
  for (let h = 0; h < 24; h++) {
    const uncovered = totalLoad[h] - solarUsed[h];
    const newBatt = Math.max(0, prevBatt - uncovered);
    battStored[h] = newBatt;
    battUsed[h] = prevBatt - newBatt;
    afterBatt[h] = totalLoad[h] - solarUsed[h] - battUsed[h];

    const newCredits = Math.max(0, prevCredits - afterBatt[h]);
    creditsStored[h] = newCredits;
    creditsUsed[h] = prevCredits - newCredits;
    afterCredits[h] = afterBatt[h] - creditsUsed[h];

    prevBatt = newBatt;
    prevCredits = newCredits;
  }

  // Build the 24-row output for the chart
  const rows = [];
  for (let h = 0; h < 24; h++) {
    rows.push({
      hour: h,
      hourLabel: formatHour12(h),
      baseLoad: baseloadPerHour,
      devicesLoad: hourlyDevicesLoad[h],
      totalLoad: totalLoad[h],
      solar: solarProductionPerHour[h],
      solarUsed: solarUsed[h],
      excessSolar: excessSolar[h],
      battStored: battStored[h],
      battUsed: battUsed[h],
      afterBatt: afterBatt[h],
      creditsStored: creditsStored[h],
      creditsUsed: creditsUsed[h],
      afterCredits: afterCredits[h],
    });
  }

  // Daily totals (Schedule!*37)
  const sum = (arr) => arr.reduce((s, v) => s + v, 0);
  const totals = {
    baseload: baseloadPerHour * 24,
    devicesLoad: sum(hourlyDevicesLoad),
    totalLoad: sum(totalLoad),
    solar: sum(solarProductionPerHour),
    solarUsed: sum(solarUsed),
    excessSolar: dailyExcessSolar,
    battUsed: sum(battUsed),
    afterBatt: sum(afterBatt),
    creditsUsed: sum(creditsUsed),
    afterCredits: sum(afterCredits),
  };

  // Coverage percentages (Schedule!F38, I38, L38, F40)
  const solarCoveragePctOfProduction = totals.solar > 0 ? totals.solarUsed / totals.solar : 0;
  const solarCoveragePctOfUse = totals.totalLoad > 0 ? totals.solarUsed / totals.totalLoad : 0;
  const battCoveragePctOfProduction = totals.solar > 0 ? totals.battUsed / totals.solar : 0;
  const creditsCoveragePctOfProduction = totals.solar > 0 ? totals.creditsUsed / totals.solar : 0;

  // Energy use coverage breakdown (Schedule!G57:J61) — for the stacked bar chart
  // Each column is a scenario; rows sum to 1.0:
  //   G = No Solar         [grid=1, solar=0, batt=0, NM=0]
  //   H = Solar Only       [grid=1-F40, solar=F40, batt=0, NM=0]
  //   I = w/ Batteries     [grid=1-F51, solar=F40, batt=F51-F40, NM=0]
  //   J = w/ Batt & NM     [grid=1-F52, solar=F40, batt=F51-F40, NM=F52-F51]
  //
  // F40 = totals.solarUsed / totals.totalLoad = solarCoveragePctOfUse
  // F51 = 1 - (J37 / D37) = 1 - (totals.afterBatt / totals.totalLoad)
  // F52 = 1 - (M37 / D37) = 1 - (totals.afterCredits / totals.totalLoad)
  const F40 = solarCoveragePctOfUse;
  const F51 = totals.totalLoad > 0 ? 1 - totals.afterBatt / totals.totalLoad : 0;
  const F52 = totals.totalLoad > 0 ? 1 - totals.afterCredits / totals.totalLoad : 0;

  const coverageBars = [
    { name: 'No Solar',                  grid: 1,         solar: 0,    battery: 0,            netMetering: 0 },
    { name: 'Solar Only',                grid: 1 - F40,   solar: F40,  battery: 0,            netMetering: 0 },
    { name: 'Solar w/ Batteries',        grid: 1 - F51,   solar: F40,  battery: F51 - F40,    netMetering: 0 },
    { name: 'Solar w/ Batt. & Net Met.', grid: 1 - F52,   solar: F40,  battery: F51 - F40,    netMetering: F52 - F51 },
  ];

  // Daily savings (Schedule!J43, M47, J45, M49)
  // J43 = D37 - J37 = solar+battery savings per day (kWh)
  // J44 = J43 * 365/12 = monthly
  // J45 = ROUND(J44 * utilityRate, -2) = monthly peso savings, rounded to nearest 100
  const dailyKwhSavingsBatt = totals.totalLoad - totals.afterBatt;
  const monthlyKwhSavingsBatt = dailyKwhSavingsBatt * 365 / 12;
  const monthlyPesoSavingsBatt = Math.round(monthlyKwhSavingsBatt * inputs.utilityRate / 100) * 100;

  const dailyKwhSavingsBattNm = totals.totalLoad - totals.afterCredits;
  const monthlyKwhSavingsBattNm = dailyKwhSavingsBattNm * 365 / 12;
  const monthlyPesoSavingsBattNm = Math.round(monthlyKwhSavingsBattNm * inputs.utilityRate / 100) * 100;

  return {
    rows,
    totals,
    solarCoveragePctOfProduction,
    solarCoveragePctOfUse,
    battCoveragePctOfProduction,
    creditsCoveragePctOfProduction,
    coverageBars,
    monthlyPesoSavingsBatt,
    monthlyKwhSavingsBatt,
    monthlyPesoSavingsBattNm,
    monthlyKwhSavingsBattNm,
    incrementalNmSavings: monthlyPesoSavingsBattNm - monthlyPesoSavingsBatt,
  };
}

// ─── Recommended battery size (CALCULATOR Y25) ────────────────────────────────
// Excel: =ROUNDUP(ROUND(Schedule!G37, 0) / unitKwh, 0) * unitKwh
// where G37 = total daily excess solar = the largest battery that's worth
// installing (any bigger and you can't fully charge it from excess).
//
// We need to call buildHourlyCurve with batteryKwh=Infinity (or 0 — same
// result, since usableBatteryStorage just caps at dailyExcessSolar) to get
// the unconstrained daily excess.
//
// v3-54: rounding step became the active package's unit size (not a
// hardcoded 5) — a recommendation is meaningless if it can't be assembled
// from physical packs.

// v3-71: split into two pieces so the battery-package OPTIMIZER can sit
// between them. `batteryDailyExcess` runs the no-battery probe and returns
// the raw excess; App.jsx feeds that to optimizeBatteryPackage() (in
// adminParams.js) to pick the cheapest package, then rounds with
// `roundBatteryKwhToPackage`. The old recommendedBatteryKwh() — which
// resolved the pack from state.batteryPackageId — is gone: the pack is no
// longer an input to the recommendation, it's an OUTPUT of it.

export function batteryDailyExcess(inputs, adminParams, recommended) {
  // Run with no battery to get raw daily excess
  const probeInputs = { ...inputs, batteryKwh: 0, netMeteringEnabled: false };
  const probe = buildHourlyCurve(probeInputs, adminParams, recommended);
  return Math.round(probe.totals.excessSolar);
}

export function roundBatteryKwhToPackage(dailyExcess, pkg) {
  const step = pkg?.batteryUnitKwh || 5;
  return Math.ceil(Math.max(0, dailyExcess || 0) / step) * step;
}

// ─── Cash flow & investment metrics (Schedule!X8:AC38) ────────────────────────
// v3-99 — cash-flow table re-aligned to Solviva_Calc_v_B_5_1.xlsm (Schedule rows
// 8–37, 30 policy years). YEAR 1 (row 8) now bundles: the down payment + the
// first MIN(tenor,12) monthly payments + documentary stamp tax, AND year-1
// maintenance AND year-1 savings — the pre-v5.0 model isolated the down payment
// in a leading "year 0" (no maintenance, no savings) and pushed every payment a
// year later. A Direct Purchase (tenor 0, v3-100) is a single upfront outflow
// (−netDirectPrice) with all later years zero.
//   Year 1  (Y8): DirectPurch → −netDirectPrice; financed → −(DP + first
//                 MIN(tenor,12)·monthly + DST)
//   Year n≥2(Y9): financed → −(remaining months this year · monthly); 0 for DirectPurch
//   MaintCost   = −(perVisit + perPanel·panelCount)·(1 + inflation)^(n−1)
//   DuSavings   = (monthlyPesoSavingsBatt·12)·(1 − degradation)^(n−1)
//   NetCF       = InvPayments + MaintCost + DuSavings

export function computeCashFlows(state, adminParams, schedule, terms, recommended, irrYears) {
  const tenor = state.tenor;
  const customerMonthlyPmt = terms.customerMonthlyPmt;
  const dpTotalCharge = terms.dpTotalCharge;
  const netDirectPrice = terms.netDirectPrice;
  const dst = terms.dst || 0;
  const panelCount = state.panelCount;
  const monthlyDuSavings = schedule.monthlyPesoSavingsBatt;

  const NUM_YEARS = 30; // Schedule rows 8–37 (v5.1) — was 31 (rows 8–38, +year 0) pre-v5.0
  // v3-100 — Direct Purchase is tenor 0 (tenor 1 is a real financed month:
  // its year 1 = DP + 1 monthly + DST via the general branch below).
  const isDirectPurchase = tenor < 1;
  const baseMaint = adminParams.preventiveMaintenancePerVisit
                  + adminParams.preventiveMaintenancePerPanel * panelCount;
  const baseSavings = monthlyDuSavings * 12;
  // v3-181 — DU tariff inflation (Solviva_Calc_v_B_5_3.xlsm CALCULATOR!AF53).
  // Customer-set in Step 4 / the mobile returns view, seeded from the FinCo
  // param `duRateInflationDefault`. Clamped HERE as well as at both input
  // sites: this is the engine's own floor, so a hand-edited sessionStorage
  // record or a stale blob cannot drive a negative rate into the compounding.
  // 0 reproduces every pre-v3-181 figure exactly — see smoke Group 8.
  const duRateInflation = Math.min(0.10, Math.max(0,
    Number.isFinite(state.duRateInflation) ? state.duRateInflation : 0));
  const cashflows = [];

  for (let i = 0; i < NUM_YEARS; i++) {
    // Investment outflow (Y column). Row i (0-based) = policy year i+1.
    const monthsThisYear = Math.min(12, Math.max(0, tenor - 12 * i));
    let invPmts;
    if (isDirectPurchase) {
      invPmts = i === 0 ? -netDirectPrice : 0;                 // Y8 = −AH5, later years 0
    } else {
      invPmts = -monthsThisYear * customerMonthlyPmt;          // Y9+ spread
      if (i === 0) invPmts -= dpTotalCharge + dst;             // Y8 also carries DP + DST
    }
    // Maintenance (Z): base in year 1, inflating thereafter.
    const maintCost = -baseMaint
                    * Math.pow(1 + adminParams.maintenanceInflationRate, i);
    // DU savings (AB): base in year 1; thereafter EACH year multiplies the
    // previous by (1 - degradation) x (1 + duRateInflation), which is
    // Schedule!AB9:AB37 of v_B_5_3 verbatim:
    //     AB(n) = AB(n-1) * (1 - ENGINEERING!B61) * (1 + CALCULATOR!AF53)
    // Year 1 (AB8 = J45*12) carries NO inflation — the rate compounds from
    // year 2, exactly as degradation does. Written as a closed-form power of
    // the COMBINED factor rather than two separate powers: the workbook
    // compounds them together inside one multiplication, and (1-d)^i (1+f)^i
    // is identically ((1-d)(1+f))^i, so this is the same number with one
    // rounding path instead of two.
    const duSavings = baseSavings
                    * Math.pow((1 - adminParams.panelAnnualDegradation)
                               * (1 + duRateInflation), i);
    const totalCost = invPmts + maintCost;
    const netCf = totalCost + duSavings;
    cashflows.push({ year: i + 1, invPmts, maintCost, totalCost, duSavings, netCf });
  }

  // ─── Simple Payback Period (CALCULATOR AH52) ─────────────────────────────
  // Excel: ROUND(NPER(panelDegradationRate/12, J45, Y6, , 1), 0) — rounds
  // months. Then converts to years & months.
  //
  // The Excel inputs are:
  //   rate = annual degradation / 12 (months)
  //   pmt  = J45 = monthly peso savings (positive)
  //   pv   = Y6  = SUM(Y8:Y38) = TOTAL INV PMTS over all 31 simulated years
  //                (the lump-sum debt-equivalent that savings pay down)
  //
  // Y6 is the sum of Y8 (= -dpTotalCharge) plus Y9..Y38 (= -monthlyPmt*12 for
  // years inside the tenor, prorated for partial years). Without partial years
  // it equals -(dpTotalCharge + monthlyPmt * tenor) = -(AH35 in Excel).
  // We compute it identically by summing the cashflow `invPmts` column.
  const totalInvPmts = cashflows.reduce((s, cf) => s + cf.invPmts, 0);  // matches Y6 (NEGATIVE)
  // v3-181 — v_B_5_3 changed X3's rate argument from `ENGINEERING!B61/12` to
  //     (1 - (1 - ENGINEERING!$B$61) * (1 + CALCULATOR!$AF$53)) / 12
  // X3 does not decay the payment stream; it holds J45 flat and uses the rate
  // argument to GROW the balance, so that argument IS the annual net decay.
  // Net decay = 1 - (1-degradation)(1+inflation), i.e. the same combined factor
  // the AB column compounds — NOT (degradation - inflation), which would treat
  // the two as additive and drift from the column at higher rates.
  // At inflation 0 this collapses to `panelAnnualDegradation / 12` exactly, so
  // the payback of every existing quote is unchanged (gate 8.4 pins 92 months
  // on the workbook fixture).
  const paybackNetDecay =
    1 - (1 - adminParams.panelAnnualDegradation) * (1 + duRateInflation);
  const paybackMonths = Math.round(NPER(
    paybackNetDecay / 12,              // annual net decay, monthly
    monthlyDuSavings,                  // pmt = monthly savings (positive)
    totalInvPmts,                      // pv  = total inv pmts (negative)
    0,
    1
  ));
  const paybackYears = Math.floor(paybackMonths / 12);
  const paybackRemMonths = paybackMonths - paybackYears * 12;
  // Use non-breaking hyphens (\u2011) inside "{N}-Year(s)" and "{N}-Month(s)"
  // and a non-breaking space (\u00A0) between "&" and "{N}-Month..." — so when
  // the tile narrows enough to wrap, the ONLY legal break point is before the
  // "&", producing "{N}-Years" / "& {N}-Months" as two unbreakable chunks.
  // A regular hyphen is a valid soft-wrap point in CSS, so without \u2011 the
  // browser would break inside "10-Months" → "10-" / "Months". Visually the
  // \u2011 is indistinguishable from "-". "Years" spelled out (was "Yrs.") for
  // readability in the large-display tile. Singular branches handle "1-Year"
  // vs "N-Years" and "1-Month" vs "N-Months". See HANDOFF v3-36.
  const paybackLabel = !isFinite(paybackMonths)
    ? 'Never breaks even'
    : `${paybackYears}\u2011Year${paybackYears === 1 ? '' : 's'}${paybackRemMonths === 0 ? '' :
        ` &\u00A0${paybackRemMonths}\u2011Month${paybackRemMonths === 1 ? '' : 's'}`}`;

  // ─── IRR over `irrYears` years ────────────────────────────────────────────
  // Excel: AC6 = IRR(OFFSET(AC8, 0, 0, AG54))
  //   where AC8 starts at year 0 and we take `irrYears` rows.
  const irrCashflows = cashflows.slice(0, irrYears).map(cf => cf.netCf);
  const irr = IRR(irrCashflows);

  // ─── LCOE (Schedule!Z45) ────────────────────────────────────────────────
  // Z43 = -(NPV(rate, AA9..AA{8+years}) + AA8)
  //     = -(NPV of {totalCost year 1..N} + totalCost year 0)
  //   (cost is negative, so Z43 ends up positive — total NPV of costs)
  // Z44 = PV(degradation, years, -dailyKwhPerKwp * panelCount-equivalent... )
  //       basically PV of degraded annual energy production
  //   Excel: =PV(C122, Z41, -C53*C119*365)
  //   where C53 = systemKwp, C119 = kWhPerKwpPerDay, Z41 = years
  // Z45 = Z43 / Z44

  const totalCostsForLcoe = cashflows.slice(1, 1 + irrYears).map(cf => cf.totalCost);
  const npvOfCosts = NPV(adminParams.lcoeNpvDiscountRate, totalCostsForLcoe);
  const totalCostNpv = -(npvOfCosts + cashflows[0].totalCost);

  // PV of energy produced over the period, discounted by panel degradation
  const annualProduction = recommended.systemKwp * adminParams.kWhPerKwpPerDay * 365;
  // Excel uses PV(rate, n, -annualProd) which in Excel returns a positive PV
  // because the payment is negative. In our PV() helper this is the same.
  const energyPv = PV(adminParams.panelAnnualDegradation, irrYears, -annualProduction);

  const lcoe = energyPv > 0 ? totalCostNpv / energyPv : 0;

  // ─── Total DU Savings over period (Schedule!Z46, v5.1) ───────────────────
  // v3-99 — v5.1 sums AB8:AB{7+period} (savings begin in YEAR 1 / row 8 = index
  // 0), where pre-v5.0 began at AB9 (index 1). Now that year-1 savings live in
  // cashflows[0], the sum starts at index 0.
  const totalDuSavings = cashflows.slice(0, irrYears).reduce((s, cf) => s + cf.duSavings, 0);

  return {
    cashflows,
    paybackMonths,
    paybackLabel,
    irr,
    lcoe,
    // v3-181 — J45 itself. Step 4 and the mobile view render it as "Estimated
    // Savings per Month"; it is the UNINFLATED base month (AB8 / 12), since
    // the rate compounds only from year 2.
    monthlyDuSavings,
    duRateInflation,
    totalDuSavings,
  };
}

// ─── ANNEX — payment schedule with early-payoff savings ──────────────────────
// 60 rows. For each month n:
//   Min Amount Due = monthly payment if n <= effectiveTenor, else 0
//   Early Payoff Amount = sum from month n+1 to 60, each discounted back to
//                         month n at the early-payoff discount rate (Admin C28 = 8%).
//   Savings from Early Payoff = (sum of remaining min payments) - early payoff amount
//
// Excel formula at G_n: SUM(K_n:BR_n) where K_n = OFFSET($F_n, K$12, 0) / (1+J$12/12)^K$12
//                         and J$12 = 8% (Admin C28).
// In effect: G_n = present value at month n of payments F_(n+1) through F_60, using
// monthly compounding at C28/12. We replicate that.

export function buildAnnex(state, adminParams, terms, installationDate) {
  const { tenor } = state;
  const monthlyPmt = terms.customerMonthlyPmt;
  const epdRate = adminParams.earlyPayoffDiscountRate;  // C28 = 8%
  const monthlyEpd = epdRate / 12;
  // v3-60: the "pay balance via credit card" option (which collapsed the
  // schedule to a single post-install lump payment) was removed, so the
  // effective tenor is always the chosen tenor.
  // v3-82 — at a 100% down payment there is no loan, so there are no monthly
  // rows. Without this the ANNEX prints `tenor` rows of ₱0 into the PDF.
  const effectiveTenor = terms.isFullyPaid ? 0 : tenor;

  // v3-60: credit-card description suffixes removed along with the CC options.
  const dpDescription = 'Upfront Down Payment';
  const directPurchaseDescription = 'Direct Purchase Balance';

  // First, build the 60-row min-amount-due column F
  const minDue = [];
  for (let n = 1; n <= 60; n++) {
    // F = if n <= tenor, monthly payment, else 0
    minDue.push(n <= effectiveTenor ? monthlyPmt : 0);
  }

  // For each row n, compute the early-payoff amount as PV (at month n) of
  // payments minDue[n+1..60], discounted at monthlyEpd per month from each
  // future payment's offset.
  const rows = [];
  // v3-100 — mirrors ANNEX rows 11–12 of Solviva_Calc_v_B_5_1.xlsm exactly
  // (replaces v3-99's combined "DP & DST" signing row, which the workbook does
  // not have):
  //   Row 11 — "Upon Contract Signing": the down payment ALONE (H11 = AH9).
  //   Row 12 — "Upon Installation": for a financed term, the Documentary
  //            Stamp Tax (H12 = AH13); for a Direct Purchase (tenor 0), the
  //            full balance (H12 = AH15-fallback = AH10, D12 = "Direct
  //            Purchase Balance"). Suppressed when the quote is fully paid
  //            (100% DP: no balance, and DST rounds to ₱0).
  const dst = terms.dst || 0;
  const isDirectPurchase = tenor < 1;
  rows.push({
    payment: 'DP',
    dueDate: 'Upon Contract Signing',
    description: dpDescription,
    minDue: terms.dpTotalCharge,
    earlyPayoff: null,
    savings: null,
  });
  if (isDirectPurchase && !terms.isFullyPaid) {
    rows.push({
      payment: '—',
      dueDate: 'Upon Installation',
      description: directPurchaseDescription,
      minDue: terms.finalPostInstallBalance,
      earlyPayoff: null,
      savings: null,
    });
  } else if (dst > 0) {
    rows.push({
      payment: '—',
      dueDate: 'Upon Installation',
      description: 'Documentary Stamp Tax',
      minDue: dst,
      earlyPayoff: null,
      savings: null,
    });
  }

  // Compute due date via the module-level helper (exported for use by App.jsx
  // when back-deriving install date from the admin-tunable
  // minDaysToFirstPostInstallPayment floor).
  const dueDateForMonthLocal = (n) => dueDateForMonth(installationDate, n);

  for (let n = 1; n <= 60; n++) {
    // v3-100 — the tenor-1 "Direct Purchase Balance" special case is gone:
    // tenor 1 is a real 1-month loan (its single payment is the "Final RTO
    // Payment", ANNEX!D13's =F8 branch); the Direct Purchase balance is the
    // "Upon Installation" row above, and tenor 0 produces no numbered rows.
    let description = '';
    if (n < effectiveTenor) description = 'RTO Monthly Payment';
    else if (n === effectiveTenor) description = 'Final RTO Payment';
    else description = '';

    const min = minDue[n - 1];

    // Early payoff: PV at month n of all future payments minDue[n+1 .. 60]
    let payoff = 0;
    for (let k = n; k < 60; k++) {  // k is offset; original Excel runs K..BR (offsets 0..59 of remaining)
      const offset = k - n + 1;
      payoff += minDue[k] / Math.pow(1 + monthlyEpd, offset);
    }

    // Savings = (sum of remaining min dues from this row through 60) - payoff
    // Note Excel uses H_n = SUM(F_n:F_71) - G_n  — so it includes the current
    // row's F_n. We mirror that: savings shown on row n is the cumulative
    // savings if you pay off NOW (at row n's due date), versus continuing.
    const remainingTotal = minDue.slice(n - 1).reduce((s, v) => s + v, 0);
    const savings = remainingTotal - payoff - min;
    // After-row-n payoff: outstanding balance net of the just-paid min. The
    // "Early Payoff Amt on Due Date" in Excel adds the min to payoff (because
    // you pay both this row's min AND the discounted future). Let's match
    // exactly what Excel shows — G_n = SUM(K_n:BR_n), which is PV of
    // F_{n+1}..F_71 (the offsets in K..BR are 0,1,...,59 against F_n).

    rows.push({
      payment: n,
      dueDate: dueDateForMonthLocal(n),
      description,
      minDue: min,
      earlyPayoff: min > 0 ? min + payoff : null,
      savings: min > 0 ? savings : null,
    });
  }

  return {
    rows,
  };
}

// ─── v3-110: Optimization-objective sweep (modes 'battery' | 'cost') ─────────
//
// The Step 2A "Optimize my system for" selector offers three objectives. Mode
// 'panels' (the default) is NOT handled here — it remains the Excel W7 mirror
// (computeRecommendedPanels) plus the v3-71 battery auto-optimizer, preserving
// workbook parity bit-for-bit. This function serves the two NEW modes, which
// have NO workbook counterpart (deferred Excel-sync list):
//
//   'panels'  — v3-130/v3-131: minimum panel count the hourly sim certifies
//               as meeting the target, with the battery chosen STRICT
//               within the ENGINEERING-SET SPILL TOLERANCE (v3-132,
//               `maxDailySpillKwh`, seed 1.0; 0 = the v3-131 strict policy):
//               the cheapest target-meeting rung leaving at most that much
//               raw daily excess unabsorbed — near-zero waste at an honest
//               price, a real comparison basis against 'cost'.
//               Absorb-all is savings-maximal at any array, so min panels
//               under it is the GLOBAL minimum → panels(M1) ≤ panels(M2),
//               panels(M3) holds by construction (smoke-asserted). W7 still
//               feeds Step-1 visuals and floors only.
//   'battery' — lexicographic: minimize battery kWh subject to reaching the
//               target savings, then minimize total direct cost.
//   'cost'    — minimize total direct cost subject to reaching the target,
//               tie-break by fewer panels, then fewer battery units.
//
// DESIGN (user-approved scope, v3-110):
//   • Feasibility oracle = buildHourlyCurve — the same Schedule-sheet mirror
//     that measures savings everywhere else, so the search is workbook-parity
//     AT THE MEASUREMENT LEVEL; only the argmin loop is new logic.
//   • Feasibility is tested on a kWh basis (dailyKwhSavings >= target% ×
//     dailyTotalLoad), deliberately NOT the peso figure (which rounds to the
//     nearest ₱100 and would make feasibility twitch on utility-rate edits).
//     With net metering ON the NM-inclusive savings measure is used — the
//     same figure the UI presents.
//   • Cost = buildPackageLineItems(...).totalDirect at the candidate config
//     with AUTO inverters (recommendInverters) — the honest customer-facing
//     Direct Purchase total, margin curve, cabling tiers, roof/location/RSD
//     surcharges and all.
//   • Panel ceiling (locked decision #5): 3 inverter slots × largest IN-STOCK
//     inverter × maxDcAcRatio. If EVERY inverter is out of stock (a valid
//     v3-106 state — panels-only orders exist), the cap falls back to the
//     largest inverter in the FULL table so the sweep still functions rather
//     than zeroing the array.
//   • Savings are monotonic non-decreasing in panel count for a fixed battery
//     (more solar → solarUsed and excess both non-decreasing → afterBatt /
//     afterCredits non-increasing), so the minimum feasible panel count per
//     battery rung is found by binary search.
//   • Battery rungs: a no-battery rung plus, per in-stock package, unit
//     counts 1..ceil(excessAtPanelCap / unitKwh) — a battery bigger than the
//     largest possible daily excess can never fully charge, so larger rungs
//     are dominated and skipped. Hard guard at 60 units.
//   • INFEASIBLE TARGET (locked decision A): when no config inside the cap
//     reaches the target, the constraint is dropped and the sweep returns the
//     savings-MAXIMIZING config (tie-broken by the mode's own objective) with
//     feasible:false and achievedPct for the amber notice + PDF caveat.
//
// opts:
//   fixedPanelCount  — pin the array (rep panel override); the sweep only
//                      chooses the battery. Mirrors how the v3-71 pipeline's
//                      excess probe follows an overridden array.
//   restrictPackageId — confine the ladder to one package (rep package pick);
//                      yields the "recommended value on the active ladder"
//                      (activeRecBatteryKwh semantics).
export function optimizeSystem(mode, inputs, adminParams, recommended, opts = {}) {
  const phase = inputs.phase === 'three' ? 'three' : 'single';
  const ps = phase === 'three' ? PANEL_SETTINGS.threePhase : PANEL_SETTINGS.singlePhase;
  const panelWatts = ps.panelWatts;
  const nm = !!inputs.netMeteringEnabled;

  // v3-136 — CORNER-DAY CERTIFICATION ("Size panels for peaks and batteries
  // for valleys"). buildHourlyCurve weights every device by daysPerWeek/7 —
  // an AVERAGE-week day. For profiles with sub-7-day devices that average day
  // never actually occurs, and certifying against it makes two claims false:
  // a savings target is missed on the days the appliances run (at a 100%
  // target this is structural — the daily cap means light-day surplus can
  // never offset appliance-day shortfall), and Mode 1's absorb-all battery
  // spills past maxDailySpillKwh on the days they don't. With
  // opts.conservative, certification moves to the honest corner days, built
  // from the SAME 24-hour engine with modified day-weights:
  //   • PEAK day  (all devices at 7/7)          → savings/target feasibility.
  //     Meeting the target on the max-load day implies meeting it on every
  //     lighter day (production and storage are unchanged while the load
  //     shrinks), so "meets N%" becomes true for the whole week.
  //   • VALLEY day (sub-7-day devices at 0)     → raw-excess measurement for
  //     Mode 1's absorb-all pool and the ladder ceiling. Zeroing night-only
  //     devices is a no-op on excess (excess is hourly solar − load during
  //     daylight), so one uniform rule covers daytime and night devices.
  // Without the flag — or with no sub-7-day device, where the corners equal
  // the average day — both curves are the average day and the path is
  // BIT-IDENTICAL to v3-135.
  // v3-137 (user-reported via screenshot): "sub-7-day" means daysPerWeek
  // 1–6, NOT null/0. An unset or 0-day row contributes ZERO load to the real
  // week (dwFrac 0 in buildHourlyCurve), so it must neither activate the
  // corners nor be promoted to 7/7 on the peak day — the old `< 7` predicate
  // did both, sizing against a device that never runs.
  const rowsIn = inputs.deviceRows || [];
  const isSub7Row = r =>
    r && r.deviceName && r.count && r.onTime != null && r.offTime != null
      && (r.daysPerWeek || 0) >= 1 && (r.daysPerWeek || 0) < 7;
  const sub7Active = !!opts.conservative && rowsIn.some(isSub7Row);
  const peakRows = sub7Active
    ? rowsIn.map(r => isSub7Row(r) ? { ...r, daysPerWeek: 7 } : r)
    : rowsIn;
  const valleyRows = sub7Active
    ? rowsIn.map(r => isSub7Row(r) ? { ...r, daysPerWeek: 0 } : r)
    : rowsIn;

  const simulate = (panelCount, batteryKwh) => {
    const rec = { ...recommended,
                  systemKwp: panelCount * panelWatts / 1000,
                  recommendedPanelCount: panelCount };
    const curve = buildHourlyCurve(
      { ...inputs, deviceRows: peakRows, batteryKwh, netMeteringEnabled: nm },
      adminParams, rec);
    const t = curve.totals;
    // Raw excess is measured on the VALLEY day under conservative sizing —
    // the maximum-excess day the battery must absorb. One extra cheap sim
    // per call, only when the flag is live.
    let excess = t.excessSolar;
    if (sub7Active) {
      const vCurve = buildHourlyCurve(
        { ...inputs, deviceRows: valleyRows, batteryKwh, netMeteringEnabled: nm },
        adminParams, rec);
      excess = vCurve.totals.excessSolar;
    }
    return {
      savings: nm ? (t.totalLoad - t.afterCredits) : (t.totalLoad - t.afterBatt),
      totalLoad: t.totalLoad,
      excess,
    };
  };

  // ── Panel ceiling ──────────────────────────────────────────────────────────
  const inStockInverters = availableInverters(phase);
  const fullTable = phase === 'three' ? INVERTERS_THREE_PHASE : INVERTERS_SINGLE_PHASE;
  const largestKw = inStockInverters.length > 0
    ? inStockInverters[0].ratedKw
    : Math.max(0, ...fullTable.map(i => i.ratedKw || 0));
  const panelCap = Math.max(1, Math.floor(3 * largestKw * ps.maxDcAcRatio * 1000 / panelWatts));
  const fixed = opts.fixedPanelCount != null ? Math.max(0, opts.fixedPanelCount) : null;
  // Quote-Limits floor (v3-68) applies to recommendations; a fixed override
  // bypasses it exactly as the live pipeline does (panelCount === 0 exempt).
  const floor = Math.min(panelCap, Math.max(1, recommended.minPanelsFloor || 0));

  // ── Target ─────────────────────────────────────────────────────────────────
  const probe = simulate(fixed != null ? fixed : floor, 0);
  const totalLoad = probe.totalLoad;
  const targetKwh = (inputs.desiredSavingsPct || 0) * totalLoad;
  if (targetKwh <= 1e-9) {
    // Degenerate: nothing to save. Fewest of everything that's legal.
    const panels = fixed != null ? fixed : (recommended.minPanelsFloor > 0 ? floor : 0);
    return { mode, feasible: true, panelCount: panels, batteryPackage: null,
             batteryUnits: 0, batteryKwh: 0,
             cost: costOf(panels, { pkg: null, units: 0, kwh: 0 }),
             achievedSavingsKwhPerDay: 0, achievedPct: 0,
             targetPct: inputs.desiredSavingsPct || 0, panelCap };
  }

  // ── Battery ladder ─────────────────────────────────────────────────────────
  const inStockPkgs = availableBatteryPackages(adminParams);
  const packages = opts.restrictPackageId
    ? inStockPkgs.filter(p => p.id === opts.restrictPackageId)
    : inStockPkgs;
  const excessAtMax = simulate(fixed != null ? fixed : panelCap, 0).excess;
  const rungs = [{ pkg: null, units: 0, kwh: 0 }];
  for (const pkg of packages) {
    const unit = pkg.batteryUnitKwh || 1;
    const maxUnits = Math.min(60, Math.max(0, Math.ceil(excessAtMax / unit)));
    for (let u = 1; u <= maxUnits; u++) rungs.push({ pkg, units: u, kwh: u * unit });
  }

  // ── Cost function ──────────────────────────────────────────────────────────
  function costOf(panelCount, rung) {
    const kwp = panelCount * panelWatts / 1000;
    const st = { ...inputs,
                 panelCount,
                 selectedInverters: recommendInverters(kwp, phase),
                 batteryKwh: rung.kwh,
                 batteryPackageId: rung.pkg ? rung.pkg.id : null };
    return buildPackageLineItems(st, adminParams, null).totalDirect;
  }

  // ── Mode 'panels' (v3-130, corrected): GLOBAL-minimum sim-certified array ──
  // Feasibility per candidate array = the LARGEST ladder rung (battery savings
  // are monotone in capacity), giving the true global panel minimum — so
  // panels(M1) <= panels(M2), panels(M3) holds by construction. The battery at
  // the chosen array starts from the v3-71 PIPELINE recommendation
  // (batteryDailyExcess → optimizer → package rounding — preserving today's
  // outputs everywhere it suffices) and steps UP the ladder only when the
  // workbook's excess rounding leaves that rec short of target at a package
  // boundary (raw 10.03 → rounded 10 → 9.5 usable < 10.03; caught by the
  // smoke's re-verification assert). Among sufficient rungs: min cost, then
  // min kWh.
  if (mode === 'panels') {
    // v3-132 — SPILL TOLERANCE (user reversal of v3-131's strict absorb-all):
    // the battery must leave at most `maxDailySpillKwh` of RAW daily excess
    // unabsorbed (kwh × batteryEfficiency + tolerance >= raw). 0 = strict.
    // Seeded 1.0 → the default quote's 0.69 kWh/day spill is tolerated and
    // the flagship default stays 1×5 / Std ₱537,168.04 (v3-131's +₱85,564
    // step-up reverted before any customer saw it).
    const rawExcessAt = (panelCount) => simulate(panelCount, 0).excess;
    const spillTol = Math.max(0, Number(adminParams.maxDailySpillKwh) || 0);
    // Certify under the largest rung — the absorb-all battery is savings-
    // maximal at any array (extra capacity beyond the excess adds nothing),
    // so max-rung feasibility == absorb-all feasibility and the search still
    // returns the GLOBAL panel minimum (theorem preserved).
    const maxKwh = rungs.reduce((mx, r) => Math.max(mx, r.kwh), 0);
    const feasAt = (panelCount) =>
      simulate(panelCount, maxKwh).savings + 1e-9 >= targetKwh;
    const eff = adminParams.batteryEfficiency || 1;
    const pickBattery = (panelCount, requireTarget) => {
      const raw = rawExcessAt(panelCount);
      // Rungs whose spill (raw − usable) is inside the tolerance; if the
      // ladder can't reach even at max, fall back to the max-absorption
      // rung(s). Among tolerated rungs, ones MEETING THE TARGET take
      // priority (a large tolerance must not let "cheapest" collapse to a
      // no-battery config the certification never blessed); then min cost,
      // tie min kWh.
      const tolerated = rungs.filter(r => r.kwh * eff + spillTol + 1e-9 >= raw);
      const pool0 = tolerated.length > 0
        ? tolerated
        : (() => {
            const mx = rungs.reduce((m, r) => Math.max(m, r.kwh), 0);
            return rungs.filter(r => r.kwh === mx);
          })();
      const cands = pool0.map(r => ({ r, savings: simulate(panelCount, r.kwh).savings }));
      const meeting = cands.filter(c => c.savings + 1e-9 >= targetKwh);
      if (requireTarget && meeting.length === 0) return null;
      let pool = meeting.length > 0 ? meeting : (() => {
        const mx = Math.max(...cands.map(c => c.savings));
        return cands.filter(c => c.savings >= mx - 1e-9);
      })();
      pool = pool.map(c => ({ ...c, cost: costOf(panelCount, c.r) }));
      let b = pool[0];
      for (const c of pool.slice(1)) {
        if (c.cost < b.cost || (c.cost === b.cost && c.r.kwh < b.r.kwh)) b = c;
      }
      return b;
    };
    const result = (panelCount, feasibleFlag) => {
      const b = pickBattery(panelCount, false);
      return { mode, feasible: feasibleFlag,
               panelCount,
               batteryPackage: b.r.kwh > 0 ? b.r.pkg : null,
               batteryUnits: b.r.units,
               batteryKwh: b.r.kwh,
               cost: b.cost,
               achievedSavingsKwhPerDay: b.savings,
               achievedPct: totalLoad > 0 ? b.savings / totalLoad : 0,
               targetPct: inputs.desiredSavingsPct || 0,
               panelCap };
    };
    if (fixed != null) {
      const b = pickBattery(fixed, true);
      return result(fixed, b != null);
    }
    if (!feasAt(panelCap)) {
      // Infeasible inside the cap → best-achievable at the cap (decision A);
      // this also RESOLVES the v3-110 disclosed asymmetry — mode 'panels' can
      // now fire the amber notice like the other modes.
      return result(panelCap, false);
    }
    let lo = floor, hi = panelCap;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (feasAt(mid)) hi = mid;
      else lo = mid + 1;
    }
    return result(lo, true);
  }

  // ── Per-rung search ────────────────────────────────────────────────────────
  const feasibleCands = [];
  const infeasibleCands = [];
  for (const rung of rungs) {
    if (fixed != null) {
      const s = simulate(fixed, rung.kwh);
      (s.savings + 1e-9 >= targetKwh ? feasibleCands : infeasibleCands)
        .push({ rung, panels: fixed, savings: s.savings });
      continue;
    }
    const atCap = simulate(panelCap, rung.kwh);
    if (atCap.savings + 1e-9 < targetKwh) {
      infeasibleCands.push({ rung, panels: panelCap, savings: atCap.savings });
      continue;
    }
    let lo = floor, hi = panelCap;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (simulate(mid, rung.kwh).savings + 1e-9 >= targetKwh) hi = mid;
      else lo = mid + 1;
    }
    feasibleCands.push({ rung, panels: lo, savings: simulate(lo, rung.kwh).savings });
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  let pool, feasible;
  if (feasibleCands.length > 0) {
    pool = feasibleCands;
    feasible = true;
  } else {
    const maxS = Math.max(...infeasibleCands.map(c => c.savings));
    pool = infeasibleCands.filter(c => c.savings >= maxS - 1e-9);
    feasible = false;
  }
  pool = pool.map(c => ({ ...c, cost: costOf(c.panels, c.rung) }));

  const better = (a, b) => {
    if (mode === 'battery') {
      if (a.rung.kwh !== b.rung.kwh) return a.rung.kwh < b.rung.kwh;
      if (a.cost !== b.cost) return a.cost < b.cost;
    } else {
      if (a.cost !== b.cost) return a.cost < b.cost;
      if (a.panels !== b.panels) return a.panels < b.panels;
      if (a.rung.units !== b.rung.units) return a.rung.units < b.rung.units;
    }
    if (a.panels !== b.panels) return a.panels < b.panels;      // stability
    if (a.rung.units !== b.rung.units) return a.rung.units < b.rung.units;
    return false;
  };
  let best = pool[0];
  for (let i = 1; i < pool.length; i++) if (better(pool[i], best)) best = pool[i];

  return {
    mode, feasible,
    panelCount: best.panels,
    batteryPackage: best.rung.pkg,
    batteryUnits: best.rung.units,
    batteryKwh: best.rung.kwh,
    cost: best.cost,
    achievedSavingsKwhPerDay: best.savings,
    achievedPct: totalLoad > 0 ? best.savings / totalLoad : 0,
    targetPct: inputs.desiredSavingsPct || 0,
    panelCap,
  };
}
