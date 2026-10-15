// =============================================================================
// ENGINE BRIDGE — run @solviva/calc-engine on a stored parameter row and
// project the INTERNAL view of a quote (COGS, margins, the lot)
// -----------------------------------------------------------------------------
// The website estimate (src/estimateService.js) runs the same pipeline and
// answers an allowlisted customer-facing projection. This module is the other
// side of that coin: it is for Solviva's own team, so every line item comes
// back with its COGS, its gross-margin peso and realised percentage, the MDR
// allowance and the VAT — the Summary tab's admin price reveal — plus which
// margin rule (component id) priced it. Nothing here is customer-facing; the
// proposal builder (mcp/proposal.js) strips the cost columns again.
//
// The engine reads its catalog from live module objects (ADMIN_PARAMS, the
// inverter lists, DEVICES), so a quote is computed inside withRuntime(): the
// stored payload is laid over the bundled defaults, written into the live
// objects, and the computation runs SYNCHRONOUSLY from there — no await
// between applyRuntime() and computeProposal(), so two requests can never
// interleave a fill and a computation (same discipline as the estimate route).
// =============================================================================

import { createRequire } from "node:module";
import {
  DEFAULTS,
  buildRuntime,
  applyRuntime,
  computeProposal,
  defaultState,
  ADMIN_PARAMS,
  PANEL_SETTINGS,
  DEVICES,
  calculations,
  boq,
} from "@solviva/calc-engine";
import {
  availableBatteryPackages,
  availableDeliveryLocations,
  availableMiscCatalog,
  PACKAGE_CATEGORIES,
  OFF_LUZON_DELIVERY_ENABLED,
  racksNeeded,
} from "@solviva/calc-engine/data/adminParams.js";
import {
  INCLUDED_DC_CABLE_METERS,
  INCLUDED_AC_CABLE_METERS,
} from "@solviva/calc-engine/constants.js";
import { ToolError, VAT_RATE, addDays, round2, round4 } from "./util.js";

const require = createRequire(import.meta.url);
export const ENGINE_VERSION = require("@solviva/calc-engine/package.json").version;

// Pat's component letters (calculations.js COMPONENT_MARGIN_IDS) plus the
// three routes the resolver adds: A (the panels line), K (battery, its own
// kWh curve) and PM (preventive maintenance, reference margin).
export const COMPONENT_LABELS = {
  A: "Solar panels (phase curve on a full system; per-phase no-inverter margin otherwise)",
  B: "Single-phase cabling bundle",
  C: "Three-phase cabling bundle",
  D: "Additional DC cable (per metre)",
  E: "Additional AC cable (per metre)",
  F: "Labor & installation (per kWp)",
  G: "RSD variable (per panel)",
  H: "RSD fixed transmitter",
  I: "Single-phase inverters",
  J: "Three-phase inverters",
  K: "Battery package (rides its own kWh curve)",
  L: "Misc catalog items",
  M: "Location / delivery",
  N: "Standalone retrofit charges (no-panel orders only)",
  O: "Fixed overhead (folded into the labor line)",
  P: "Mounting support",
  Q: "Roof preparation",
  PM: "Preventive maintenance (reference margin, outside the component table)",
};

export const PRICE_FORMULA =
  "directPrice = CEILING( COGS × 1.12 ÷ (1 − margin) ÷ (1.12 × (1 − MDR) − 0.12) ). " +
  "Prices are VAT-inclusive. Net revenue kept per ₱1 of ex-VAT price = 1.12 × (1 − MDR) − 0.12. " +
  "Two production-parity exceptions: Mounting Support = max(floor price, 13% of the panels' selling price) " +
  "and the cabling bundle = tier % × the panels' selling price, so both realise the panels' margin rather than P / B / C.";

// Run `fn(rt)` with the engine's live objects filled from `payload` (a stored
// app_parameters row). Synchronous on purpose — see the header.
export function withRuntime(payload, fn) {
  const rt = buildRuntime(DEFAULTS, JSON.parse(JSON.stringify(payload || {})));
  applyRuntime(rt);
  return fn(rt);
}

// ─── inputs → calculator state ───────────────────────────────────────────────

