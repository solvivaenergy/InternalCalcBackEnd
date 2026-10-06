// =============================================================================
// BILL OF QUANTITIES — package inclusions with quantities (story 064J)
// -----------------------------------------------------------------------------
// Builds the rows the calculator sends to Odoo's Bill of Quantities table
// (064K) from the engine's line items. The row set mirrors page 3 of the
// proposal, "System package in detail" (pdfGenerator.js drawPackageDetailPage):
// the same three groups, the same order, the same inclusion rules — so what
// Odoo records is what the customer was shown. Prices are deliberately absent.
//
// QUANTITY RULES (product decision pending review — see the deployment plan):
//   • counted items carry their count: panels, battery units, racks,
//     inverters (one per slot), 2F write-in rows, the RSD (one per panel
//     covered, as the engine prices it);
//   • metered items carry metres: the excess DC / AC cable runs;
//   • everything priced as a bundle is ONE lot: mounting, cabling bundle,
//     labour, ATS, critical-load materials, roof preparation, delivery.
//
// Framework-free and dependency-free on purpose so it can be exercised in Node
// with a hand-built model (see the smoke check in scripts/).
// =============================================================================

export const PACKAGE_LABELS = {
  A: "A. Solar Package",
  B: "B. Battery Package",
  C: "C. Misc. Materials, Labor, Services & Other Adjustments",
};

const LOT_KEYS = new Set([
  "mounting", "cabling", "labor", "rsdLabor", "invMob",
  "ats", "critLoads", "batteryLabor", "roof", "location",
]);

const UNIT_BY_KEY = {
  panels: "pc",
  battery: "unit",
  rack: "unit",
  rsd: "pc",
  dcExtra: "m",
  acExtra: "m",
};

