// =============================================================================
// ESTIMATE SERVICE — the website calculator's numbers, from the shared engine
// -----------------------------------------------------------------------------
// Behind POST /api/public/estimate. Runs @solviva/calc-engine's
// computeProposal() — the same pipeline the Internal Calculator runs in a
// rep's browser — on the live app_parameters row, and answers a
// customer-facing projection of the result. Nothing with COGS or margins
// leaves this module: the response is built field by field from an
// allowlist, never by spreading engine objects, and a final scan refuses to
// send a body that mentions either.
//
// Access is decided in server.js (the shared key the External Calculator's
// Cloudflare Worker sends). Inputs are the website's: bill, appliances,
// phase, a savings target, roof and location; everything a rep can also set
// (cables, inverter pick, promo, expansion …) stays at the calculator's
// defaults, so a rep who types these inputs into the Internal Calculator
// gets the identical figures.
// =============================================================================

import { createRequire } from "node:module";
import {
  DEFAULTS,
  buildRuntime,
  applyRuntime,
  computeProposal,
  defaultState,
  ADMIN_PARAMS,
  DEVICES,
} from "@solviva/calc-engine";
import { availableDeliveryLocations } from "@solviva/calc-engine/data/adminParams.js";
import { readParametersPayload } from "./parametersService.js";

const require = createRequire(import.meta.url);
export const ENGINE_VERSION = require("@solviva/calc-engine/package.json").version;

const MAX_APPLIANCES = 7;
// The row is read through Supabase on a miss; a short cache keeps the
// per-request cost to the computation. An admin save reaches the website
// within this window.
const PARAMS_CACHE_MS = 30_000;
let paramsCache = { at: 0, payload: null };

async function liveParamsPayload() {
  const now = Date.now();
  if (!paramsCache.payload || now - paramsCache.at > PARAMS_CACHE_MS) {
    paramsCache = { at: now, payload: await readParametersPayload() };
  }
  // buildRuntime edits the override in place (legacy-blob migrations), so it
  // gets a copy and the cache stays as the row was read.
  return JSON.parse(JSON.stringify(paramsCache.payload));
}

const num = (v) =>
  typeof v === "number"
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : NaN;
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const round4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