export function buildState(args = {}) {
  const ap = ADMIN_PARAMS;
  const phaseKey = args.phase === "three" ? "three" : "single";
  const state = defaultState(ap);
  const warnings = [];
  const or = (v, d) => (v == null ? d : v);

  state.phase = phaseKey === "three" ? 3 : 1;
  state.utilityRate = or(args.utilityRate, ap.defaultUtilityRate);
  state.monthlyBill = or(args.monthlyBill, ap.defaultMonthlyBill);
  state.desiredSavingsPct = or(args.desiredSavingsPct, 0.5);
  state.optimizationMode = or(args.optimizationMode, "panels");
  state.conservativeSizing = !!args.conservativeSizing;

  if (Array.isArray(args.appliances) && args.appliances.length) {
    const names = DEVICES.map((d) => d.name);
    state.deviceRows = args.appliances.map((a, i) => {
      const match = DEVICES.find((d) => d.name.toLowerCase() === String(a.name).toLowerCase());
      if (!match) {
        throw new ToolError(
          `appliances[${i}].name "${a.name}" is not in the device library. Valid names: ${names.join(", ")}`,
        );
      }
      return {
        deviceName: match.name,
        count: a.count,
        onTime: a.onHour / 24, // the engine carries times as fractions of a day
        offTime: a.offHour / 24,
        daysPerWeek: a.daysPerWeek,
      };
    });
  }

  if (args.panelCount != null) state.panelCount = args.panelCount;

  if (Array.isArray(args.inverters)) {
    const live = calculations.availableInverters(phaseKey);
    const sizes = live.map((i) => i.ratedKw);
    const slots = [null, null, null];
    args.inverters.slice(0, 3).forEach((kw, i) => {
      if (kw == null) return;
      const inv = live.find((x) => x.ratedKw === kw);
      if (!inv) {
        throw new ToolError(
          `inverters[${i}] = ${kw} kW is not an in-stock ${phaseKey}-phase inverter. Available: ${sizes.join(", ")} kW`,
        );
      }
      slots[i] = { ...inv };
    });
    state.selectedInverters = slots;
  }

  if (args.expansion) {
    state.expansionMode = true;
    state.existingKwp = args.expansion.existingKwp;
    state.existingInverterKw = args.expansion.existingInverterKw ?? null;
  }

  if (args.batteryKwh != null) state.batteryKwh = args.batteryKwh;
  if (args.batteryPackageId) {
    const pkgs = availableBatteryPackages(ap);
    const want = String(args.batteryPackageId).toLowerCase();
    const pkg = pkgs.find(
      (p) => String(p.id).toLowerCase() === want || String(p.label).toLowerCase() === want,
    );
    if (!pkg) {
      throw new ToolError(
        `batteryPackageId "${args.batteryPackageId}" is not an in-stock battery package. Available: ${pkgs
          .map((p) => `${p.id} (${p.label})`)
          .join(", ")}`,
      );
    }
    state.batteryPackageId = pkg.id;
  }
  for (const k of ["batteryRackIncluded", "batteryAtsIncluded", "batteryCritLoadsIncluded"]) {
    if (args[k] != null) state[k] = !!args[k];
  }

  if (args.dcCableMeters != null) state.dcCableMeters = args.dcCableMeters;
  if (args.acCableMeters != null) state.acCableMeters = args.acCableMeters;
  if (args.rsdEnabled != null) state.rsdEnabled = !!args.rsdEnabled;
  if (args.rsdStandalonePanelCount != null) state.rsdStandalonePanelCount = args.rsdStandalonePanelCount;
  if (args.netMeteringEnabled != null) state.netMeteringEnabled = !!args.netMeteringEnabled;
  if (args.roofMaterial) state.roofMaterial = args.roofMaterial;

  if (args.location) {
    const ids = ["luzon", "other", ...availableDeliveryLocations(ap).map((l) => l.id)];
    if (!ids.includes(args.location)) {
      throw new ToolError(
        `location "${args.location}" is not serviceable. One of: ${ids.join(", ")}` +
          (OFF_LUZON_DELIVERY_ENABLED ? "" : " (off-Luzon delivery is switched off in the engine, v3-213)"),
      );
    }
    state.location = args.location;
  }
  if (args.locationKm != null) state.locationKm = args.locationKm;
  for (const k of ["locationRegion", "locationProvince", "locationCity"]) {
    if (args[k] != null) state[k] = args[k];
  }

  if (Array.isArray(args.miscMaterials)) {
    const catalog = availableMiscCatalog(ap);
    state.miscMaterials = args.miscMaterials.map((row, i) => {
      const count = row.count ?? 1;
      if (row.catalogId && row.catalogId !== "other") {
        const want = String(row.catalogId).toLowerCase();
        const item = catalog.find(
          (m) => String(m.id).toLowerCase() === want || String(m.label).toLowerCase() === want,
        );
        if (!item) {
          throw new ToolError(
            `miscMaterials[${i}].catalogId "${row.catalogId}" is not an in-stock catalog item. Available: ${catalog
              .map((m) => `${m.id} (${m.label})`)
              .join("; ")}`,
          );
        }
        return { catalogId: item.id, description: item.label, count, unitPrice: item.price };
      }
      if (!row.description || row.unitPrice == null) {
        throw new ToolError(
          `miscMaterials[${i}] needs a description and a unitPrice (VAT-inclusive pesos) when no catalogId is given`,
        );
      }
      return { catalogId: "other", description: row.description, count, unitPrice: row.unitPrice };
    });
  }

  if (args.tenor != null) state.tenor = args.tenor;
  if (args.downPaymentPct != null) state.downPaymentPct = args.downPaymentPct;
  if (args.promoCode) {
    state.promoCode = String(args.promoCode).trim().toUpperCase();
    if (!(ap.promoCodes || []).some((p) => p.code === state.promoCode)) {
      warnings.push(
        `promo code "${state.promoCode}" is not configured, so no discount applies. Configured codes: ${(ap.promoCodes || [])
          .map((p) => p.code)
          .join(", ")}`,
      );
    }
  }
  if (args.irrYears != null) state.irrYears = args.irrYears;
  if (args.duRateInflation != null) state.duRateInflation = args.duRateInflation;
  if (state.tenor > (ap.maxTenorMonths ?? 60)) {
    warnings.push(`tenor ${state.tenor} exceeds maxTenorMonths (${ap.maxTenorMonths}); the calculator would not offer it`);
  }

  let generatedDate = new Date();
  if (args.generatedDate) {
    generatedDate = new Date(args.generatedDate);
    if (Number.isNaN(generatedDate.getTime())) {
      throw new ToolError(`generatedDate "${args.generatedDate}" is not a date`);
    }
  }
  return { state, warnings, generatedDate, phaseKey };
}

