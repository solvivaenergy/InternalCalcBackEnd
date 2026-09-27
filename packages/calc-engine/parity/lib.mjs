// Shared by capture.mjs / compare.mjs: deterministic serialisation, the
// scenario battery, and the fixed quote date every capture uses.
export const GENERATED_DATE = new Date(Date.UTC(2026, 8, 27, 2, 0, 0));

// Deterministic JSON: sorted keys, Dates as ISO, NaN / ±Infinity / undefined /
// functions as tagged strings so they compare instead of vanishing. `seen` is
// the current ancestor chain, not everything visited: a shared reference (the
// same package object under two keys) serialises twice; only a cycle is cut.
export function stableStringify(value) {
  return JSON.stringify(norm(value, new WeakSet()));
}
function norm(v, seen) {
  if (v === undefined) return "__undefined__";
  if (typeof v === "number") return Number.isFinite(v) ? v : `__${String(v)}__`;
  if (typeof v === "function") return "__function__";
  if (v instanceof Date) return { __date: Number.isNaN(v.getTime()) ? "Invalid" : v.toISOString() };
  if (Array.isArray(v)) {
    if (seen.has(v)) return "__cycle__";
    seen.add(v);
    const out = v.map((x) => norm(x, seen));
    seen.delete(v);
    return out;
  }
  if (v && typeof v === "object") {
    if (seen.has(v)) return "__cycle__";
    seen.add(v);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k], seen);
    seen.delete(v);
    return out;
  }
  return v;
}

// Same shape as App.jsx makeInitialState('all'), read from the live params
// the way the app does after paramsService.load().
export function baseState(ap) {
  return {
    phase: 1,
    utilityRate: ap.defaultUtilityRate,
    monthlyBill: ap.defaultMonthlyBill,
    deviceRows: [emptyRow(), emptyRow()],
    desiredSavingsPct: 0.5,
    optimizationMode: "panels",
    conservativeSizing: false,
    panelCount: null,
    dcCableMeters: 30,
    acCableMeters: 10,
    rsdEnabled: false,
    rsdStandalonePanelCount: 3,
    selectedInverters: [null, null, null],
    expansionMode: false,
    existingKwp: null,
    existingInverterKw: null,
    batteryKwh: null,
    batteryRackIncluded: true,
    batteryAtsIncluded: true,
    batteryCritLoadsIncluded: true,
    batteryPackageId: null,
    netMeteringEnabled: false,
    roofMaterial: "metal",
    location: "luzon",
    locationRegion: "NCR",
    locationProvince: null,
    locationCity: "Manila",
    locationKm: 18,
    miscMaterials: [],
    tenor: 0,
    downPaymentPct: ap.defaultDownPaymentPct,
    promoCode: "",
    irrYears: ap.irrYearsDefault ?? 25,
    duRateInflation: ap.duRateInflationDefault ?? 0,
  };
}
const emptyRow = () => ({ deviceName: null, count: 1, onTime: null, offTime: null, daysPerWeek: null });
// onTime/offTime are fractions of a day (Excel time values): 22 → 22/24.
const H = (h) => (h == null ? null : h / 24);
const row = (deviceName, count, on, off, daysPerWeek) => ({ deviceName, count, onTime: H(on), offTime: H(off), daysPerWeek });

