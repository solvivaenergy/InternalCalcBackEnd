// =============================================================================
// PARAMETER VIEWS — the effective calculator configuration, by section
// -----------------------------------------------------------------------------
// Works on a runtime from buildRuntime(): bundled defaults + the stored row,
// legacy migrations applied, COGS back-filled, every direct price derived at
// grossMarginReference. So every "price" here is the ADMIN / REFERENCE price
// the Inventory and Engineering tabs display; a quote re-prices each line at
// its own resolved margin (see calc_quote's lineItems.marginRoute).
// =============================================================================

import { calculations } from "@solviva/calc-engine";
import { OFF_LUZON_DELIVERY_ENABLED, PROPOSAL_CONTENT, DISCLAIMERS } from "@solviva/calc-engine/data/adminParams.js";
import { INCLUDED_DC_CABLE_METERS, INCLUDED_AC_CABLE_METERS } from "@solviva/calc-engine/constants.js";
import { COMPONENT_LABELS, PRICE_FORMULA } from "./engine.js";
import { VAT_RATE, round2, round4 } from "./util.js";

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

// COGS key → derived price key, for the scalar pairs.
const SCALAR_PAIRS = {
  mountingSupportFloorCogs: "mountingSupportFloorPrice",
  additionalDcCablePerMeterCogs: "additionalDcCablePerMeter",
  additionalAcCablePerMeterCogs: "additionalAcCablePerMeter",
  laborInstallationPerKwpCogs: "laborInstallationPerKwp",
  rsdVariablePerPanelCogs: "rsdVariablePerPanel",
  rsdFixedTransmitterCogs: "rsdFixedTransmitter",
  roofAsphaltPerKwpCogs: "roofAsphaltPerKwp",
  roofConcretePerKwpCogs: "roofConcretePerKwp",
  luzonOver30FixedFeeCogs: "luzonOver30FixedFee",
  luzonOver30PerKmCogs: "luzonOver30PerKm",
  rsdStandaloneLaborPerPanelCogs: "rsdStandaloneLaborPerPanel",
  rsdStandaloneLaborMobilizationCogs: "rsdStandaloneLaborMobilization",
  inverterStandaloneLaborPerUnitCogs: "inverterStandaloneLaborPerUnit",
  inverterStandaloneMobilizationCogs: "inverterStandaloneMobilization",
  fixedOverheadDeliveryLogisticsCogs: "fixedOverheadDeliveryLogistics",
  fixedOverheadWarehouseCogs: "fixedOverheadWarehouse",
  fixedOverheadCustomsCogs: "fixedOverheadCustoms",
  fixedOverheadSafetySupervisionCogs: "fixedOverheadSafetySupervision",
  fixedOverheadTestingCogs: "fixedOverheadTesting",
  preventiveMaintenancePerPanelCogs: "preventiveMaintenancePerPanel",
  preventiveMaintenancePerVisitCogs: "preventiveMaintenancePerVisit",
};

function cogsPrice(ap, cogsKeys) {
  const out = {};
  for (const ck of cogsKeys) {
    const pk = SCALAR_PAIRS[ck];
    out[pk.replace(/Cogs$/, "")] = { cogs: ap[ck], referencePrice: ap[pk] };
  }
  return out;
}

const BATTERY_PAIRS = {
  batteryUnitCogs: "batteryUnitPrice",
  batteryRackCogs: "batteryRackPrice",
  atsCogs: "atsPrice",
  criticalLoadsMaterialsCogs: "criticalLoadsMaterials",
  laborWithSolarInstallCogs: "laborWithSolarInstall",
  standaloneLaborCogs: "standaloneLabor",
};

export const SECTIONS = [
  "margins",
  "interest_rates",
  "financing",
  "promo_codes",
  "panels_inverters",
  "battery_packages",
  "cabling",
  "variable_charges",
  "location",
  "misc_catalog",
  "standalone_fixed_overhead",
  "schedule_constants",
  "defaults",
  "devices",
  "content",
  "stored_payload",
  "all",
];