// ─── the internal projection ─────────────────────────────────────────────────

const LETTER_BY_CATEGORY = Object.fromEntries(PACKAGE_CATEGORIES.map((c) => [c.id, c.letter]));
const LABEL_BY_LETTER = Object.fromEntries(PACKAGE_CATEGORIES.map((c) => [c.letter, c.label]));

// Which margin rule priced a line (see calculations.js buildPackageLineItems
// and deriveDirectPrices' MAP).
function routeFor(key, phaseKey, item) {
  if (key === "panels") return "A";
  if (key === "mounting") return "A (production parity: max(floor price, 13% of the panels' selling price); P not consulted)";
  if (key === "cabling") return `A (production parity: tier % × the panels' selling price; ${phaseKey === "three" ? "C" : "B"} not consulted)`;
  if (key === "dcExtra") return "D";
  if (key === "acExtra") return "E";
  if (key === "labor") return "F per kWp + O fixed overhead";
  if (key === "rsd") return "G per panel + H transmitter";
  if (key === "rsdLabor" || key === "invMob") return "N";
  if (/^inverter\d$/.test(key)) return phaseKey === "three" ? "J" : "I";
  if (["battery", "rack", "ats", "critLoads", "batteryLabor"].includes(key)) return "K";
  if (key === "roof") return "Q";
  if (key === "location") return "M";
  if (/^misc\d+$/.test(key)) return item?.cogs == null ? "none (rep-entered price, no COGS basis)" : "L";
  return null;
}

function inverterList(arr) {
  return (arr || []).filter(Boolean).map((i) => ({ ratedKw: i.ratedKw }));
}

