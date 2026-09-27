// =============================================================================
// PROPOSAL — the one place that turns calculator inputs into a priced proposal
// -----------------------------------------------------------------------------
// This is App.jsx's model memo, lifted out verbatim on 2026-09-27 so the same
// pipeline can run outside React: the browser calls computeProposal() from the
// memo, and the backend can call it for a public estimate. Nothing here reads
// React, the DOM, Vite or the network; the live parameters arrive through the
// engine's module objects (ADMIN_PARAMS, DEVICES, the inverter lists), which
// paramsService (browser) or runtime.js applyRuntime() (Node) fill in.
//
// The comments inside computeProposal are the memo's own history (v3-71 …
// v3-175); they explain WHY each step exists and are kept on purpose.
// =============================================================================

import { ADMIN_PARAMS, optimizeBatteryPackage, availableBatteryPackages,
         availableDeliveryLocations } from './data/adminParams.js';
import { DEVICES } from './data/devices.js';
import {
  computeRecommendedPanels, recommendInverters, buildPackageLineItems,
  computePaymentTerms, popularTenorsTable, systemSizing,
  availableInverters,
} from './calculations.js';
import {
  buildHourlyCurve, batteryDailyExcess, roundBatteryKwhToPackage,
  computeCashFlows, buildAnnex,
  firstPostInstallDueDate, optimizeSystem,
} from './schedule.js';

// Back-derive the installation date from an issue date: seed at +14 days, then
// walk forward until the first post-install due date clears the minimum-days
// floor. Bounded as a guard against a non-numeric param.
//
// Shared by the model memo and handleGeneratePdf. The memo is keyed on
// generatedDate, so a PDF stamped with a FRESH issue date must re-derive this
// against that date — otherwise it prints a new "Date Issued" beside a payment
// schedule still anchored to the tab-session date.
export function deriveInstallDate(anchorDate) {
  const minDays = ADMIN_PARAMS.minDaysToFirstPostInstallPayment ?? 44;
  const targetFirstPaymentMs = anchorDate.getTime() + minDays * 86400000;
  const installDate = new Date(anchorDate);
  installDate.setDate(installDate.getDate() + 14);  // seed: prior hardcoded value
  for (let guard = 0; guard < 200; guard++) {
    const candidateFirst = firstPostInstallDueDate(installDate);
    if (candidateFirst.getTime() >= targetFirstPaymentMs) break;
    installDate.setDate(installDate.getDate() + 1);
  }
  return installDate;
}

