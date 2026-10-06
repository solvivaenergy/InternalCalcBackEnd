// =============================================================================
// DEVICE LIBRARY — Admin sheet rows 5–20
// -----------------------------------------------------------------------------
// Each device has a peak power rating (kW) and a "% of peak" duty factor.
// Average power consumed while ON = peakKw * dutyFactor. The duty factor
// captures things like:
//   • An air-conditioner cycles on/off → ~50% duty
//   • A microwave runs flat-out         → 100% duty
//   • A motor under partial load        → ~70% duty
//
// In the Excel CALCULATOR sheet, customers select up to 7 devices in the
// O15:T22 region; lookups against this list use VLOOKUP with column 4 (Avg).
// =============================================================================

export const DEVICES = [
  { name: '1.0hp AC',              peakKw: 1.0,  dutyFactor: 0.5 },
  { name: '1.5hp AC',              peakKw: 1.3,  dutyFactor: 0.5 },
  { name: '2.0hp AC',              peakKw: 1.8,  dutyFactor: 0.5 },
  { name: '2.5hp AC',              peakKw: 2.0,  dutyFactor: 0.5 },
  { name: '3.0hp AC',              peakKw: 2.8,  dutyFactor: 0.5 },
  { name: 'Microwave/Toaster',     peakKw: 1.0,  dutyFactor: 1.0 },
  { name: '6" Stove Burner',       peakKw: 1.5,  dutyFactor: 0.9 },
  { name: '8" Stove Burner',       peakKw: 2.5,  dutyFactor: 0.9 },
  { name: 'Electric Oven',         peakKw: 3.0,  dutyFactor: 0.8 },
  { name: 'Level-1 EV Charger',    peakKw: 1.5,  dutyFactor: 0.9 },
  { name: 'Level-2 EV Charger',    peakKw: 9.6,  dutyFactor: 0.9 },
  { name: 'Washing Machine',       peakKw: 0.8,  dutyFactor: 0.7 },
  { name: 'Elec Clothes Dryer',    peakKw: 5.0,  dutyFactor: 0.8 },
  { name: '1kW Motor Load',        peakKw: 1.0,  dutyFactor: 0.7 },
  { name: '5kW Heating Element',   peakKw: 5.0,  dutyFactor: 0.8 },
  { name: '20W Lighting Element',  peakKw: 0.020, dutyFactor: 1.0 },
];

// Day boundary: Excel formulas use 6/24 (i.e. 6:00 AM) as the start of "day".
// Day window is 6:00 AM → 6:00 PM (12 hours), Night is 6:00 PM → 6:00 AM.
// Used by the day/night kWh calculation in lib/calculations.js.
export const DAY_START_HOUR = 6;