function decomposeLines(items, mdr) {
  // The Summary tab's price reveal: COGS + GM + MDR allowance + VAT = direct
  // price on every line (the rounding residual sits in GM), realised margin
  // = GM ÷ (GM + COGS). Lines with no COGS basis book all net revenue as GM.
  const rows = items.map((it) => ({ it, d: calculations.decomposeDirectPrice(it.directPrice, it.cogs, mdr) }));
  const total = rows.reduce(
    (a, { d }) => ({
      cogs: a.cogs + (d.cogsKnown ? d.cogs : 0),
      gm: a.gm + d.gm,
      mdrAmt: a.mdrAmt + d.mdrAmt,
      vat: a.vat + d.vat,
      dp: a.dp + d.dp,
    }),
    { cogs: 0, gm: 0, mdrAmt: 0, vat: 0, dp: 0 },
  );
  const netRevenue = total.gm + total.cogs;
  return {
    rows,
    total: {
      directPrice: total.dp,
      cogs: total.cogs,
      grossMargin: total.gm,
      realizedMarginPct: netRevenue > 0 ? round4(total.gm / netRevenue) : null,
      mdrAllowance: total.mdrAmt,
      vat: total.vat,
    },
  };
}

export function projectQuote({ state, model, generatedDate, warnings = [], include = {} }) {
  const ap = ADMIN_PARAMS;
  const fs = model.fullState;
  const phaseKey = fs.phase;
  const validityDays = ap.quoteValidityDays ?? 30;
  const validUntil = addDays(generatedDate, validityDays);
  const mdr = ap.merchantDiscountRate ?? 0;
  const orderHasInverter = (model.effectiveInverters || []).some(Boolean);
  const fullSystem = model.panelCount > 0 && orderHasInverter;
  const marginFor = calculations.buildMarginResolver(
    ap,
    model.systemKwp,
    model.panelCount,
    orderHasInverter,
    phaseKey,
    model.batteryKwh,
  );
  const t = model.terms || {};
  const dp = model.directPurchase || {};
  const cf = model.cashFlows || {};
  const sch = model.schedule || {};
  const r = model.recommended || {};
  const pkg = model.activeBatteryPackage;

  // Lines ─ the Summary's visible rows (price ≠ 0 and a description).
  const items = (model.pkg?.items || []).filter((i) => i && String(i.description || "").trim() && i.directPrice !== 0);
  const { rows, total } = decomposeLines(items, mdr);
  const lines = rows.map(({ it, d }) => ({
    key: it.key,
    package: LETTER_BY_CATEGORY[it.category] || "C",
    description: it.description,
    marginRoute: routeFor(it.key, phaseKey, it),
    directPrice: round2(it.directPrice),
    cogs: d.cogsKnown ? round2(it.cogs) : null,
    grossMargin: d.gm,
    realizedMarginPct: d.cogsKnown && d.gm + d.cogs ? round4(d.gm / (d.gm + d.cogs)) : null,
    mdrAllowance: d.mdrAmt,
    vat: d.vat,
    ...(it.meters != null ? { meters: it.meters } : {}),
    ...(it.declined ? { declined: true } : {}),
  }));
  const byPackage = {};
  for (const cat of PACKAGE_CATEGORIES) {
    const sub = rows.filter(({ it }) => (LETTER_BY_CATEGORY[it.category] || "C") === cat.letter);
    if (!sub.length) continue;
    const agg = decomposeLines(sub.map(({ it }) => it), mdr).total;
    byPackage[cat.letter] = { label: cat.label, lines: sub.length, ...agg };
  }
  const zeroPriceInclusions = (model.pkg?.items || [])
    .filter((i) => i && i.description && i.description !== "None" && i.directPrice === 0 && !/^misc\d+$/.test(i.key))
    .map((i) => i.description);

  const minDpPct = calculations.resolveMinDpPct(ap.minDpTiers, t.netDirectPrice);
  const allNotes = [...warnings];
  if (r.inconsistent) allNotes.push("Consumption check: the appliance list claims more kWh than the bill implies (Q27 < 0), as the calculator's Step 1 would flag.");
  if (fs.downPaymentPct < minDpPct - 1e-9) allNotes.push(`downPaymentPct ${fs.downPaymentPct} is below the minimum ${minDpPct} for a net price of ${round2(t.netDirectPrice)}; the calculator would not allow it.`);
  if (model.sizing?.ratioExceeded) allNotes.push(`DC/AC ratio ${round2(model.sizing.dcAcRatio)} exceeds the phase maximum ${model.sizing.maxRatio}.`);
  if (model.optimization && model.optimization.feasible === false) allNotes.push(`The ${model.optimization.mode} optimisation could not reach the ${round2((model.optimization.targetPct || 0) * 100)}% target; achieved ${round2((model.optimization.achievedPct || 0) * 100)}%.`);
  if (!model.panelsAvailable) allNotes.push("Panels for this phase are out of stock in the live inventory: the array is forced to 0 panels.");
  if (!model.anyBatteryInStock) allNotes.push("Every battery package is out of stock: battery forced to 0 kWh.");

  const units = pkg && pkg.batteryUnitKwh > 0 && model.batteryKwh > 0 ? Math.ceil(model.batteryKwh / pkg.batteryUnitKwh) : 0;
  const tenorRows = (model.popularTenors || []).map((p) => ({
    tenorMonths: p.tenor,
    annualRate: p.rate,
    monthly: round2(p.monthlyPmt),
    totalDueInclDst: round2(p.totalDue),
    monthlyAddOnRate: round4(calculations.monthlyAddOnRate(p.monthlyPmt, t.amountForFinancing, p.tenor)),
    selected: p.tenor === fs.tenor,
  }));

  const result = {
    engineVersion: ENGINE_VERSION,
    generatedAt: generatedDate.toISOString(),
    validUntil: validUntil.toISOString(),
    validityDays,
    notes: allNotes,
    inputs: {
      phase: phaseKey,
      monthlyBill: fs.monthlyBill,
      utilityRate: fs.utilityRate,
      desiredSavingsPct: fs.desiredSavingsPct,
      optimizationMode: model.optimizationMode,
      conservativeSizing: model.conservativeSizing,
      appliances: (fs.deviceRows || [])
        .filter((row) => row && row.deviceName)
        .map((row) => ({
          name: row.deviceName,
          count: row.count,
          onHour: round2(row.onTime * 24),
          offHour: round2(row.offTime * 24),
          daysPerWeek: row.daysPerWeek,
        })),
      panelCountOverride: state.panelCount,
      invertersOverride: state.selectedInverters.map((i) => (i ? i.ratedKw : null)),
      batteryKwhOverride: state.batteryKwh,
      batteryPackageIdOverride: state.batteryPackageId,
      dcCableMeters: fs.dcCableMeters,
      acCableMeters: fs.acCableMeters,
      rsdEnabled: fs.rsdEnabled,
      netMeteringEnabled: fs.netMeteringEnabled,
      roofMaterial: fs.roofMaterial,
      location: fs.location,
      locationKm: fs.locationKm,
      miscMaterials: fs.miscMaterials || [],
      tenor: fs.tenor,
      downPaymentPct: fs.downPaymentPct,
      promoCode: fs.promoCode || "",
      irrYears: state.irrYears,
      duRateInflation: cf.duRateInflation ?? state.duRateInflation,
    },
    consumption: {
      estMonthlyKwh: round2(r.estMonthlyKwh),
      dayTimeKwh: round2(r.dayTimeKwh),
      nightTimeKwh: round2(r.nightTimeKwh),
      appliancesKwh: round2(r.deviceTotalKwh),
      baseloadKwh: round2(r.baseloadKwh),
      dailyCapacityNeededKwh: round2(r.dailyCapacityNeeded),
      rawPanelRecommendation: round2(r.rawRecommendation),
      inconsistent: !!r.inconsistent,
    },
    system: {
      phase: phaseKey,
      panelCount: model.panelCount,
      recommendedPanelCount: model.recPanelCount,
      minPanelsFloor: r.minPanelsFloor,
      panelWatts: r.panelWatts,
      systemKwp: round2(model.systemKwp),
      inverters: inverterList(model.effectiveInverters),
      recommendedInverters: inverterList(model.recInverters),
      totalInverterKw: model.sizing?.totalInverterKw ?? null,
      dcAcRatio: round4(model.sizing?.dcAcRatio),
      maxDcAcRatio: model.sizing?.maxRatio ?? null,
      battery: {
        kwh: model.batteryKwh,
        recommendedKwh: model.recBatteryKwh,
        recommendedOnActivePackageKwh: model.activeRecBatteryKwh,
        package: pkg ? { id: pkg.id, label: pkg.label, unitKwh: pkg.batteryUnitKwh } : null,
        autoPackage: model.autoBatteryPackage ? { id: model.autoBatteryPackage.id, label: model.autoBatteryPackage.label } : null,
        units,
        racks: pkg && units > 0 ? racksNeeded(pkg, units) : 0,
        rackIncluded: fs.batteryRackIncluded,
        atsIncluded: fs.batteryAtsIncluded,
        criticalLoadsIncluded: fs.batteryCritLoadsIncluded,
      },
      expansion: model.expansionActive ? { existingKwp: fs.existingKwp, existingInverterKw: fs.existingInverterKw } : null,
      rsd: { enabled: !!fs.rsdEnabled, inStock: !!model.rsdInStock },
      netMetering: !!fs.netMeteringEnabled,
      roofMaterial: fs.roofMaterial,
      location: { id: fs.location, roadKm: fs.locationKm, region: fs.locationRegion, province: fs.locationProvince, city: fs.locationCity },
      cables: { dcMeters: fs.dcCableMeters, acMeters: fs.acCableMeters, includedDcMeters: INCLUDED_DC_CABLE_METERS, includedAcMeters: INCLUDED_AC_CABLE_METERS },
      optimization: model.optimization,
      conservativeSizing: model.conservativeSizing,
      stock: { panelsAvailable: model.panelsAvailable, anyBatteryInStock: model.anyBatteryInStock, rsdInStock: model.rsdInStock },
    },
    margins: {
      orderShape: !(model.panelCount > 0) ? "no_panels" : fullSystem ? "full_system" : "panels_only",
      panelsMargin: round4(marginFor("A")),
      batteryMargin: round4(marginFor("K")),
      referenceMargin: ap.grossMarginReference,
      merchantDiscountRate: mdr,
      vatRate: VAT_RATE,
      components: Object.fromEntries(
        Object.keys(COMPONENT_LABELS).map((id) => [id, { margin: round4(marginFor(id)), label: COMPONENT_LABELS[id] }]),
      ),
      formula: PRICE_FORMULA,
    },
    lineItems: lines,
    zeroPriceInclusions,
    totals: { byPackage, ...total, packageLabels: LABEL_BY_LETTER },
    pricing: {
      currency: "PHP",
      vatIncluded: true,
      packageTotal: round2(model.pkg?.totalDirect),
      packageCogs: round2(model.pkg?.totalCogs),
      promo: t.promo ? { code: t.promo.code, label: t.promo.label, type: t.promo.type || "percent", discount: t.promo.discount } : null,
      discountAmount: round2(t.discountAmount),
      netPrice: round2(t.netDirectPrice),
      financing: { entity: ap.financingEntityName, isSeparateEntity: !!ap.financingEntityIsSeparate },
      directPurchase: {
        downPaymentPct: dp.dpPct,
        downPayment: round2(dp.dpAmount),
        balanceOnInstallation: round2(dp.monthly),
        total: round2(dp.total),
      },
      selected: t.isDirectPurchase
        ? { type: "Direct Purchase", tenorMonths: 0, downPaymentPct: fs.downPaymentPct, downPayment: round2(t.dpTotalCharge), balanceOnInstallation: round2(t.customerMonthlyPmt), totalDue: round2(t.summaryTotalDue) }
        : {
            type: "Rent-to-Own (installment)",
            tenorMonths: fs.tenor,
            annualRateDiminishingBalance: t.rtoRate,
            downPaymentPct: fs.downPaymentPct,
            downPayment: round2(t.dpTotalCharge),
            amountFinanced: round2(t.amountForFinancing),
            monthly: round2(t.customerMonthlyPmt),
            totalDueExclDst: round2(t.totalAmountDue),
            documentaryStampTax: round2(t.dst),
            totalDueInclDst: round2(t.summaryTotalDue),
            financeCharge: round2(t.totalInterest),
            monthlyAddOnRate: round4(calculations.monthlyAddOnRate(t.customerMonthlyPmt, t.amountForFinancing, fs.tenor)),
            isFullyPaid: !!t.isFullyPaid,
          },
      tenorTable: tenorRows,
      limits: {
        minDownPaymentPct: minDpPct,
        allowedDownPaymentPcts: calculations.allowedDpOptions(minDpPct),
        maxTenorMonths: ap.maxTenorMonths,
        minDpTiers: ap.minDpTiers,
      },
    },
    savings: {
      monthlyPesoSavings: round2(cf.monthlyDuSavings),
      annualPesoSavings: round2((cf.monthlyDuSavings || 0) * 12),
      monthlyKwhSavings: round2(sch.monthlyKwhSavingsBatt),
      billAfterSolar: round2(Math.max(0, fs.monthlyBill - (cf.monthlyDuSavings || 0))),
      paybackMonths: Number.isFinite(cf.paybackMonths) ? cf.paybackMonths : null,
      paybackLabel: cf.paybackLabel ?? null,
      irr: round4(cf.irr),
      lcoePerKwh: round2(cf.lcoe),
      horizonYears: state.irrYears,
      totalSavingsOverHorizon: round2(cf.totalDuSavings),
      duRateInflation: cf.duRateInflation ?? null,
      netMetering: {
        enabled: !!fs.netMeteringEnabled,
        monthlyPesoSavingsWithNetMetering: round2(sch.monthlyPesoSavingsBattNm),
        incrementalMonthlyPesoSavings: round2(sch.incrementalNmSavings),
      },
      coverage: {
        solarPctOfUse: round4(sch.solarCoveragePctOfUse),
        solarPctOfProduction: round4(sch.solarCoveragePctOfProduction),
        batteryPctOfProduction: round4(sch.battCoveragePctOfProduction),
        creditsPctOfProduction: round4(sch.creditsCoveragePctOfProduction),
        bars: sch.coverageBars,
      },
    },
    schedule: {
      installDate: model.installDate,
      rowCount: model.annex?.rows?.length ?? 0,
      preview: (model.annex?.rows || []).slice(0, 3).map(annexRow),
      ...(include.annex ? { rows: (model.annex?.rows || []).map(annexRow) } : {}),
    },
    ...(include.cashflows ? { cashflows: (cf.cashflows || []).map((row) => ({ year: row.year, investment: round2(row.invPmts), maintenance: round2(row.maintCost), totalCost: round2(row.totalCost), duSavings: round2(row.duSavings), net: round2(row.netCf) })) } : {}),
    ...(include.hourly ? { hourly: { rows: sch.rows, totals: sch.totals } } : {}),
    ...(include.boq === false ? {} : { boq: boq.buildBoqLines({ model, state: fs }) }),
    ...(include.orderLines === false ? {} : { orderLines: buildOrderLines({ model, state: fs }) }),
  };
  return result;
}