// Validates the request body against the LIVE parameters (defaults, device
// names, delivery locations) and returns { inputs } or { error }.
function normalize(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }
  const monthlyBill = num(body.monthlyBill);
  if (!(monthlyBill >= 0 && monthlyBill <= 10_000_000)) {
    return { error: "monthlyBill must be a number between 0 and 10,000,000 (pesos)." };
  }
  const utilityRate = body.utilityRate == null ? ADMIN_PARAMS.defaultUtilityRate : num(body.utilityRate);
  if (!(utilityRate > 0 && utilityRate <= 100)) {
    return { error: "utilityRate must be between 0 and 100 (pesos per kWh)." };
  }
  const phase =
    body.phase == null || body.phase === "single" || body.phase === 1
      ? 1
      : body.phase === "three" || body.phase === 3
        ? 3
        : null;
  if (phase == null) return { error: 'phase must be "single" or "three".' };
  const desiredSavingsPct = body.desiredSavingsPct == null ? 0.5 : num(body.desiredSavingsPct);
  if (!(desiredSavingsPct >= 0 && desiredSavingsPct <= 1)) {
    return { error: "desiredSavingsPct must be between 0 and 1." };
  }
  const roofMaterial = body.roofMaterial ?? "metal";
  if (!["metal", "asphalt", "concrete"].includes(roofMaterial)) {
    return { error: 'roofMaterial must be "metal", "asphalt" or "concrete".' };
  }
  const locationIds = ["luzon", "other", ...availableDeliveryLocations(ADMIN_PARAMS).map((l) => l.id)];
  const location = body.location ?? "luzon";
  if (!locationIds.includes(location)) {
    return { error: `location must be one of: ${locationIds.join(", ")}.` };
  }
  const locationKm = body.locationKm == null ? 18 : num(body.locationKm);
  if (!(locationKm >= 0 && locationKm <= 2000)) {
    return { error: "locationKm must be between 0 and 2000." };
  }
  const tenor = body.tenor == null ? 60 : num(body.tenor);
  if (!(Number.isInteger(tenor) && tenor >= 0 && tenor <= 120)) {
    return { error: "tenor must be a whole number of months from 0 (direct purchase) to 120." };
  }
  const downPaymentPct = body.downPaymentPct == null ? ADMIN_PARAMS.defaultDownPaymentPct : num(body.downPaymentPct);
  if (!(downPaymentPct >= 0 && downPaymentPct <= 1)) {
    return { error: "downPaymentPct must be between 0 and 1." };
  }
  const appliances = body.appliances == null ? [] : body.appliances;
  if (!Array.isArray(appliances) || appliances.length > MAX_APPLIANCES) {
    return { error: `appliances must be an array of at most ${MAX_APPLIANCES} rows.` };
  }
  const names = DEVICES.map((d) => d.name);
  const rows = [];
  for (const [i, a] of appliances.entries()) {
    if (!a || typeof a !== "object") return { error: `appliances[${i}] must be an object.` };
    if (!names.includes(a.name)) {
      return { error: `appliances[${i}].name must be one of: ${names.join(", ")}.` };
    }
    const count = num(a.count);
    const onHour = num(a.onHour);
    const offHour = num(a.offHour);
    const daysPerWeek = num(a.daysPerWeek);
    if (!(Number.isInteger(count) && count >= 1 && count <= 99)) {
      return { error: `appliances[${i}].count must be a whole number from 1 to 99.` };
    }
    if (!(onHour >= 0 && onHour < 24 && offHour >= 0 && offHour < 24)) {
      return { error: `appliances[${i}].onHour and offHour must be hours from 0 to 23.` };
    }
    if (!(Number.isInteger(daysPerWeek) && daysPerWeek >= 1 && daysPerWeek <= 7)) {
      return { error: `appliances[${i}].daysPerWeek must be a whole number from 1 to 7.` };
    }
    rows.push({ name: a.name, count, onHour, offHour, daysPerWeek });
  }
  return {
    inputs: {
      monthlyBill, utilityRate, phase: phase === 3 ? "three" : "single",
      desiredSavingsPct, roofMaterial, location, locationKm, tenor, downPaymentPct,
      appliances: rows,
    },
  };
}

function stateFor(inputs) {
  const state = defaultState(ADMIN_PARAMS);
  state.phase = inputs.phase === "three" ? 3 : 1;
  state.utilityRate = inputs.utilityRate;
  state.monthlyBill = inputs.monthlyBill;
  state.desiredSavingsPct = inputs.desiredSavingsPct;
  state.roofMaterial = inputs.roofMaterial;
  state.location = inputs.location;
  state.locationKm = inputs.locationKm;
  state.tenor = inputs.tenor;
  state.downPaymentPct = inputs.downPaymentPct;
  if (inputs.appliances.length) {
    // The engine's rows carry times as fractions of a day (Excel time values).
    state.deviceRows = inputs.appliances.map((a) => ({
      deviceName: a.name,
      count: a.count,
      onTime: a.onHour / 24,
      offTime: a.offHour / 24,
      daysPerWeek: a.daysPerWeek,
    }));
  }
  return state;
}

