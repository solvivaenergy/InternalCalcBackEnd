// =============================================================================
// INVENTORY — Solar panels and inverters
// -----------------------------------------------------------------------------
// Mirrors the Excel "Inventory" sheet:
//   • Single-phase panel + inverters (cols A–J)
//   • 3-phase panel + inverters     (cols M–U)
//
// The inverter list IS the available stock — admins maintain it by
// adding/removing rows in the Inventory editor. The Excel sheet had a
// per-row availability checkbox (column E single-phase / P 3-phase); we
// dropped it in v3 — and REINSTATED it in v3-106 as the `available` flag:
// an out-of-stock SKU keeps its row (and pricing history) but is excluded
// from recommendations and the Step 2C dropdown. Absent flag = available
// (so pre-v3-106 blobs need no migration).
//
// Sorting: lib/calculations.js sorts these largest-first to mirror the
// original Excel VLOOKUP behavior when picking inverter sizes.
//
// v3.2 Excel switch: panel direct price is now a literal value in
// Inventory!D3 (₱8,600 single-phase), no longer a markup-formula derived
// from a supplier cost. Old web app used `markup(9008) ≈ 8,538` — replaced
// with the literal Excel value to keep the math identical.
// =============================================================================

// ─── Panel & DC/AC ratio settings ────────────────────────────────────────────
// Inventory!C3, C5 (single-phase) / N3, N5 (3-phase).

export const PANEL_SETTINGS = {
  singlePhase: {
    available: true,                      // v3-106 — stock flag; false = out of stock (Step 1A phase stays selectable; the quote's solar array is forced to 0 panels)
    panelWatts: 630,                      // C3
    panelCogs: 6200,                      // v3-83 — COGS (pre-VAT), Engineering-entered
    panelDirectPrice: 0,                  // DERIVED from panelCogs
    maxDcAcRatio: 1.3,                    // C5
  },
  threePhase: {
    available: true,                      // v3-106 — stock flag (see singlePhase)
    panelWatts: 650,                      // N3
    panelCogs: 6200,                      // v3-83 — COGS (pre-VAT). Anjon's sheet gives the
                                          // SAME 6,200 for both phases (was 8,600 / 9,000).
    panelDirectPrice: 0,                  // DERIVED from panelCogs
    maxDcAcRatio: 1.6,                    // N5  (v3: was 1.3)
  },
};

// ─── Inverter catalog — single-phase ─────────────────────────────────────────
// The list IS the available stock — if it's listed, customers can pick it.
// Admins manage this list by adding/removing rows in the Inventory editor.
// Sorted ascending by kW for tidy display.
// v3-83 — `cogs` (pre-VAT) is now the Engineering-entered field; `directPrice`
// is DERIVED (see deriveDirectPrices in calculations.js) and is never stored.
export const INVERTERS_SINGLE_PHASE = [
  { ratedKw: 5,   cogs: 37000,  directPrice: 0, available: true },
  { ratedKw: 6,   cogs: 42000,  directPrice: 0, available: true },
  { ratedKw: 8,   cogs: 60000,  directPrice: 0, available: true },
  { ratedKw: 12,  cogs: 108000, directPrice: 0, available: true },
  { ratedKw: 16,  cogs: 139000, directPrice: 0, available: true },
];

// ─── Inverter catalog — 3-phase ──────────────────────────────────────────────
// The list IS the available stock — if it's listed, customers can pick it.
// Admins manage this list by adding/removing rows in the Inventory editor.
// Sorted ascending by kW for tidy display.
export const INVERTERS_THREE_PHASE = [
  // ⚠ v3-83 — the 5 kW three-phase has NO COGS in Anjon's sheet (his 3-phase list
  // starts at 10 kW). Its COGS is BACK-SOLVED from the existing ₱67,142 so the SKU
  // does not silently reprice. CONFIRM WITH ANJON: either give it a real COGS, or
  // drop the SKU.
  { ratedKw: 5,   cogs: 36909,  directPrice: 0, available: true },
  { ratedKw: 10,  cogs: 111000, directPrice: 0, available: true },
  { ratedKw: 16,  cogs: 177600, directPrice: 0, available: true },
  { ratedKw: 20,  cogs: 222000, directPrice: 0, available: true },
  { ratedKw: 30,  cogs: 333000, directPrice: 0, available: true },
  { ratedKw: 50,  cogs: 555000, directPrice: 0, available: true },
];
