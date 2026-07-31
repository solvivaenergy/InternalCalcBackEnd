import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const INCLUDED_DC_CABLE_METERS = 30;
const INCLUDED_AC_CABLE_METERS = 10;
const FALLBACK_DAY_START_HOUR = 6;

const FALLBACK_CABLING_TIER = {
  minPanels: 1,
  dcCablePct: 0.27,
  acCablePct: 0.08,
  conduitsPct: 0.12,
  panelBoardPct: 0.09,
};

export async function buildQuote(input) {
  const validationError = validateInput(input);
  if (validationError) {
    throw new Error(validationError);
  }

  const runtime = await loadRuntimeDataFromSupabase();
  const sanitized = sanitizeState(input, runtime.adminParams, runtime);

  const recommendedPanels = computeRecommendedPanels(
    {
      monthlyBill: sanitized.monthlyBill,
      utilityRate: sanitized.utilityRate,
      deviceRows: sanitized.deviceRows,
      desiredSavingsPct: sanitized.desiredSavingsPct,
      phase: sanitized.phase,
    },
    runtime.adminParams,
    runtime,
  );

  const panelCount = Number.isInteger(sanitized.panelCount)
    ? sanitized.panelCount
    : recommendedPanels.recommendedPanelCount;

  const fullState = {
    ...sanitized,
    panelCount,
  };

  const packageData = buildPackageLineItems(
    fullState,
    runtime.adminParams,
    runtime,
  );
  const paymentTerms = computePaymentTerms(
    fullState,
    runtime.adminParams,
    packageData,
  );

  const quotePayload = {
    generatedAt: new Date().toISOString(),
    input: fullState,
    recommendedPanels,
    package: packageData,
    paymentTerms,
  };

  const quoteSignature = createHash("sha256")
    .update(JSON.stringify({ quotePayload, adminParams: runtime.adminParams }))
    .digest("hex");

  return {
    quoteSignature,
    quote: quotePayload,
  };
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "Input must be a JSON object.";
  }
  if (
    !Number.isFinite(Number(input.monthlyBill)) ||
    Number(input.monthlyBill) < 0
  ) {
    return "monthlyBill must be a non-negative number.";
  }
  if (
    !Number.isFinite(Number(input.utilityRate)) ||
    Number(input.utilityRate) <= 0
  ) {
    return "utilityRate must be a positive number.";
  }
  if (
    !Number.isFinite(Number(input.desiredSavingsPct)) ||
    Number(input.desiredSavingsPct) < 0
  ) {
    return "desiredSavingsPct must be a non-negative number.";
  }
  if (input.phase !== "single" && input.phase !== "three") {
    return 'phase must be either "single" or "three".';
  }
  if (!Number.isInteger(Number(input.tenor)) || Number(input.tenor) < 1) {
    return "tenor must be a positive integer.";
  }
  if (
    !Number.isFinite(Number(input.downPaymentPct)) ||
    Number(input.downPaymentPct) < 0
  ) {
    return "downPaymentPct must be a non-negative number.";
  }
  if (input.deviceRows != null && !Array.isArray(input.deviceRows)) {
    return "deviceRows must be an array when provided.";
  }
  return null;
}

function sanitizeState(input, adminParams, runtime) {
  const phase = input.phase === "three" ? "three" : "single";
  const panelCount = Number.isFinite(Number(input.panelCount))
    ? Math.max(0, Math.round(Number(input.panelCount)))
    : null;

  const selectedInverters = resolveSelectedInverters(
    phase,
    input.selectedInverters,
    runtime,
  );

  const promoCode = String(input.promoCode || "")
    .trim()
    .toUpperCase();
  const normalizedPromoCode = adminParams.promoCodes.some(
    (p) => p.code === promoCode,
  )
    ? promoCode
    : "";

  return {
    phase,
    monthlyBill: Number(input.monthlyBill),
    utilityRate: Number(input.utilityRate),
    desiredSavingsPct: Number(input.desiredSavingsPct),
    deviceRows: Array.isArray(input.deviceRows) ? input.deviceRows : [],
    panelCount,
    dcCableMeters: Number.isFinite(Number(input.dcCableMeters))
      ? Number(input.dcCableMeters)
      : INCLUDED_DC_CABLE_METERS,
    acCableMeters: Number.isFinite(Number(input.acCableMeters))
      ? Number(input.acCableMeters)
      : INCLUDED_AC_CABLE_METERS,
    rsdEnabled: !!input.rsdEnabled,
    rsdStandalonePanelCount: Number.isFinite(
      Number(input.rsdStandalonePanelCount),
    )
      ? Math.max(0, Math.round(Number(input.rsdStandalonePanelCount)))
      : 0,
    selectedInverters,
    batteryKwh: Number.isFinite(Number(input.batteryKwh))
      ? Math.max(0, Number(input.batteryKwh))
      : 0,
    batteryPackageId: input.batteryPackageId
      ? String(input.batteryPackageId)
      : undefined,
    roofMaterial: ["metal", "asphalt", "concrete"].includes(input.roofMaterial)
      ? input.roofMaterial
      : "metal",
    location: ["luzon", "cebu", "siargao"].includes(input.location)
      ? input.location
      : "luzon",
    locationKm: Number.isFinite(Number(input.locationKm))
      ? Math.max(0, Number(input.locationKm))
      : 0,
    miscMaterials: Array.isArray(input.miscMaterials)
      ? input.miscMaterials
      : [],
    tenor: Math.round(Number(input.tenor)),
    downPaymentPct: Number(input.downPaymentPct),
    promoCode: normalizedPromoCode,
  };
}