// Customer-facing projection. Every field is named here on purpose — adding
// one means deciding it may be public.
function project(model, state, inputs, now) {
  const r = model.recommended || {};
  const t = model.terms || {};
  const dp = model.directPurchase || {};
  const cf = model.cashFlows || {};
  const sch = model.schedule || {};
  const opt = model.optimization || {};
  const pkg = model.activeBatteryPackage;
  return {
    engineVersion: ENGINE_VERSION,
    generatedAt: now.toISOString(),
    inputs,
    consumption: {
      estMonthlyKwh: round2(r.estMonthlyKwh),
      dayTimeKwh: round2(r.dayTimeKwh),
      nightTimeKwh: round2(r.nightTimeKwh),
      appliancesKwh: round2(r.deviceTotalKwh),
      baseloadKwh: round2(r.baseloadKwh),
    },
    system: {
      panelCount: model.panelCount,
      panelWatts: r.panelWatts,
      systemKwp: round2(model.systemKwp),
      inverters: (model.effectiveInverters || []).filter(Boolean).map((i) => ({ ratedKw: i.ratedKw })),
      totalInverterKw: model.sizing?.totalInverterKw ?? null,
      batteryKwh: model.batteryKwh,
      batteryPackage: pkg ? { id: pkg.id, label: pkg.label, unitKwh: pkg.batteryUnitKwh } : null,
      panelsAvailable: model.panelsAvailable !== false,
      batteryAvailable: !!model.anyBatteryInStock,
      coverage: {
        mode: opt.mode ?? null,
        targetPct: round4(opt.targetPct),
        achievedPct: round4(opt.achievedPct),
        feasible: opt.feasible ?? null,
      },
    },
    pricing: {
      currency: "PHP",
      netPrice: round2(t.netDirectPrice),
      promoDiscount: round2(t.promoDiscount),
      directPurchase: {
        total: round2(dp.total),
        downPaymentPct: dp.dpPct ?? null,
        downPayment: round2(dp.dpAmount),
        balanceOnInstallation: round2(dp.monthly),
      },
      rentToOwn:
        inputs.tenor > 0
          ? {
              tenorMonths: inputs.tenor,
              annualRate: t.rtoRate ?? null,
              downPaymentPct: inputs.downPaymentPct,
              downPayment: round2(t.dpTotalCharge),
              monthly: round2(t.customerMonthlyPmt),
              totalDue: round2(t.totalAmountDue),
              financeCharge: round2(t.totalInterest),
              documentaryStampTax: round2(t.dst),
            }
          : null,
      tenors: (model.popularTenors || []).map((p) => ({
        tenorMonths: p.tenor,
        annualRate: p.rate ?? null,
        monthly: round2(p.monthlyPmt),
        totalDue: round2(p.totalDue),
      })),
      lineItems: (model.pkg?.items || []).map((i) => ({
        key: i.key,
        category: i.category,
        description: i.description,
        price: round2(i.directPrice),
      })),
    },
    savings: {
      monthlyPesoSavings: round2(cf.monthlyDuSavings),
      annualPesoSavings: round2(cf.monthlyDuSavings * 12),
      monthlyKwhSavings: round2(sch.monthlyKwhSavingsBatt),
      billAfterSolar: round2(Math.max(0, inputs.monthlyBill - (cf.monthlyDuSavings || 0))),
      paybackMonths: cf.paybackMonths ?? null,
      paybackLabel: cf.paybackLabel ?? null,
      irr: round4(cf.irr),
      lcoePerKwh: round2(cf.lcoe),
      horizonYears: state.irrYears,
      totalSavingsOverHorizon: round2(cf.totalDuSavings),
      duRateInflation: cf.duRateInflation ?? null,
    },
  };
}

// Returns { status, payload } like the other services.
export async function buildEstimate(body, now = new Date()) {
  const payload = await liveParamsPayload();
  // The engine reads the catalog from its module objects; fill them from the
  // live row. Synchronous from here to the projection, so concurrent requests
  // cannot interleave a fill and a computation.
  applyRuntime(buildRuntime(DEFAULTS, payload));

  const normalized = normalize(body);
  if (normalized.error) return { status: 400, payload: { error: normalized.error } };

  const state = stateFor(normalized.inputs);
  const model = computeProposal(state, now);
  const result = project(model, state, normalized.inputs, now);

  // Defence in depth: the projection above is an allowlist, and this refuses
  // to answer at all if a cost or margin field ever slips into it.
  const text = JSON.stringify(result);
  if (/cogs|margin/i.test(text)) {
    console.error("[estimate] projection contains a cost/margin field; refusing to answer");
    return { status: 500, payload: { error: "Failed to compute the estimate." } };
  }
  return { status: 200, payload: result };
}
