// =============================================================================
// PH PHONE NORMALISATION — shared by every Odoo-facing service
// -----------------------------------------------------------------------------
// The calculator's own validator (frontend src/lib/validation.js isValidPhPhone)
// requires 11+ digits starting "09". Odoo's dominant storage format is "+639…"
// (175,587 leads), which FAILS that validator — and formatPhPhone passes non-09
// input through unchanged, so it cannot rescue it. Populating the raw Odoo value
// would hand the rep a number they did not type, mark it invalid, and block
// "Save changes". So normalise here, and return null rather than guess.
//
// Allowlist only: every shape not explicitly matched returns null so the rep
// types it manually. Notably "0919 0916 155 - 09913005620" (22 digits) would
// PASS isValidPhPhone verbatim and then be silently truncated by formatPhPhone,
// so "passes the validator" is not on its own a safe test.
//
// Lived in crmContactService.js (story 043D) until the lead's salesperson
// needed the same rule (odooSalespersonService.js); crmContactService still
// re-exports it for existing importers.
// =============================================================================

export function normalisePhPhone(raw) {
  if (!raw || typeof raw !== "string") return null;
  // Multi-number fields are real ("+639437295737 /  0933 8664343"). Try each
  // token, first success wins. NOT split on "-": that is the separator in the
  // app's own display format, 0917-841-5976.
  for (const token of raw.split(/\s*[/,;]\s*/)) {
    let d = token.replace(/\D+/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    let out = null;
    if (d.length === 12 && d.startsWith("63")) out = `0${d.slice(2)}`;
    else if (d.length === 11 && d.startsWith("09")) out = d;
    else if (d.length === 10 && d.startsWith("9")) out = `0${d}`;
    if (out) return out;
  }
  return null;
}