// 46 scenarios spanning phase, bill size, savings target, device rows (7-day
// and sub-7-day), the three optimisation modes, overrides (panels, battery,
// package, inverter), tenors and DP, promo, location, roof, RSD, cables,
// expansion, net metering, dropped battery components, misc rows, IRR/DU.
export function scenarios(snap) {
  const ap = snap.adminParams;
  const inv1 = snap.invertersSinglePhase || [];
  const pkgs = ap.batteryPackages || [];
  const promo = (ap.promoCodes || [])[0]?.code || "";
  const s = {};
  const add = (id, patch) => { s[id] = { ...baseState(ap), ...patch }; };
  const devRows7 = [row("1.5hp AC", 2, 22, 6, 7), row("Microwave/Toaster", 1, 7, 8, 7), row("Level-2 EV Charger", 1, 20, 23, 7)];
  const devRowsSub7 = [row("2.0hp AC", 1, 21, 5, 7), row("Elec Clothes Dryer", 1, 9, 11, 3)];

  add("S01_default", {});
  add("S02_threePhase", { phase: 3 });
  add("S03_bill3k", { monthlyBill: 3000 });
  add("S04_bill8k", { monthlyBill: 8000 });
  add("S05_bill15k", { monthlyBill: 15000 });
  add("S06_bill40k", { monthlyBill: 40000 });
  add("S07_bill120k", { monthlyBill: 120000 });
  add("S08_bill120k_3p", { monthlyBill: 120000, phase: 3 });
  add("S09_sav30", { desiredSavingsPct: 0.3 });
  add("S10_sav80", { desiredSavingsPct: 0.8 });
  add("S11_sav100", { desiredSavingsPct: 1 });
  add("S12_devices7", { monthlyBill: 12000, deviceRows: devRows7 });
  add("S13_sub7", { monthlyBill: 12000, deviceRows: devRowsSub7 });
  add("S14_sub7_sav100_locked", { monthlyBill: 12000, deviceRows: devRowsSub7, desiredSavingsPct: 1 });
  add("S15_sub7_conservative", { monthlyBill: 12000, deviceRows: devRowsSub7, conservativeSizing: true });
  add("S16_modeBattery", { optimizationMode: "battery" });
  add("S17_modeCost", { optimizationMode: "cost" });
  add("S18_modeBattery_devices", { optimizationMode: "battery", monthlyBill: 18000, deviceRows: devRows7 });
  add("S19_panels12", { panelCount: 12 });
  add("S20_panels40_3p", { panelCount: 40, phase: 3, monthlyBill: 60000 });
  add("S21_batt10", { batteryKwh: 10 });
  add("S22_batt0", { batteryKwh: 0 });
  add("S23_battPkg2", { batteryPackageId: pkgs[1]?.id ?? pkgs[0]?.id ?? null });
  add("S24_tenor12_dp20", { tenor: 12, downPaymentPct: 0.2 });
  add("S25_tenor36_dp30", { tenor: 36, downPaymentPct: 0.3 });
  add("S26_tenor60_dp50", { tenor: 60, downPaymentPct: 0.5 });
  add("S27_tenor60_dp05", { tenor: 60, downPaymentPct: 0.05 });
  add("S28_promo", { promoCode: promo, tenor: 60, downPaymentPct: 0.3 });
  add("S29_luzon80km", { locationKm: 80, locationRegion: "R3", locationCity: "Tarlac" });
  add("S30_cebu", { location: "cebu" });
  add("S31_other", { location: "other" });
  add("S32_asphalt", { roofMaterial: "asphalt" });
  add("S33_concrete", { roofMaterial: "concrete" });
  add("S34_rsd", { rsdEnabled: true });
  add("S35_rsd5_noPanels", { rsdEnabled: true, rsdStandalonePanelCount: 5, panelCount: 0 });
  add("S36_cables", { dcCableMeters: 60, acCableMeters: 25 });
  add("S37_expansion", { expansionMode: true, existingKwp: 5, existingInverterKw: 5, panelCount: 8 });
  add("S38_netMetering", { netMeteringEnabled: true, tenor: 60, downPaymentPct: 0.3 });
  add("S39_battComponentsOff", { batteryKwh: 10, batteryRackIncluded: false, batteryAtsIncluded: false, batteryCritLoadsIncluded: false });
  add("S40_misc", { miscMaterials: [
    { catalogId: "other", description: "Extra bracket", count: 2, unitPrice: 1500 },
    { catalogId: (ap.miscCatalog || [])[0]?.id ?? "other", description: "", count: 1, unitPrice: 0 },
  ] });
  add("S41_irr20_infl3", { irrYears: 20, duRateInflation: 0.03, tenor: 60, downPaymentPct: 0.3 });
  add("S42_inverterPick", { selectedInverters: [inv1[1] ? { ...inv1[1] } : null, null, null] });
  add("S43_combo3p", { phase: 3, monthlyBill: 90000, deviceRows: devRows7, optimizationMode: "cost", tenor: 60, downPaymentPct: 0.3, rsdEnabled: true, roofMaterial: "asphalt", location: "cebu", batteryKwh: 20, promoCode: promo });
  add("S44_rate1178", { utilityRate: 11.78 });
  add("S45_bill500", { monthlyBill: 500 });
  add("S46_sav0", { desiredSavingsPct: 0 });
  return s;
}