export function parametersView(rt, section, storedPayload) {
  const ap = rt.adminParams;
  const views = {
    margins: () => ({
      note:
        "Gross margin is a GENLINV curve over the solar array's kWp (three anchors at the 25th/50th/75th percentiles), per phase, applied to the panels line of a FULL system (panels + inverter). Panels without an inverter price at the per-phase no-inverter margin. Every other component either follows the panels' curve or uses its own fixed margin on a full system, and uses `otherwise` on any other order shape. The battery rides its own curve over the quote's battery kWh.",
      formula: PRICE_FORMULA,
      vatRate: VAT_RATE,
      merchantDiscountRate: ap.merchantDiscountRate,
      salesCommissionRate: ap.salesCommissionRate,
      grossMarginReference: ap.grossMarginReference,
      singlePhaseCurve: pick(ap, ["grossMarginMinKwp", "grossMarginMidKwp", "grossMarginMaxKwp", "grossMarginMin", "grossMarginMid", "grossMarginMax"]),
      threePhaseCurve: pick(ap, ["grossMarginMinKwpTp", "grossMarginMidKwpTp", "grossMarginMaxKwpTp", "grossMarginMinTp", "grossMarginMidTp", "grossMarginMaxTp"]),
      noInverterMargin: pick(ap, ["grossMarginNoInverterSp", "grossMarginNoInverterTp"]),
      batteryCurve: pick(ap, ["grossMarginBatteryMinKwh", "grossMarginBatteryMidKwh", "grossMarginBatteryMaxKwh", "grossMarginBatteryMin", "grossMarginBatteryMid", "grossMarginBatteryMax"]),
      componentMargins: Object.fromEntries(
        Object.entries(ap.componentMargins || {}).map(([id, v]) => [id, { ...v, label: COMPONENT_LABELS[id] }]),
      ),
      financingEntity: pick(ap, ["financingEntityName", "financingEntityIsSeparate"]),
    }),
    interest_rates: () => ({
      note:
        "RTO rate = GENLINV surface over tenor (1–60 months) and down payment (0–50%; above 50% is clamped to the 50% rate), through three anchors: Max @ 60 mo / 0% DP, Mid @ 30 mo / 25% DP, Min @ 1 mo / 50% DP; rateTenorWeight blends the two axes; every rate snaps to rateStepPct. Tenor 0 is a Direct Purchase at 0% with no DST. Monthly payment = PMT(rate/12, tenor, −amountFinanced), ordinary annuity.",
      ...pick(ap, ["rateAnchorMax", "rateAnchorMid", "rateAnchorMin", "rateTenorWeight", "rateStepPct", "earlyPayoffDiscountRate", "documentaryStampTaxRate"]),
    }),
    financing: () => ({
      ...pick(ap, ["minDpTiers", "maxTenorMonths", "defaultDownPaymentPct", "quoteValidityDays", "minSystemKwp", "irrYearsDefault", "duRateInflationDefault", "lcoeNpvDiscountRate", "maintenanceInflationRate", "minDaysToFirstPostInstallPayment"]),
      duInflationReference: pick(ap, ["duInflationSourceName", "duInflationSourceUrl", "duInflationBasis", "duInflationDate1", "duInflationRate1", "duInflationDate2", "duInflationRate2"]),
      financingEntity: pick(ap, ["financingEntityName", "financingEntityIsSeparate"]),
    }),
    promo_codes: () => ({
      note: "type 'percent' = fraction of the package price; 'peso' = flat VAT-inclusive amount (clamped to the order). Applied before the down payment.",
      promoCodes: ap.promoCodes || [],
    }),
    panels_inverters: () => ({
      note: "COGS are pre-VAT, Engineering-entered; referencePrice is the derived direct price at grossMarginReference. A quote re-prices at its own margin. Out-of-stock rows stay for history but are excluded from recommendations.",
      panels: {
        singlePhase: { ...rt.panelSettings.singlePhase, referencePrice: rt.panelSettings.singlePhase.panelDirectPrice },
        threePhase: { ...rt.panelSettings.threePhase, referencePrice: rt.panelSettings.threePhase.panelDirectPrice },
      },
      invertersSinglePhase: rt.invertersSinglePhase.map((i) => ({ ratedKw: i.ratedKw, cogs: i.cogs, referencePrice: i.directPrice, available: i.available !== false })),
      invertersThreePhase: rt.invertersThreePhase.map((i) => ({ ratedKw: i.ratedKw, cogs: i.cogs, referencePrice: i.directPrice, available: i.available !== false })),
    }),
    battery_packages: () => ({
      note: "Six COGS per package; prices derived at grossMarginReference here and at the battery kWh curve in a quote. rackRequiredFromUnits: 0 = never a rack, n = a rack from n units.",
      batteryPackages: (ap.batteryPackages || []).map((p) => ({
        id: p.id,
        label: p.label,
        available: p.available !== false,
        batteryUnitKwh: p.batteryUnitKwh,
        batteryRackCapacity: p.batteryRackCapacity,
        rackRequiredFromUnits: p.rackRequiredFromUnits,
        ...Object.fromEntries(Object.entries(BATTERY_PAIRS).map(([ck, pk]) => [pk, { cogs: p[ck], referencePrice: p[pk] }])),
      })),
    }),
    cabling: () => ({
      note: "The bundle (cables, conduits, fittings, panel board) is a percentage of the panels' price, by tier on panel count, interpolated between tiers; the first 30 m of DC and 10 m of AC cable are included.",
      includedDcCableMeters: INCLUDED_DC_CABLE_METERS,
      includedAcCableMeters: INCLUDED_AC_CABLE_METERS,
      cablingTiers: ap.cablingTiers,
      cablingTiersThreePhase: ap.cablingTiersThreePhase,
      ...cogsPrice(ap, ["additionalDcCablePerMeterCogs", "additionalAcCablePerMeterCogs"]),
    }),
    variable_charges: () => ({
      ...cogsPrice(ap, ["mountingSupportFloorCogs", "laborInstallationPerKwpCogs", "rsdVariablePerPanelCogs", "rsdFixedTransmitterCogs", "roofAsphaltPerKwpCogs", "roofConcretePerKwpCogs"]),
      mountingSupportPctOfPanels: ap.mountingSupportPctOfPanels,
      rsdAvailable: ap.rsdAvailable !== false,
      roofMetal: "no charge",
    }),
    location: () => ({
      note: `Luzon delivery is free within luzonFreeTravelKm of the Parañaque hub; beyond it a fixed fee plus a per-km charge. Off-Luzon delivery locations are ${OFF_LUZON_DELIVERY_ENABLED ? "offered" : "switched OFF in the engine (v3-213): the rows are kept but not offered"}.`,
      luzonFreeTravelKm: ap.luzonFreeTravelKm,
      ...cogsPrice(ap, ["luzonOver30FixedFeeCogs", "luzonOver30PerKmCogs"]),
      deliveryLocations: ap.deliveryLocations || [],
    }),
    misc_catalog: () => ({
      note: "Step 2F standing catalog (Anjon's BOM list). price = derived at grossMarginReference; negative COGS = reversal/credit rows that net against the package they belong to.",
      miscCatalog: (ap.miscCatalog || []).map((m) => ({ id: m.id, label: m.label, category: m.category || "misc", cogs: m.cogs, referencePrice: m.price, available: m.available !== false })),
    }),
    standalone_fixed_overhead: () => ({
      note: "Standalone retrofit charges apply to no-panel orders (RSD-only, inverter-only). Fixed overhead is folded into the Solar Labor & Installation line whenever panels are quoted.",
      standalone: cogsPrice(ap, ["rsdStandaloneLaborPerPanelCogs", "rsdStandaloneLaborMobilizationCogs", "inverterStandaloneLaborPerUnitCogs", "inverterStandaloneMobilizationCogs"]),
      fixedOverhead: cogsPrice(ap, ["fixedOverheadDeliveryLogisticsCogs", "fixedOverheadWarehouseCogs", "fixedOverheadCustomsCogs", "fixedOverheadSafetySupervisionCogs", "fixedOverheadTestingCogs"]),
    }),
    schedule_constants: () => ({
      ...pick(ap, ["kWhPerKwpPerDay", "batteryEfficiency", "maxDailySpillKwh", "batteryDepthOfDischarge", "panelAnnualDegradation", "netMeteringEfficiency", "minDaysToFirstPostInstallPayment"]),
      preventiveMaintenance: cogsPrice(ap, ["preventiveMaintenancePerPanelCogs", "preventiveMaintenancePerVisitCogs"]),
    }),
    defaults: () => pick(ap, ["defaultUtilityRate", "defaultMonthlyBill", "defaultDownPaymentPct", "quoteValidityDays", "irrYearsDefault", "duRateInflationDefault", "gateAuthEnabled"]),
    devices: () => ({
      note: "Appliance library for Step 1: average kW while on = peakKw × dutyFactor; day window is 06:00–18:00.",
      devices: rt.devices,
    }),
    content: () => ({
      note: "The proposal's T&Cs, warranties and disclaimers ship with the engine (PROPOSAL_CONTENT / DISCLAIMERS in data/adminParams.js), not with the stored row; calc_proposal returns the T&Cs with the {{QUOTE_VALIDITY_DAYS}} / {{VALID_UNTIL}} tokens filled in.",
      termsAndConditions: PROPOSAL_CONTENT.termsAndConditions,
      warranties: PROPOSAL_CONTENT.warranties,
      disclaimers: DISCLAIMERS,
    }),
    stored_payload: () => ({
      note: "The app_parameters row as saved by the admin screens (overrides only; the bundled defaults fill everything else). Legacy keys are migrated on load, so this is the raw stored shape.",
      payload: storedPayload,
    }),
  };

  if (section === "all") {
    const out = {};
    for (const key of Object.keys(views)) {
      if (key === "content" || key === "stored_payload") continue;
      out[key] = views[key]();
    }
    return out;
  }
  const fn = views[section];
  if (!fn) throw new Error(`unknown section "${section}"; one of: ${SECTIONS.join(", ")}`);
  return fn();
}