function resolveSelectedInverters(phase, raw, runtime) {
  const inventory =
    phase === "three"
      ? runtime.invertersThreePhase
      : runtime.invertersSinglePhase;
  const byRatedKw = new Map(inventory.map((inv) => [Number(inv.ratedKw), inv]));
  const rows = Array.isArray(raw) ? raw.slice(0, 3) : [];
  while (rows.length < 3) rows.push(null);

  return rows.map((entry) => {
    if (entry == null) return null;
    const ratedKw = typeof entry === "number" ? entry : Number(entry?.ratedKw);
    if (!Number.isFinite(ratedKw)) return null;
    return byRatedKw.get(ratedKw) || null;
  });
}

// =============================================================================
// PARAMETER SOURCE OF TRUTH — the `app_parameters` blob (Option A)
// -----------------------------------------------------------------------------
// The admin pipeline (parametersService.js) persists a SINGLE JSON snapshot to
// `app_parameters.payload`:
//     { adminParams, panelSettings, invertersSinglePhase,
//       invertersThreePhase, devices }
// This is the exact shape the frontend paramsService produces. We read the same
// blob here so admin edits reflect in quotes immediately — no separate
// normalized tables to keep in sync.
//
// Prices in the blob are DERIVED from COGS at the reference margin. They can be
// stale (the frontend re-derives them at boot, not necessarily before every
// PUT), so we re-derive here from COGS, mirroring the frontend exactly. That
// guarantees the quote engine prices match what the admin sees.
// =============================================================================
const PARAMS_TABLE = "app_parameters";
const VAT_RATE = 0.12; // Philippine VAT — a constant, not a param (mirrors frontend).

function deepClone(v) {
  if (v == null) return null;
  return JSON.parse(JSON.stringify(v));
}

// Port of the frontend's directFromCogs() (calculations.js). Marks up pre-VAT
// COGS to an ex-VAT direct price at the given margin, netting out the acquirer's
// merchant-discount cut and the VAT remittance. Returns 0 for non-positive or
// degenerate inputs rather than throwing.
function directFromCogs(cogs, adminParams, marginOverride) {
  const ap = adminParams || {};
  const gm =
    marginOverride ??
    ap.grossMarginReference ??
    ap.grossMarginMax ??
    ap.grossMargin ??
    0;
  const mdr = ap.merchantDiscountRate ?? 0;
  const c = Number(cogs);
  if (!Number.isFinite(c) || c <= 0) return 0;
  const retained = (1 + VAT_RATE) * (1 - mdr) - VAT_RATE;
  if (!(retained > 0) || !(1 - gm > 0)) return 0;
  return Math.ceil((c * (1 + VAT_RATE)) / (1 - gm) / retained);
}

// Acklam's inverse normal CDF — ported verbatim from the frontend
// (calculations.js) so the backend margin curve is bit-for-bit identical.
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