function leadingInt(text) {
  const m = String(text || "").match(/^\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// One row. `product` is the short product name; `description` is the engine's
// own line text, which is what the proposal printed.
function row(pkg, key, product, description, quantity, unit) {
  return {
    package: pkg,
    packageLabel: PACKAGE_LABELS[pkg],
    key,
    product,
    description,
    quantity: Number.isFinite(quantity) && quantity >= 0 ? round3(quantity) : 1,
    unit,
  };
}

// Short product names for the engine's fixed keys. Free-form 2F rows use their
// own description.
const PRODUCT_BY_KEY = {
  panels: "Solar Panels",
  mounting: "Mounting Support",
  cabling: "Cables, Conduits, Fittings, Panel Board & Other Devices",
  labor: "Solar Labor & Installation",
  inverter0: "Inverter",
  inverter1: "Inverter",
  inverter2: "Inverter",
  dcExtra: "Additional DC Cable",
  acExtra: "Additional AC Cable",
  roof: "Roof Preparation",
  rsd: "Rapid Shutdown Device (RSD)",
  rsdLabor: "RSD Labor & Installation",
  invMob: "Inverter Mobilization",
  battery: "Battery",
  rack: "Battery Rack",
  ats: "Automatic Transfer Switch (ATS)",
  critLoads: "Materials for Critical Loads",
  batteryLabor: "Battery Labor & Installation",
  location: "Delivery & Logistics",
};

/**
 * @param {object} args
 * @param {object} args.model  App.jsx's computed model (pkg.items, panelCount,
 *                             batteryKwh, activeBatteryPackage, ...)
 * @param {object} args.state  calculator state (miscMaterials, ...)
 * @returns {Array<{package, packageLabel, key, product, description, quantity, unit}>}
 */
export function buildBoqLines({ model, state }) {
  const items = (model && model.pkg && Array.isArray(model.pkg.items)) ? model.pkg.items : [];
  const byKey = (k) => items.find((i) => i && i.key === k);
  // Same predicates as the PDF page.
  const groupOf = (i) => (i.key === "roof" ? "solar" : i.category || "misc");
  const printable = (i) => !!(i && i.description && i.description !== "None" && i.directPrice !== 0);
  const panelCount = model.panelCount ?? state?.panelCount ?? 0;
  const misc = Array.isArray(state?.miscMaterials) ? state.miscMaterials : [];

  const rows = [];

  // Quantity for a 2F write-in row: the rep's count, else the number the
  // engine put at the front of the description ("2 Unit/s …").
  const miscQty = (item) => {
    const idx = Number((String(item.key).match(/^misc(\d+)$/) || [])[1]);
    const stateRow = Number.isFinite(idx) ? misc[idx] : null;
    const count = stateRow && Number(stateRow.count);
    return Number.isFinite(count) && count > 0 ? count : (leadingInt(item.description) ?? 1);
  };
  const miscProduct = (item) =>
    String(item.description || "").replace(/^\s*\d+\s*unit\/?s?\s*/i, "").trim() || item.description;

  // ── A · Solar ─────────────────────────────────────────────────────────────
  const solar = (key, quantity, unit) => {
    const it = byKey(key);
    if (!printable(it)) return;
    rows.push(row("A", key, PRODUCT_BY_KEY[key] || it.description, it.description, quantity, unit));
  };
  solar("panels", panelCount > 0 ? panelCount : leadingInt(byKey("panels")?.description) ?? 1, "pc");
  solar("mounting", 1, "lot");
  solar("cabling", 1, "lot");
  solar("labor", 1, "lot");
  ["inverter0", "inverter1", "inverter2"].forEach((k) => solar(k, 1, "unit"));
  if (panelCount > 0) {
    // Static inclusion line, printed on every solar proposal (pdfGenerator).
    rows.push(row("A", "acBreaker", "AC Breaker, 2-pole", "1 Unit/s AC Breaker, 30AT to 125AT, 2-pole", 1, "unit"));
    ["dcExtra", "acExtra"].forEach((k) => {
      const it = byKey(k);
      const meters = it && Number.isFinite(it.meters) ? it.meters : null;
      const show = meters == null ? printable(it) : meters > 0;
      if (it && it.description && show) {
        rows.push(row("A", k, PRODUCT_BY_KEY[k], it.description, meters ?? 1, "m"));
      }
    });
  }
  // Roof preparation is label-only on the PDF (₱0 for the default metal roof)
  // but it is an inclusion, so it is listed whenever panels are mounted.
  const roofItem = byKey("roof");
  if (panelCount > 0 && roofItem && roofItem.description) {
    rows.push(row("A", "roof", PRODUCT_BY_KEY.roof, roofItem.description, 1, "lot"));
  }
  // RSD: only when supplied. A declined RSD prints on the proposal as
  // "excluded per client instruction" and is NOT a quantity to deliver.
  const rsd = byKey("rsd");
  const rsdDeclined = !!(rsd && (rsd.declined || (rsd.directPrice || 0) === 0));
  if (rsd && !rsdDeclined && (rsd.directPrice || 0) > 0) {
    const covered = Number((String(rsd.description).match(/for\s+(\d+)\s+solar/i) || [])[1]);
    rows.push(row("A", "rsd", PRODUCT_BY_KEY.rsd, rsd.description, covered > 0 ? covered : panelCount || 1, "pc"));
  }
  solar("rsdLabor", 1, "lot");
  solar("invMob", 1, "lot");
  items.filter((i) => groupOf(i) === "solar" && /^misc\d+$/.test(i.key || "") && printable(i))
    .forEach((i) => rows.push(row("A", i.key, miscProduct(i), i.description, miscQty(i), "unit")));

  // ── B · Battery ───────────────────────────────────────────────────────────
  const batteryUnitKwh = Number(model.activeBatteryPackage?.batteryUnitKwh) || 0;
  const batteryKwh = Number(model.batteryKwh) || 0;
  const batteryCount = batteryUnitKwh > 0 && batteryKwh > 0 ? Math.ceil(batteryKwh / batteryUnitKwh) : null;
  const battery = (key, quantity, unit) => {
    const it = byKey(key);
    if (!printable(it)) return;
    rows.push(row("B", key, PRODUCT_BY_KEY[key] || it.description, it.description, quantity, unit));
  };
  battery("battery", batteryCount ?? leadingInt(byKey("battery")?.description) ?? 1, "unit");
  battery("rack", leadingInt(byKey("rack")?.description) ?? 1, "unit");
  battery("ats", 1, "unit");
  battery("critLoads", 1, "lot");
  battery("batteryLabor", 1, "lot");
  items.filter((i) => groupOf(i) === "battery" && /^misc\d+$/.test(i.key || "") && printable(i))
    .forEach((i) => rows.push(row("B", i.key, miscProduct(i), i.description, miscQty(i), "unit")));

  // ── C · Misc ──────────────────────────────────────────────────────────────
  items.filter((i) => groupOf(i) === "misc" && printable(i)).forEach((i) => {
    if (/^misc\d+$/.test(i.key || "")) {
      rows.push(row("C", i.key, miscProduct(i), i.description, miscQty(i), "unit"));
    } else {
      rows.push(row("C", i.key, PRODUCT_BY_KEY[i.key] || i.description, i.description, 1, LOT_KEYS.has(i.key) ? "lot" : (UNIT_BY_KEY[i.key] || "unit")));
    }
  });

  return rows;
}
