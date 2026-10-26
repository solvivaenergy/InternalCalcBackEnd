// Small helpers shared by the MCP modules.

export const VAT_RATE = 0.12; // Philippine VAT — a constant in the engine too.

export function round2(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : v == null ? null : v;
}

export function round4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v == null ? null : v;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function isoDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return d ?? null;
  return d.toISOString().slice(0, 10);
}

// Manila wall-clock rendering of an instant, for human-facing fields.
const manilaFmt = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export function manila(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return `${manilaFmt.format(date)} PHT`;
}

// Recursively: drop undefined, turn NaN/Infinity into null, Dates into ISO
// strings, and round floats to 4 decimals so JSON stays short. Money fields
// are rounded by the callers to 2 decimals before this runs.
export function tidy(value) {
  if (value == null) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? value : Math.round(value * 10000) / 10000;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(tidy);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = tidy(v);
    }
    return out;
  }
  return value;
}

export class ToolError extends Error {}