// ─── margin schedule ─────────────────────────────────────────────────────────

export function marginSchedule(rt, { kwpPoints, batteryKwhPoints, exampleCogs = 100000 } = {}) {
  const ap = rt.adminParams;
  const kwps = kwpPoints?.length ? kwpPoints : [1, 2, 3, 5, 8, 10, 12, 15, 20, 25, 30, 40];
  const kwhs = batteryKwhPoints?.length ? batteryKwhPoints : [0, 5, 10, 15, 16, 20, 25, 30, 32, 48];
  const mdr = ap.merchantDiscountRate ?? 0;
  const comm = ap.salesCommissionRate ?? 0;
  const priceAt = (m) => calculations.directFromCogs(exampleCogs, ap, m);

  const curve = (phase) =>
    kwps.map((kwp) => {
      const m = calculations.grossMarginCurve(kwp, ap, phase);
      return { systemKwp: kwp, margin: round4(m), examplePrice: priceAt(m) };
    });
  const battery = kwhs.map((kwh) => {
    const m = calculations.batteryMarginCurve(kwh, ap);
    return { batteryKwh: kwh, margin: round4(m), examplePrice: priceAt(m) };
  });

  const shapes = [
    { shape: "full_system", panelCount: 10, hasInverter: true },
    { shape: "panels_only", panelCount: 10, hasInverter: false },
    { shape: "no_panels", panelCount: 0, hasInverter: true },
  ];
  const resolution = {};
  for (const phase of ["single", "three"]) {
    resolution[phase] = {};
    for (const s of shapes) {
      const resolver = calculations.buildMarginResolver(ap, 6.3, s.panelCount, s.hasInverter, phase, 10);
      resolution[phase][s.shape] = Object.fromEntries(
        Object.keys(COMPONENT_LABELS).map((id) => [id, round4(resolver(id))]),
      );
    }
  }

  const example = (() => {
    const m = calculations.grossMarginCurve(6.3, ap, "single");
    const price = priceAt(m);
    const d = calculations.decomposeDirectPrice(price, exampleCogs, mdr, comm);
    return {
      cogs: exampleCogs,
      marginUsed: round4(m),
      note: "single-phase panels line on a 6.3 kWp full system (10 × 630 W)",
      directPrice: price,
      decomposition: { cogs: d.cogs, grossMargin: d.gm, realizedMarginPct: round4(d.gm / (d.gm + d.cogs)), commissionAllowance: d.commAmt, mdrAllowance: d.mdrAmt, vat: d.vat },
    };
  })();

  return {
    formula: PRICE_FORMULA,
    merchantDiscountRate: mdr,
    salesCommissionRate: comm,
    vatRate: VAT_RATE,
    grossMarginReference: ap.grossMarginReference,
    panelsCurve: { singlePhase: curve("single"), threePhase: curve("three"), anchors: parametersView(rt, "margins").singlePhaseCurve },
    noInverterMargin: { singlePhase: ap.grossMarginNoInverterSp, threePhase: ap.grossMarginNoInverterTp },
    batteryCurve: { points: battery, anchors: parametersView(rt, "margins").batteryCurve },
    componentMargins: parametersView(rt, "margins").componentMargins,
    resolvedByOrderShape: {
      note: "margin each component id prices at, for a 6.3 kWp / 10 kWh example order, by phase and order shape (full_system = panels + inverter; panels_only; no_panels). Component ids: see componentMargins labels.",
      ...resolution,
    },
    workedExample: example,
  };
}