// Port of the frontend's grossMarginCurveFromAnchors() (calculations.js). The
// GENLINV curve over kWp for an explicit anchor triple through the shared kWp
// breakpoints. Returns q3/fallback for a degenerate axis rather than throwing.
function grossMarginCurveFromAnchors(
  systemKwp,
  x1,
  x2,
  x3,
  q1,
  q2,
  q3,
  fallback,
) {
  if (
    ![x1, x2, x3, q1, q2, q3].every(Number.isFinite) ||
    x3 <= x1 ||
    x2 <= x1 ||
    x2 >= x3
  ) {
    return Number.isFinite(q3) ? q3 : Number.isFinite(fallback) ? fallback : 0;
  }
  const kwp = Number.isFinite(systemKwp) ? systemKwp : x3;
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

// v3-142 — per-package margin anchor keys, mirroring the frontend. Each package
// rides the shared kWp breakpoints through its own anchor triple; a package
// whose anchors are absent falls back to the legacy grossMarginMin/Mid/Max.
const PACKAGE_MARGIN_ANCHOR_KEYS = {
  solar: ["grossMarginSolarMin", "grossMarginSolarMid", "grossMarginSolarMax"],
  battery: [
    "grossMarginBatteryMin",
    "grossMarginBatteryMid",
    "grossMarginBatteryMax",
  ],
  misc: ["grossMarginMiscMin", "grossMarginMiscMid", "grossMarginMiscMax"],
};

function resolvePackageMarginAnchors(adminParams, pkg) {
  const ap = adminParams || {};
  const keys = PACKAGE_MARGIN_ANCHOR_KEYS[pkg];
  const pick = (k, legacy) => (Number.isFinite(ap[k]) ? ap[k] : ap[legacy]);
  return {
    q1: pick(keys[0], "grossMarginMin"),
    q2: pick(keys[1], "grossMarginMid"),
    q3: pick(keys[2], "grossMarginMax"),
  };
}

// The margin applied to a specific PACKAGE for a quote. No-panels orders price
// at that package's max anchor (ceiling), mirroring the frontend.
function packageMarginForCapacity(systemKwp, panelCount, adminParams, pkg) {
  const ap = adminParams || {};
  const { q1, q2, q3 } = resolvePackageMarginAnchors(ap, pkg);
  if (!(panelCount > 0)) {
    return Number.isFinite(q3)
      ? q3
      : (ap.grossMarginMax ?? ap.grossMargin ?? 0);
  }
  return grossMarginCurveFromAnchors(
    systemKwp,
    ap.grossMarginMinKwp,
    ap.grossMarginMidKwp,
    ap.grossMarginMaxKwp,
    q1,
    q2,
    q3,
    ap.grossMargin,
  );
}

// v3-142 — resolves all three package-level margin CURVES for a given system
// size. Each package rides its own curve; no-panels orders use each package's
// max anchor. Absent package anchors fall back to the legacy curve.
function resolvePackageMargins(adminParams, systemKwp, panelCount) {
  return {
    solar: packageMarginForCapacity(
      systemKwp,
      panelCount,
      adminParams,
      "solar",
    ),
    battery: packageMarginForCapacity(
      systemKwp,
      panelCount,
      adminParams,
      "battery",
    ),
    misc: packageMarginForCapacity(systemKwp, panelCount, adminParams, "misc"),
  };
}

// Port of the frontend's deriveDirectPrices() (calculations.js). Rewrites every
// derived price field from its COGS source, in place, at the reference margin.
function deriveDirectPrices(
  ap,
  panelSettings,
  invertersSP,
  invertersTP,
  margin,
) {
  const d = (c) => directFromCogs(c, ap, margin);

  if (panelSettings?.singlePhase)
    panelSettings.singlePhase.panelDirectPrice = d(
      panelSettings.singlePhase.panelCogs,
    );
  if (panelSettings?.threePhase)
    panelSettings.threePhase.panelDirectPrice = d(
      panelSettings.threePhase.panelCogs,
    );
  for (const inv of invertersSP || []) inv.directPrice = d(inv.cogs);
  for (const inv of invertersTP || []) inv.directPrice = d(inv.cogs);

  const MAP = {
    mountingSupportFloorPrice: "mountingSupportFloorCogs",
    additionalDcCablePerMeter: "additionalDcCablePerMeterCogs",
    additionalAcCablePerMeter: "additionalAcCablePerMeterCogs",
    laborInstallationPerKwp: "laborInstallationPerKwpCogs",
    rsdVariablePerPanel: "rsdVariablePerPanelCogs",
    rsdFixedTransmitter: "rsdFixedTransmitterCogs",
    roofAsphaltPerKwp: "roofAsphaltPerKwpCogs",
    roofConcretePerKwp: "roofConcretePerKwpCogs",
    luzonOver30FixedFee: "luzonOver30FixedFeeCogs",
    luzonOver30PerKm: "luzonOver30PerKmCogs",
    rsdStandaloneLaborPerPanel: "rsdStandaloneLaborPerPanelCogs",
    rsdStandaloneLaborMobilization: "rsdStandaloneLaborMobilizationCogs",
    inverterStandaloneLaborPerUnit: "inverterStandaloneLaborPerUnitCogs",
    inverterStandaloneMobilization: "inverterStandaloneMobilizationCogs",
    fixedOverheadDeliveryLogistics: "fixedOverheadDeliveryLogisticsCogs",
    fixedOverheadWarehouse: "fixedOverheadWarehouseCogs",
    fixedOverheadCustoms: "fixedOverheadCustomsCogs",
    fixedOverheadSafetySupervision: "fixedOverheadSafetySupervisionCogs",
    fixedOverheadTesting: "fixedOverheadTestingCogs",
    preventiveMaintenancePerPanel: "preventiveMaintenancePerPanelCogs",
    preventiveMaintenancePerVisit: "preventiveMaintenancePerVisitCogs",
  };
  for (const [priceKey, cogsKey] of Object.entries(MAP)) {
    if (cogsKey in ap) ap[priceKey] = d(ap[cogsKey]);
  }

  const B = {
    batteryUnitPrice: "batteryUnitCogs",
    batteryRackPrice: "batteryRackCogs",
    atsPrice: "atsCogs",
    criticalLoadsMaterials: "criticalLoadsMaterialsCogs",
    laborWithSolarInstall: "laborWithSolarInstallCogs",
    standaloneLabor: "standaloneLaborCogs",
  };
  for (const loc of ap.deliveryLocations || []) {
    loc.fixedFee = d(loc.fixedFeeCogs);
    loc.perPanel = d(loc.perPanelCogs);
  }
  for (const m of ap.miscCatalog || []) {
    m.price = d(m.cogs);
  }
  for (const pkg of ap.batteryPackages || []) {
    for (const [priceKey, cogsKey] of Object.entries(B)) {
      pkg[priceKey] = d(pkg[cogsKey]);
    }
  }
  return ap;
}

async function loadRuntimeDataFromSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment variables.",
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase
    .from(PARAMS_TABLE)
    .select("payload")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Supabase query failed for ${PARAMS_TABLE}: ${error.message}`,
    );
  }

  const payload =
    data?.payload && typeof data.payload === "object"
      ? deepClone(data.payload)
      : {};

  const adminParams = payload.adminParams || {};
  const panelSettings = payload.panelSettings || {};
  const invertersSP = Array.isArray(payload.invertersSinglePhase)
    ? payload.invertersSinglePhase
    : [];
  const invertersTP = Array.isArray(payload.invertersThreePhase)
    ? payload.invertersThreePhase
    : [];
  const devices = Array.isArray(payload.devices) ? payload.devices : [];

  // Re-derive every price from COGS at the reference margin, exactly like the
  // frontend does on boot — so the quote engine can never read a stale price.
  // Per-package quote pricing re-derives at the package curve later; this only
  // seeds the admin-display baseline.
  const baseMargin = Number.isFinite(adminParams.grossMarginReference)
    ? adminParams.grossMarginReference
    : adminParams.grossMarginMax;
  deriveDirectPrices(
    adminParams,
    panelSettings,
    invertersSP,
    invertersTP,
    baseMargin,
  );

  // Location shim (frontend v3-116): the four cebu/siargao scalar fees became a
  // dynamic `deliveryLocations` array whose seed ids match the legacy location
  // values. The quote engine still reads the scalar keys, so backfill them from
  // the matching rows when present.
  const findLoc = (id) =>
    (adminParams.deliveryLocations || []).find((l) => l && l.id === id);
  const cebuLoc = findLoc("cebu");
  const siargaoLoc = findLoc("siargao");
  if (cebuLoc) {
    adminParams.cebuFixedFee = Number(cebuLoc.fixedFee) || 0;
    adminParams.cebuPerPanel = Number(cebuLoc.perPanel) || 0;
  }
  if (siargaoLoc) {
    adminParams.siargaoFixedFee = Number(siargaoLoc.fixedFee) || 0;
    adminParams.siargaoPerPanel = Number(siargaoLoc.perPanel) || 0;
  }

  if (!devices.length) {
    throw new Error("No device rows found in app_parameters payload.");
  }
  const panelSingle = panelSettings.singlePhase;
  const panelThree = panelSettings.threePhase;
  if (!panelSingle || !panelThree) {
    throw new Error(
      "app_parameters payload must include panelSettings.singlePhase and threePhase.",
    );
  }

  const invertersSinglePhase = invertersSP.map((i) => ({
    ratedKw: Number(i.ratedKw),
    cogs: Number(i.cogs),
    directPrice: Number(i.directPrice),
  }));
  const invertersThreePhase = invertersTP.map((i) => ({
    ratedKw: Number(i.ratedKw),
    cogs: Number(i.cogs),
    directPrice: Number(i.directPrice),
  }));
  if (!invertersSinglePhase.length || !invertersThreePhase.length) {
    throw new Error(
      "app_parameters payload must include both single- and three-phase inverters.",
    );
  }

  // Guard the shape the quote engine hard-depends on. adminParams supplies all
  // camelCase scalar keys directly from the blob.
  if (!Array.isArray(adminParams.promoCodes)) adminParams.promoCodes = [];
  if (!Array.isArray(adminParams.batteryPackages)) {
    throw new Error("app_parameters payload must include batteryPackages.");
  }

  const runtime = {
    dayStartHour: FALLBACK_DAY_START_HOUR,
    devices: devices.map((d) => ({
      name: d.name,
      peakKw: Number(d.peakKw),
      dutyFactor: Number(d.dutyFactor),
    })),
    panelSettings: {
      singlePhase: {
        panelWatts: Number(panelSingle.panelWatts),
        panelCogs: Number(panelSingle.panelCogs),
        panelDirectPrice: Number(panelSingle.panelDirectPrice),
        maxDcAcRatio: Number(panelSingle.maxDcAcRatio),
      },
      threePhase: {
        panelWatts: Number(panelThree.panelWatts),
        panelCogs: Number(panelThree.panelCogs),
        panelDirectPrice: Number(panelThree.panelDirectPrice),
        maxDcAcRatio: Number(panelThree.maxDcAcRatio),
      },
    },
    invertersSinglePhase,
    invertersThreePhase,
    adminParams,
  };

  return runtime;
}

function PMT(rate, nper, pv, fv = 0, type = 0) {
  if (nper === 0) return 0;
  if (rate === 0) return -(pv + fv) / nper;
  const pvif = Math.pow(1 + rate, nper);
  return (-rate * (pv * pvif + fv)) / ((1 + rate * type) * (pvif - 1));
}

function PV(rate, nper, pmt, fv = 0, type = 0) {
  if (rate === 0) return -(pmt * nper + fv);
  const pvif = Math.pow(1 + rate, nper);
  return -((pmt * (1 + rate * type) * (pvif - 1)) / rate + fv) / pvif;
}

function effectiveRtoRate(panelCount, adminParams) {
  const premium =
    panelCount < adminParams.smallPackagePanelThreshold
      ? adminParams.smallPackageRiskPremiumBps / 10000
      : 0;
  return adminParams.baseRtoInterestRate + premium;
}

function deviceMonthlyKwh(
  device,
  count,
  onTime,
  offTime,
  daysPerWeek,
  dayStartHour,
) {
  if (onTime == null || offTime == null || count == null || count <= 0) {
    return { dayKwh: 0, nightKwh: 0 };
  }

  let dur;
  if (onTime === offTime) dur = 1;
  else if (offTime > onTime) dur = offTime - onTime;
  else dur = offTime + 1 - onTime;

  const shift = dayStartHour / 24;
  const onShifted = (((onTime - shift) % 1) + 1) % 1;
  const dayPiece1 = Math.max(
    0,
    Math.min(onShifted + dur, 0.5) - Math.max(onShifted, 0),
  );
  const dayPiece2 = Math.max(
    0,
    Math.min(onShifted + dur, 1.5) - Math.max(onShifted, 1),
  );
  const hoursDay = (dayPiece1 + dayPiece2) * 24;
  const nightPiece1 = Math.max(
    0,
    Math.min(onShifted + dur, 1.0) - Math.max(onShifted, 0.5),
  );
  const nightPiece2 = Math.max(
    0,
    Math.min(onShifted + dur, 2.0) - Math.max(onShifted, 1.5),
  );
  const hoursNight = (nightPiece1 + nightPiece2) * 24;

  const monthlyMultiplier = (daysPerWeek / 7) * (365 / 12);
  const avgKw = device ? device.peakKw * device.dutyFactor : 0;

  return {
    dayKwh: hoursDay * monthlyMultiplier * avgKw * count,
    nightKwh: hoursNight * monthlyMultiplier * avgKw * count,
  };
}

function totalDeviceKwh(deviceRows, runtime) {
  let day = 0;
  let night = 0;
  for (const row of deviceRows) {
    if (!row.deviceName) continue;
    const device = runtime.devices.find((d) => d.name === row.deviceName);
    if (!device) continue;
    const { dayKwh, nightKwh } = deviceMonthlyKwh(
      device,
      row.count,
      row.onTime,
      row.offTime,
      row.daysPerWeek,
      runtime.dayStartHour,
    );
    day += dayKwh;
    night += nightKwh;
  }
  return { totalDeviceDayKwh: day, totalDeviceNightKwh: night };
}

function computeRecommendedPanels(inputs, adminParams, runtime) {
  const { monthlyBill, utilityRate, deviceRows, desiredSavingsPct, phase } =
    inputs;
  const q25 = monthlyBill / utilityRate;
  const { totalDeviceDayKwh, totalDeviceNightKwh } = totalDeviceKwh(
    deviceRows,
    runtime,
  );
  const q26 = totalDeviceDayKwh + totalDeviceNightKwh;
  const q27 = q25 - q26;
  const q28 = q27 / 2 + totalDeviceDayKwh;
  const q29 = q27 / 2 + totalDeviceNightKwh;
  const q31 =
    q29 / adminParams.batteryEfficiency / adminParams.batteryDepthOfDischarge;
  const q32 = ((q28 + q31) * 12) / 365;
  const panelWatts =
    phase === "three"
      ? runtime.panelSettings.threePhase.panelWatts
      : runtime.panelSettings.singlePhase.panelWatts;
  const q34 =
    (desiredSavingsPct * q32 * 1000) / panelWatts / adminParams.kWhPerKwpPerDay;
  const minPanelsFloor = Math.ceil(
    ((adminParams.minSystemKwp || 0) * 1000) / panelWatts,
  );
  const w7 = Math.max(Math.ceil(q34), minPanelsFloor);

  return {
    estMonthlyKwh: q25,
    deviceDayKwh: totalDeviceDayKwh,
    deviceNightKwh: totalDeviceNightKwh,
    deviceTotalKwh: q26,
    baseloadKwh: q27,
    dayTimeKwh: q28,
    nightTimeKwh: q29,
    batteryNightTimeKwh: q31,
    dailyCapacityNeeded: q32,
    rawRecommendation: q34,
    recommendedPanelCount: w7,
    panelWatts,
    inconsistent: q27 < 0,
  };
}

function resolveMinDpPct(minDpTiers, netPrice) {
  if (!Array.isArray(minDpTiers) || minDpTiers.length === 0) return 0;
  const sorted = [...minDpTiers]
    .filter(
      (t) =>
        t &&
        Number.isFinite(Number(t.fromNetPrice)) &&
        Number.isFinite(Number(t.minDpPct)),
    )
    .map((t) => ({
      fromNetPrice: Number(t.fromNetPrice),
      minDpPct: Number(t.minDpPct),
    }))
    .sort((a, b) => a.fromNetPrice - b.fromNetPrice);
  if (sorted.length === 0) return 0;

  const n = Number(netPrice);
  const key = Number.isFinite(n) ? n : 0;
  let floor = sorted[0].minDpPct || 0;
  for (const row of sorted) {
    if (key >= row.fromNetPrice) floor = row.minDpPct;
    else break;
  }
  return Math.max(0, Math.min(0.5, floor));
}

function cablingTotalPct(panelCount, adminParams, phase) {
  const singleTiers = Array.isArray(adminParams.cablingTiers)
    ? adminParams.cablingTiers
    : [];
  const threeTiers = Array.isArray(adminParams.cablingTiersThreePhase)
    ? adminParams.cablingTiersThreePhase
    : [];
  const tiers =
    phase === "three" && threeTiers.length > 0 ? threeTiers : singleTiers;

  if (tiers.length === 0) {
    const t = FALLBACK_CABLING_TIER;
    return t.dcCablePct + t.acCablePct + t.conduitsPct + t.panelBoardPct;
  }
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

function panelDirectPrice(phase, runtime) {
  return phase === "three"
    ? runtime.panelSettings.threePhase.panelDirectPrice
    : runtime.panelSettings.singlePhase.panelDirectPrice;
}

function resolveBatteryPackage(adminParams, batteryPackageId) {
  const list = adminParams?.batteryPackages || [];
  if (batteryPackageId) {
    const match = list.find((p) => p.id === batteryPackageId);
    if (match) return match;
  }
  if (list.length > 0) return list[0];
  return {
    id: "fallback",
    label: "5 kWh",
    batteryUnitKwh: 5,
    batteryUnitPrice: 0,
    batteryRackCapacity: 3,
    batteryRackPrice: 0,
    atsPrice: 0,
    criticalLoadsMaterials: 0,
    laborWithSolarInstall: 0,
    standaloneLabor: 0,
  };
}

function buildPackageLineItems(state, adminParams, runtime) {
  const {
    phase,
    panelCount,
    dcCableMeters,
    acCableMeters,
    rsdEnabled,
    rsdStandalonePanelCount,
    selectedInverters,
    batteryKwh,
    roofMaterial,
    location,
    locationKm,
    miscMaterials,
  } = state;

  const rtoRate = effectiveRtoRate(panelCount, adminParams);
  const monthlyRate = rtoRate / 12;
  const toRto = (direct) =>
    direct ? PMT(monthlyRate, 60, -direct, 0, 1) * 60 : 0;

  const panelWatts =
    phase === "three"
      ? runtime.panelSettings.threePhase.panelWatts
      : runtime.panelSettings.singlePhase.panelWatts;
  const systemKwp = (panelCount * panelWatts) / 1000;
  const {
    solar: solarMargin,
    battery: batteryMargin,
    misc: miscMargin,
  } = resolvePackageMargins(adminParams, systemKwp, panelCount);
  const panelCogsEa =
    phase === "three"
      ? runtime.panelSettings.threePhase.panelCogs
      : runtime.panelSettings.singlePhase.panelCogs;
  const panelPriceEa = directFromCogs(panelCogsEa, adminParams, solarMargin);

  const items = [];
  const panelsTotal = panelCount * panelPriceEa;
  items.push({
    key: "panels",
    description: `${panelCount} units ${panelWatts}W Solar Panels`,
    directPrice: panelsTotal,
    rto60Price: toRto(panelsTotal),
  });

  const mountingDirect =
    panelsTotal === 0
      ? 0
      : Math.max(
          adminParams.mountingSupportFloorPrice,
          panelsTotal * adminParams.mountingSupportPctOfPanels,
        );
  items.push({
    key: "mounting",
    description: "Mounting Support",
    directPrice: mountingDirect,
    rto60Price: toRto(mountingDirect),
  });

  const cablingPct = cablingTotalPct(panelCount, adminParams, phase);
  const cablingDirect = panelsTotal === 0 ? 0 : cablingPct * panelsTotal;
  items.push({
    key: "cabling",
    description: "Cables, Conduits, Fittings, Panel Board & Other Devices",
    directPrice: cablingDirect,
    rto60Price: toRto(cablingDirect),
  });

  const dcExtraMeters = Math.max(
    0,
    (dcCableMeters || 0) - INCLUDED_DC_CABLE_METERS,
  );
  const dcExtraDirect =
    panelsTotal === 0
      ? 0
      : dcExtraMeters * adminParams.additionalDcCablePerMeter;
  items.push({
    key: "dcExtra",
    description: `${dcExtraMeters}m of Add'l. DC Cable`,
    directPrice: dcExtraDirect,
    rto60Price: toRto(dcExtraDirect),
  });

  const acExtraMeters = Math.max(
    0,
    (acCableMeters || 0) - INCLUDED_AC_CABLE_METERS,
  );
  const acExtraDirect =
    panelsTotal === 0
      ? 0
      : acExtraMeters * adminParams.additionalAcCablePerMeter;
  items.push({
    key: "acExtra",
    description: `${acExtraMeters}m of Add'l. AC Cable`,
    directPrice: acExtraDirect,
    rto60Price: toRto(acExtraDirect),
  });

  const fixedOverheadDirect =
    adminParams.fixedOverheadDeliveryLogistics +
    adminParams.fixedOverheadWarehouse +
    adminParams.fixedOverheadCustoms +
    adminParams.fixedOverheadSafetySupervision +
    adminParams.fixedOverheadTesting;
  const laborDirect =
    systemKwp * adminParams.laborInstallationPerKwp +
    (panelsTotal === 0 ? 0 : fixedOverheadDirect);
  items.push({
    key: "labor",
    description: "Solar Labor & Installation",
    directPrice: laborDirect,
    rto60Price: toRto(laborDirect),
  });

  let rsdDirect = 0;
  if (rsdEnabled && panelsTotal > 0) {
    rsdDirect =
      panelCount * adminParams.rsdVariablePerPanel +
      adminParams.rsdFixedTransmitter;
  }
  let rsdStandaloneDirect = 0;
  if (rsdEnabled && panelsTotal === 0 && (rsdStandalonePanelCount || 0) > 0) {
    rsdStandaloneDirect =
      rsdStandalonePanelCount * adminParams.rsdVariablePerPanel +
      adminParams.rsdFixedTransmitter;
  }
  let rsdStandaloneLaborDirect = 0;
  if (rsdStandaloneDirect > 0) {
    rsdStandaloneLaborDirect =
      rsdStandalonePanelCount * adminParams.rsdStandaloneLaborPerPanel +
      adminParams.rsdStandaloneLaborMobilization;
  }
  const rsdPanelsForLabel = Math.max(panelCount, rsdStandalonePanelCount || 0);
  const rsdAnyDirect = rsdDirect + rsdStandaloneDirect;
  items.push({
    key: "rsd",
    description: `Rapid Shutdown Device (RSD) for ${rsdPanelsForLabel} Solar Panels`,
    directPrice: rsdAnyDirect,
    rto60Price: toRto(rsdAnyDirect),
  });
  items.push({
    key: "rsdLabor",
    description: "Labor & Installation for Standalone RSD order",
    directPrice: rsdStandaloneLaborDirect,
    rto60Price: toRto(rsdStandaloneLaborDirect),
  });

  selectedInverters.forEach((inv, i) => {
    const invDirect = inv
      ? directFromCogs(inv.cogs, adminParams, solarMargin)
      : 0;
    const desc = inv ? `${Number(inv.ratedKw).toFixed(2)} kW Inverter` : "None";
    items.push({
      key: `inverter${i}`,
      description: desc,
      directPrice: invDirect,
      rto60Price: toRto(invDirect),
    });
  });

  const pkg = resolveBatteryPackage(adminParams, state.batteryPackageId);
  const batteryCount =
    (batteryKwh || 0) > 0
      ? Math.ceil((batteryKwh || 0) / pkg.batteryUnitKwh)
      : 0;
  const rackCount =
    batteryCount > 0 ? Math.ceil(batteryCount / pkg.batteryRackCapacity) : 0;
  const batteryUnitPrice = directFromCogs(
    pkg.batteryUnitCogs,
    adminParams,
    batteryMargin,
  );
  const batteryRackPrice = directFromCogs(
    pkg.batteryRackCogs,
    adminParams,
    batteryMargin,
  );
  const atsPrice = directFromCogs(pkg.atsCogs, adminParams, batteryMargin);
  const critLoadsPrice = directFromCogs(
    pkg.criticalLoadsMaterialsCogs,
    adminParams,
    batteryMargin,
  );
  const batteryLaborWithSolarPrice = directFromCogs(
    pkg.laborWithSolarInstallCogs,
    adminParams,
    batteryMargin,
  );
  const batteryStandaloneLaborPrice = directFromCogs(
    pkg.standaloneLaborCogs,
    adminParams,
    batteryMargin,
  );

  const batteryDirect = batteryCount * batteryUnitPrice;
  const rackDirect = rackCount * batteryRackPrice;
  const atsDirect = batteryKwh > 0 ? atsPrice : 0;
  const critLoadDirect = batteryKwh > 0 ? critLoadsPrice : 0;
  const hasSolar = panelsTotal > 0;
  const battLaborDirect =
    batteryKwh > 0
      ? hasSolar
        ? batteryLaborWithSolarPrice
        : batteryStandaloneLaborPrice
      : 0;
  const battLaborLabel = hasSolar
    ? "Battery Labor & Installation w/ Solar Package Installation"
    : "Battery Standalone Labor & Installation";

  items.push({
    key: "battery",
    description: `${batteryCount} unit/s ${pkg.batteryUnitKwh}kWh Battery w/ Cables & Lugs`,
    directPrice: batteryDirect,
    rto60Price: toRto(batteryDirect),
  });
  items.push({
    key: "rack",
    description: `${rackCount} unit/s Battery Rack`,
    directPrice: rackDirect,
    rto60Price: toRto(rackDirect),
  });
  items.push({
    key: "ats",
    description: "Automatic Transfer Switch (ATS)",
    directPrice: atsDirect,
    rto60Price: toRto(atsDirect),
  });
  items.push({
    key: "critLoads",
    description: "Materials for Critical Loads",
    directPrice: critLoadDirect,
    rto60Price: toRto(critLoadDirect),
  });
  items.push({
    key: "batteryLabor",
    description: battLaborLabel,
    directPrice: battLaborDirect,
    rto60Price: toRto(battLaborDirect),
  });

  let invMobDirect = 0;
  const invCount = selectedInverters.filter((i) => i).length;
  if (panelsTotal === 0 && invCount > 0) {
    invMobDirect =
      adminParams.inverterStandaloneLaborPerUnit * invCount +
      adminParams.inverterStandaloneMobilization;
  }
  items.push({
    key: "invMob",
    description: "Mobilization for StandAlone Inverter Order",
    directPrice: invMobDirect,
    rto60Price: toRto(invMobDirect),
  });

  let roofDirect = 0;
  let roofLabel = "Roof Preparation (Metal - no prep needed)";
  if (panelsTotal > 0) {
    if (roofMaterial === "asphalt") {
      roofDirect = systemKwp * adminParams.roofAsphaltPerKwp;
      roofLabel = "Roof Preparation - Asphalt / Shingles / Tiled";
    } else if (roofMaterial === "concrete") {
      roofDirect = systemKwp * adminParams.roofConcretePerKwp;
      roofLabel = "Roof Preparation - Concrete";
    }
  }
  items.push({
    key: "roof",
    description: roofLabel,
    directPrice: roofDirect,
    rto60Price: toRto(roofDirect),
  });

  let locationDirect = 0;
  let locationLabel = "Location / Delivery - Luzon (within 30km)";
  if (panelsTotal > 0) {
    if (location === "cebu") {
      locationDirect =
        adminParams.cebuFixedFee + panelCount * adminParams.cebuPerPanel;
      locationLabel = "Location / Delivery - Cebu";
    } else if (location === "siargao") {
      locationDirect =
        adminParams.siargaoFixedFee + panelCount * adminParams.siargaoPerPanel;
      locationLabel = "Location / Delivery - Siargao";
    } else if (location === "luzon" && (locationKm || 0) > 30) {
      locationDirect =
        adminParams.luzonOver30FixedFee +
        (locationKm || 0) * adminParams.luzonOver30PerKm;
      locationLabel = `Location / Delivery - Luzon (${locationKm} km from Rizal Park)`;
    }
  }
  items.push({
    key: "location",
    description: locationLabel,
    directPrice: locationDirect,
    rto60Price: toRto(locationDirect),
  });

  (miscMaterials || []).forEach((row, i) => {
    if (!row || !row.count) {
      items.push({
        key: `misc${i}`,
        description: "",
        directPrice: 0,
        rto60Price: 0,
      });
      return;
    }

    const catId = row.catalogId;
    const isCatalog = catId && catId !== "other";
    if (isCatalog) {
      const item = (adminParams.miscCatalog || []).find(
        (m) => m && m.id === catId,
      );
      if (!item || item.available === false) {
        items.push({
          key: `misc${i}`,
          description: "",
          directPrice: 0,
          rto60Price: 0,
        });
        return;
      }
      const dir =
        row.count * directFromCogs(item.cogs, adminParams, miscMargin);
      items.push({
        key: `misc${i}`,
        description: `${row.count} Unit/s ${item.label}`,
        directPrice: dir,
        rto60Price: toRto(dir),
      });
      return;
    }

    if (!row.description || !row.unitPrice) {
      items.push({
        key: `misc${i}`,
        description: "",
        directPrice: 0,
        rto60Price: 0,
      });
      return;
    }

    const dir = row.count * row.unitPrice;
    items.push({
      key: `misc${i}`,
      description: `${row.count} Unit/s ${row.description}`,
      directPrice: dir,
      rto60Price: toRto(dir),
    });
  });

  const totalDirect = items.reduce((s, i) => s + i.directPrice, 0);
  const totalRto60 = items.reduce((s, i) => s + i.rto60Price, 0);

  return {
    items,
    totalDirect,
    totalRto60,
    rtoRate,
    systemKwp,
    panelPriceEa,
  };
}