// `state` is the calculator's Step 1–4 state (App.jsx makeInitialState shape);
// `generatedDate` is the quote's issue date, which anchors the install date
// and the payment annex. Returns the model object the tabs and the PDF read.
export function computeProposal(state, generatedDate) {
    const phase = state.phase === 3 ? 'three' : 'single';
    // v3-106 — availability forcing happens HERE, at the top of the model,
    // so every downstream consumer (pricing, schedule, annex, PDF, lead
    // payload) inherits it from one place:
    //   • RSD out of stock  → rsdEnabled forced OFF in the pricing inputs
    //     (a stale session's true can't price an unavailable device).
    //   • Panels out of stock (per phase) → recommendedPanelCount is already
    //     0 from computeRecommendedPanels; the rep's panelCount override is
    //     ALSO ignored (forced 0) below.
    //   • Batteries all out of stock → batteryKwh forced 0 below.
    const rsdInStock = ADMIN_PARAMS.rsdAvailable !== false;
    // v3-116 — a persisted session may hold a delivery-location id that has
    // since been deleted or marked out of stock. Force it back to 'luzon'
    // (v3-106 "availability never blocks the flow") so pricing, Summary, PDF
    // and the lead payload never see a dead id; the 2E Select then shows
    // Luzon main island with its region/city cascade.
    const effectiveLocation =
      state.location === 'luzon' || state.location === 'other'
        ? state.location
        : (availableDeliveryLocations(ADMIN_PARAMS).some(l => l.id === state.location)
            ? state.location : 'luzon');
    const inputs = { ...state, phase, deviceLibrary: DEVICES,
                     location: effectiveLocation,
                     rsdEnabled: rsdInStock ? state.rsdEnabled : false };
    const recommended = computeRecommendedPanels(inputs, ADMIN_PARAMS);
    const panelsAvailable = recommended.panelsAvailable !== false;
    // v3-110 — Step 2A optimization objective. 'panels' (default) keeps the
    // v3-109 pipeline BYTE-IDENTICAL: recommendation = W7 (workbook parity)
    // + the v3-71 battery auto-optimizer, untouched below. 'battery' / 'cost'
    // derive the recommendation from the optimizeSystem sweep instead. With
    // panels out of stock every mode collapses to the v3-106 zero-array path
    // (a sweep over a forced-0 array is meaningless), so sweepActive gates on
    // panelsAvailable.
    const optimizationMode =
      state.optimizationMode === 'battery' || state.optimizationMode === 'cost'
        ? state.optimizationMode : 'panels';
    // v3-130 — EVERY mode's recommendation now comes from the sweep. Mode
    // 'panels' is the sim-certified minimum array with store-all-excess
    // battery (user decision (a), reversing v3-110's "Mode 1 = W7"); W7
    // remains the panels-out-of-stock fallback and everything else it feeds.
    const sweepActive = panelsAvailable;
    // v3-136 — peaks-and-valleys sizing. hasSub7Device mirrors
    // buildHourlyCurve's row-validity gate (name + count + both times) so the
    // checkbox never renders for a row the sim would skip anyway.
    // conservativeLocked = Variant B: at a 100% target with a sub-7-day
    // device, conservative certification is FORCED — an average-week system
    // cannot deliver a true 100% (the daily cap stops light-day surplus from
    // offsetting appliance-day shortfall), so that claim must not be
    // quotable. The user's own checkbox choice is preserved in state and
    // restored when the lock releases.
    const hasSub7Device = (state.deviceRows || []).some(r =>
      r && r.deviceName && r.count && r.onTime != null && r.offTime != null
        // v3-137 — 1–6 days only: an unset/0-day row contributes zero load
        // (dwFrac 0), so it must not summon the checkbox/caveat (user-
        // reported: a fresh row with days/wk "—" fired the control).
        && (r.daysPerWeek || 0) >= 1 && (r.daysPerWeek || 0) < 7);
    const conservativeLocked =
      hasSub7Device && (state.desiredSavingsPct || 0) >= 1 - 1e-9;
    const conservativeSizing =
      hasSub7Device && (conservativeLocked || !!state.conservativeSizing);
    const recSweep = sweepActive
      ? optimizeSystem(optimizationMode, inputs, ADMIN_PARAMS, recommended,
                       { conservative: conservativeSizing })
      : null;
    const recPanelCount = recSweep ? recSweep.panelCount
                                   : recommended.recommendedPanelCount;
    const panelCount = panelsAvailable ? (state.panelCount ?? recPanelCount) : 0;
    const systemKwp = panelCount * recommended.panelWatts / 1000;
    const recInverters = recommendInverters(systemKwp, phase);
    // v3-106 — a persisted session may hold an inverter pick that has since
    // gone out of stock. State stores a COPY of the inverter object, so its
    // own `available` field is stale; match by ratedKw against the LIVE
    // in-stock list instead, and fall back to the slot's recommendation.
    const inStockKw = new Set(availableInverters(phase).map(i => i.ratedKw));
    // v3-175 — a panels-only EXPANSION order carries no inverter at all: the
    // three slots are forced empty regardless of any earlier pick, so the
    // quote can never price an inverter the customer told us they don't need.
    // This is a FLAG, not a per-slot null — null already means "use the
    // recommendation" (the fallback below), which is precisely why "— None —"
    // in the 2C dropdown could never zero a slot before this release.
    const expansionActive = !!state.expansionMode
      && (state.existingKwp || 0) > 0 && panelCount > 0;
    const effectiveInverters = expansionActive
      ? [null, null, null]
      : state.selectedInverters.map((sel, i) => {
          const chosen = sel ?? recInverters[i] ?? null;
          return (chosen && !inStockKw.has(chosen.ratedKw))
            ? (recInverters[i] ?? null)
            : chosen;
        });
    const sizing = systemSizing(panelCount, recommended.panelWatts, effectiveInverters, phase);
    const recommendedObj = { ...recommended, systemKwp, recommendedPanelCount: recPanelCount };
    const stateForBattRec = { ...inputs, panelCount, selectedInverters: effectiveInverters, batteryKwh: 0 };
    // v3-71: the battery package is now an OUTPUT of the recommendation, not
    // an input to it. Pipeline:
    //   1. Probe the hourly curve with no battery → raw daily excess solar.
    //   2. optimizeBatteryPackage() picks the package that stores ALL of
    //      that excess at the lowest total cost (units + racks + ATS +
    //      critical-loads + labor; labor branch follows hasSolar).
    //   3. recBatteryKwh = excess rounded UP to the AUTO winner's unit size
    //      — this is what the Recommended tile displays, pinned to the
    //      optimizer regardless of any rep package override.
    //   4. activeBatteryPackage = the rep's explicit pick (if any and still
    //      existing — a deleted id silently falls back to auto) else the
    //      auto winner. Pricing, the kWh ladder, and the annex all follow
    //      the ACTIVE package.
    //   5. activeRecBatteryKwh = excess re-rounded to the ACTIVE package's
    //      unit size — the "recommended value on the active ladder". It's
    //      what state.batteryKwh === null falls back to, and what the
    //      Selected tile's override/amber/snap-back logic compares against
    //      (recBatteryKwh may not exist on an overridden pack's ladder).
    // v3-106 — the optimizer + resolver already skip out-of-stock packages;
    // here we (a) require an explicit rep pick to still be IN STOCK (else it
    // silently falls back to auto, same as a deleted id), and (b) force
    // batteryKwh to 0 when EVERY package is out of stock so the placeholder
    // package's prices never reach a line item.
    const inStockBatteryPackages = availableBatteryPackages(ADMIN_PARAMS);
    const anyBatteryInStock = inStockBatteryPackages.length > 0;
    const explicitBatteryPackage = state.batteryPackageId
      ? inStockBatteryPackages.find(p => p.id === state.batteryPackageId) || null
      : null;
    let autoBatteryPackage, recBatteryKwh, activeBatteryPackage,
        activeRecBatteryKwh, batteryKwh, optimization;
    if (!sweepActive) {
      // ── Panels-out-of-stock ONLY (v3-130): every in-stock mode now takes
      //    its recommendation — battery included — from the sweep branch
      //    below, so Mode 1's certified config is exactly what the quote
      //    prices (the v3-71 recomputation could round a boundary-case
      //    battery below what the certification used).
      const dailyExcess = batteryDailyExcess(stateForBattRec, ADMIN_PARAMS, recommendedObj);
      autoBatteryPackage = optimizeBatteryPackage(ADMIN_PARAMS, dailyExcess, panelCount > 0);
      recBatteryKwh = anyBatteryInStock
        ? roundBatteryKwhToPackage(dailyExcess, autoBatteryPackage)
        : 0;
      activeBatteryPackage = explicitBatteryPackage || autoBatteryPackage;
      activeRecBatteryKwh = explicitBatteryPackage
        ? roundBatteryKwhToPackage(dailyExcess, activeBatteryPackage)
        : recBatteryKwh;
      batteryKwh = anyBatteryInStock ? (state.batteryKwh ?? activeRecBatteryKwh) : 0;
      optimization = { mode: 'panels', feasible: true, achievedPct: null,
                       targetPct: state.desiredSavingsPct };
    } else {
      // ── v3-130: ALL in-stock modes route here. 'battery'/'cost' size the
      //    battery to the TARGET; 'panels' starts from the v3-71 store-all-
      //    excess rec and steps up only at rounding boundaries — the sweep's
      //    certified config IS the recommendation, battery included.
      autoBatteryPackage = recSweep.batteryPackage
        || optimizeBatteryPackage(ADMIN_PARAMS, 0, panelCount > 0);
      recBatteryKwh = anyBatteryInStock ? recSweep.batteryKwh : 0;
      // Active recommendation adapts to live overrides — a pinned array
      // (panel override) and/or a pinned package — mirroring how the
      // mode-'panels' excess probe follows the overridden array. Re-running
      // the sweep constrained yields the recommended kWh ON THE ACTIVE
      // LADDER (activeRecBatteryKwh semantics, v3-71).
      const constrained = (panelsAvailable && state.panelCount != null)
        || explicitBatteryPackage != null;
      const activeSweep = constrained
        ? optimizeSystem(optimizationMode, inputs, ADMIN_PARAMS, recommended, {
            fixedPanelCount: (panelsAvailable && state.panelCount != null) ? panelCount : null,
            restrictPackageId: explicitBatteryPackage ? explicitBatteryPackage.id : null,
            conservative: conservativeSizing,   // v3-136 — overrides certify at the same corner
          })
        : recSweep;
      activeBatteryPackage = explicitBatteryPackage
        || activeSweep.batteryPackage
        || autoBatteryPackage;
      activeRecBatteryKwh = anyBatteryInStock ? activeSweep.batteryKwh : 0;
      batteryKwh = anyBatteryInStock ? (state.batteryKwh ?? activeRecBatteryKwh) : 0;
      // The amber notice + PDF caveat read the UNCONSTRAINED sweep — the
      // recommendation's own feasibility, not an override's.
      optimization = { mode: optimizationMode, feasible: recSweep.feasible,
                       achievedPct: recSweep.achievedPct,
                       targetPct: recSweep.targetPct };
    }
    // fullState carries the RESOLVED package id so the calc chain
    // (calculations.js resolveBatteryPackage call sites) prices the auto
    // winner without knowing the optimizer exists. Downstream consumers
    // never see a null batteryPackageId.
    const fullState = { ...inputs, panelCount, selectedInverters: effectiveInverters, batteryKwh,
                        batteryPackageId: activeBatteryPackage.id };
    const pkg = buildPackageLineItems(fullState, ADMIN_PARAMS, null);
    const terms = computePaymentTerms(fullState, ADMIN_PARAMS, pkg);
    // v3-100 — Direct Purchase IS a separate option now (v5.1 split it from the
    // 1-month tenor): tenor 0, 0% interest, no DST, balance due in full upon
    // installation. Lili's "%" column stays % of the NET PRICE; the two
    // milestones are the DP at signing and the balance upon installation.
    const dpTerms = computePaymentTerms({ ...fullState, tenor: 0 }, ADMIN_PARAMS, pkg);
    const directPurchase = {
      dpPct: fullState.downPaymentPct,
      dpAmount: dpTerms.dpTotalCharge,
      monthly: dpTerms.customerMonthlyPmt,
      total: dpTerms.summaryTotalDue,   // = totalAmountDue for a Direct Purchase (dst 0)
      rate: dpTerms.rtoRate,
      financeCharge: dpTerms.totalInterest,
    };
    const popularTenors = popularTenorsTable(fullState, ADMIN_PARAMS, pkg);
    const schedule = buildHourlyCurve(fullState, ADMIN_PARAMS, recommendedObj);
    const cashFlows = computeCashFlows(fullState, ADMIN_PARAMS, schedule, terms,
                                       recommendedObj, state.irrYears);
    // Install date is back-derived so the first post-installation payment
    // due date falls at least `minDaysToFirstPostInstallPayment` days after
    // the quote's generation date. Engineering Admin tunes this floor based
    // on Solviva's installation queue + capacity. The 15th/30th payment
    // rounding rule in buildAnnex's dueDateForMonth() can shift first-payment
    // by a few days depending on the calendar, so we walk install date
    // forward one day at a time until the rounded first-payment date clears
    // the threshold. Bounded by max+1 days as a safety guard against infinite
    // loops if the param somehow lands at a non-numeric value.
    const installDate = deriveInstallDate(generatedDate);
    const annex = buildAnnex(fullState, ADMIN_PARAMS, terms, installDate);
    return {
      recommended, recPanelCount, panelCount, systemKwp,
      recInverters, effectiveInverters, sizing, expansionActive,
      recBatteryKwh, batteryKwh, activeBatteryPackage,
      autoBatteryPackage, activeRecBatteryKwh,
      // v3-110 — the Step 2A objective + the sweep's feasibility verdict
      // (drives the amber notice, the PDF disclosure line, and the lead
      // payload). mode 'panels' is always feasible:true / achievedPct null.
      optimizationMode, optimization,
      // v3-136 — peaks-and-valleys sizing. `conservativeSizing` is the
      // EFFECTIVE value (state OR the 100%-target Variant-B lock);
      // `conservativeLocked` drives the disabled checkbox + lock copy;
      // `hasSub7Device` gates the whole control (hidden when every device
      // runs 7 days — the corners equal the average day). Consumed by the
      // Step 2A checkbox block, the PDF disclosure suffix, and the lead
      // payload.
      hasSub7Device, conservativeSizing, conservativeLocked,
      // v3-106 — stock flags for the Step 2 UI (out-of-stock notices).
      panelsAvailable, anyBatteryInStock, rsdInStock,
      pkg, terms, popularTenors, directPurchase, schedule, cashFlows, annex, installDate,
      // Exposed so handleGeneratePdf can rebuild the date-dependent annex
      // against a freshly stamped issue date (see deriveInstallDate).
      fullState,
    };
}