function annexRow(row) {
  return {
    payment: row.payment,
    dueDate: row.dueDate instanceof Date ? row.dueDate.toISOString().slice(0, 10) : row.dueDate,
    description: row.description,
    minDue: round2(row.minDue),
    earlyPayoff: row.earlyPayoff == null ? null : round2(row.earlyPayoff),
    savings: row.savings == null ? null : round2(row.savings),
  };
}

// One quotation line per package, mirroring the Summary's three groups and
// what the calculator sends to Odoo (InternalCalcFrontEnd src/lib/
// odooOrderLines.js, story 064D). VAT-inclusive subtotals; the promo discount
// is NOT in these lines (Odoo gets it as a separate negative line).
export function buildOrderLines({ model, state } = {}) {
  const items = Array.isArray(model?.pkg?.items) ? model.pkg.items : [];
  const visible = items.filter((i) => i && i.directPrice !== 0 && String(i.description || "").trim());
  const lines = [];
  for (const cat of PACKAGE_CATEGORIES) {
    const rows = visible.filter((i) => i.category === cat.id);
    if (rows.length === 0) continue;
    const inclusions = rows.map((i) => String(i.description).trim());
    if (cat.id === "solar" && model?.expansionActive) {
      const kw = Number(state?.existingInverterKw);
      inclusions.unshift(
        `Connects to the customer's existing ${Number.isFinite(kw) && kw > 0 ? `${kw.toFixed(1)} kW ` : ""}inverter — no inverter included in this order.`,
      );
    }
    lines.push({
      package: cat.letter,
      label: `${cat.letter}. ${cat.label}`,
      inclusions,
      amount: round2(rows.reduce((sum, i) => sum + (Number(i.directPrice) || 0), 0)),
    });
  }
  return lines;
}

// Convenience: inputs → { state, model, projection } inside one runtime fill.
export function runQuote(payload, args, include = {}) {
  return withRuntime(payload, () => {
    const { state, warnings, generatedDate } = buildState(args);
    const model = computeProposal(state, generatedDate);
    const projection = projectQuote({ state, model, generatedDate, warnings, include });
    return { state, model, projection, generatedDate };
  });
}

// Exposed for the parameters / margin tools, which also need the live objects.
export { ADMIN_PARAMS, PANEL_SETTINGS, DEVICES };