function computePaymentTerms(state, adminParams, packageData) {
  const { tenor, downPaymentPct, promoCode } = state;
  const { totalRto60, rtoRate } = packageData;
  const monthlyRate = rtoRate / 12;

  const promo = adminParams.promoCodes.find(
    (p) => p.code === (promoCode || "").trim().toUpperCase(),
  );
  const promoDiscount = promo ? promo.discount : 0;
  const discountAmount = -promoDiscount * totalRto60;
  const stepTwoTotalLessDiscount = totalRto60 + discountAmount;

  const directPurchasePrice = PV(
    monthlyRate,
    60,
    -stepTwoTotalLessDiscount / 60,
    0,
    1,
  );
  const safeTenor = Math.max(
    1,
    Math.min(
      Number.isInteger(adminParams.maxTenorMonths)
        ? adminParams.maxTenorMonths
        : 60,
      Math.round(tenor),
    ),
  );
  const monthlyForFullPv = PMT(
    monthlyRate,
    safeTenor,
    -directPurchasePrice,
    0,
    1,
  );
  const totalPaymentsOverTenor = monthlyForFullPv * safeTenor;

  const minDpPct = resolveMinDpPct(
    adminParams.minDpTiers,
    totalPaymentsOverTenor,
  );
  const safeDpPct = Math.max(minDpPct, Math.min(0.5, downPaymentPct || 0));

  const dpAmount = safeDpPct * totalPaymentsOverTenor;
  const dpTotalCharge = dpAmount;
  const dpFvOneMonth = dpAmount * (1 + monthlyRate);
  const postDpPv = directPurchasePrice - dpFvOneMonth;
  const monthlyAfterDp = PMT(monthlyRate, safeTenor, -postDpPv, 0, 1);
  const postInstallBalance = totalPaymentsOverTenor - dpAmount;
  const netBalanceOverTenor = monthlyAfterDp * safeTenor;
  const savingsFromDp = netBalanceOverTenor - postInstallBalance;
  const customerMonthlyPmt = monthlyAfterDp;
  const finalPostInstallBalance = netBalanceOverTenor;
  const totalAmountDue = finalPostInstallBalance + dpTotalCharge;

  return {
    rtoRate,
    promo,
    promoDiscountAmount: discountAmount,
    stepTwoTotalLessDiscount,
    directPurchasePrice,
    monthlyForFullPv,
    totalPaymentsOverTenor,
    epdAmount: totalPaymentsOverTenor - stepTwoTotalLessDiscount,
    minDpPct,
    usedDpPct: safeDpPct,
    usedTenor: safeTenor,
    dpAmount,
    dpTotalCharge,
    postDpPv,
    monthlyAfterDp,
    customerMonthlyPmt,
    postInstallBalance,
    netBalanceOverTenor,
    savingsFromDp,
    finalPostInstallBalance,
    totalAmountDue,
    negativeBalance: netBalanceOverTenor < 0,
  };
}