// ─── RTO rate table ──────────────────────────────────────────────────────────

export function rateTable(rt, { tenors, downPayments, netPrice } = {}) {
  const ap = rt.adminParams;
  const ts = tenors?.length ? tenors : [1, 3, 6, 9, 12, 24, 36, 48, 60];
  const dps = downPayments?.length ? downPayments : [0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
  const grid = ts.map((t) => ({
    tenorMonths: t,
    rates: Object.fromEntries(dps.map((d) => [`dp_${Math.round(d * 100)}`, round4(calculations.rtoRate(t, d, ap))])),
  }));
  const sample = Number.isFinite(netPrice) && netPrice > 0 ? netPrice : null;
  const payments = sample
    ? ts.map((t) => ({
        tenorMonths: t,
        monthlyByDownPayment: Object.fromEntries(
          dps.map((d) => {
            const rate = calculations.rtoRate(t, d, ap);
            const financed = sample * (1 - d);
            const pmt = t < 1 ? financed : calculations.PMT(rate / 12, t, -financed);
            return [`dp_${Math.round(d * 100)}`, round2(pmt)];
          }),
        ),
      }))
    : null;
  return {
    note:
      "Annual rate on the diminishing balance, from the tenor × down-payment surface (see calc_parameters section interest_rates). Down payments above 50% earn the 50% rate. Direct Purchase (tenor 0) is 0% and pays no DST. DST = ceil(amountFinanced ÷ 200) × 200 × documentaryStampTaxRate × min(1, tenor ÷ 12).",
    anchors: pick(ap, ["rateAnchorMax", "rateAnchorMid", "rateAnchorMin", "rateTenorWeight", "rateStepPct", "documentaryStampTaxRate", "earlyPayoffDiscountRate"]),
    limits: pick(ap, ["minDpTiers", "maxTenorMonths", "defaultDownPaymentPct"]),
    rateGrid: grid,
    ...(sample ? { sampleNetPrice: sample, monthlyPaymentGrid: payments } : {}),
  };
}
