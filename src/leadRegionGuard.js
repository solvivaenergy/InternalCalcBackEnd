// Lead ↔ region guard (v3-231, 2026-10-28). A quote belongs to one region, so
// when a rep prices with the Cebu parameters against a Manila lead (or the
// other way round) the calculator should say so. WARNING ONLY — the lookup and
// the quotation push still succeed; the frontend shows the code.
//
// Odoo has no Cebu branch, company or team yet (one company, id 1, on both
// builds), so there is nothing authoritative to compare against. Until a
// region's `adminParams.odooCompanyId` is set (the branch Finance will register
// once the Cebu office has its BIR registration), the guard reads the lead's
// address: `state_id` (res.country.state) and the Studio `x_studio_province`
// decide; `city` is consulted only when both are empty, and then only against
// LGU names that exist nowhere else in the country (Talisay, Naga, Toledo,
// Carmen, San Fernando, Liloan, Danao, Alegria, Tuburan, Sogod, San Remigio,
// Alcantara and Compostela all have namesakes and are deliberately absent).
import { readParametersPayload } from "./parametersService.js";
import { DEFAULT_REGION, regionLabel } from "./regions.js";

// The extra crm.lead fields both Odoo services read for the guard.
export const LEAD_REGION_FIELDS = Object.freeze(["state_id", "city", "x_studio_province", "company_id"]);

const CEBU_RE = /\bcebu\b/i;
const UNAMBIGUOUS_CEBU_LGUS = [
  "mandaue", "lapu-lapu", "lapu lapu", "cordova", "consolacion", "minglanilla",
  "carcar", "bogo", "argao", "moalboal", "oslob", "balamban", "dalaguete", "badian",
  "barili", "sibonga", "dumanjug", "alcoy", "boljoon", "samboan", "santander",
  "ginatilan", "malabuyoc", "asturias", "tabuelan", "borbon", "catmon", "tabogon",
  "medellin", "daanbantayan", "pinamungajan", "aloguinsan", "ronda",
];

const text = (v) => (typeof v === "string" ? v.trim() : "");

// → null (no concern) | { code, detail }. `detail` is a clause the services
// drop into a sentence ("… but the Odoo lead's address says "Bulacan".").
export function leadRegionWarning({ lead, region = DEFAULT_REGION, odooCompanyId = null }) {
  if (!lead || typeof lead !== "object") return null;

  // Authoritative path once the region has an Odoo company/branch id.
  const companyId = Number.isInteger(odooCompanyId) && odooCompanyId > 0 ? odooCompanyId : null;
  if (companyId) {
    const leadCompany = Array.isArray(lead.company_id) ? lead.company_id[0] : null;
    if (leadCompany && leadCompany !== companyId) {
      return {
        code: "lead_company_mismatch",
        detail: `the Odoo lead belongs to company #${leadCompany}, not the ${regionLabel(region)} company #${companyId}`,
      };
    }
    return null;
  }

  // Heuristic path: province-level fields first.
  const state = Array.isArray(lead.state_id) ? text(lead.state_id[1]) : text(lead.state_id);
  const province = text(lead.x_studio_province);
  const city = text(lead.city);
  const provinceText = [state, province].filter(Boolean).join(" ");

  let isCebu;
  let basis;
  if (provinceText) {
    isCebu = CEBU_RE.test(provinceText);
    basis = provinceText;
  } else if (city) {
    const c = city.toLowerCase();
    isCebu = CEBU_RE.test(c) || UNAMBIGUOUS_CEBU_LGUS.some((name) => c.includes(name));
    basis = city;
    // A city that does not look like Cebu is weak evidence on its own
    // (namesakes), so for a Cebu quote it is "unknown", not a mismatch.
    if (!isCebu && region === "cebu") {
      return { code: "lead_region_unknown", detail: `the Odoo lead has no province, only the city "${city}"` };
    }
  } else {
    return { code: "lead_region_unknown", detail: "the Odoo lead has no province or city" };
  }

  if ((region === "cebu") !== isCebu) {
    return { code: "lead_region_mismatch", detail: `the Odoo lead's address says "${basis}"` };
  }
  return null;
}

// adminParams.odooCompanyId for a region, read through the parameters service
// with a short cache (the two Odoo services call this once per request).
// Any failure ⇒ null ⇒ the heuristic path; the guard never blocks a lookup.
const COMPANY_CACHE_MS = 30_000;
const companyCache = new Map(); // region → { at, value }
export async function odooCompanyIdFor(region = DEFAULT_REGION) {
  const hit = companyCache.get(region);
  if (hit && Date.now() - hit.at < COMPANY_CACHE_MS) return hit.value;
  let value = null;
  try {
    const payload = await readParametersPayload(region);
    const raw = payload?.adminParams?.odooCompanyId;
    value = Number.isInteger(raw) && raw > 0 ? raw : null;
  } catch (err) {
    console.warn("[lead-region] parameters unavailable; using the address heuristic", {
      region,
      reason: String(err && err.message).slice(0, 120),
    });
  }
  companyCache.set(region, { at: Date.now(), value });
  return value;
}
