// Regions (v3-231, 2026-10-28). One calculator serves more than one office —
// Manila (region id `luzon`, today's behaviour) and Cebu (`cebu`) — and each
// region has its OWN parameter payload (public.region_parameters, one row per
// region). This module is the single allowlist: the parameters routes parse
// `?region=` with it, the users routes validate `app_metadata.regions` with
// it, and the Odoo services label warnings with it. Adding a region later is
// one entry here plus one seeded row (scripts/seed-region-parameters.mjs) —
// no schema change (the table deliberately has no CHECK on `region`).
//
// Ids are internal and never change: `luzon` stays `luzon` because every saved
// quote, the engine's structural location id and the legacy app_parameters
// mirror already use it. Labels are what people see.

export const REGIONS = Object.freeze(["luzon", "cebu"]);
export const DEFAULT_REGION = "luzon";
export const REGION_LABELS = Object.freeze({ luzon: "Manila", cebu: "Cebu" });

export const regionLabel = (region) => REGION_LABELS[region] || String(region);

// `?region=` on a route. Absent/blank ⇒ the default region, which is exactly
// the pre-region behaviour, so a frontend that does not send the parameter
// keeps working. `allowAll` is for the audit history only ("every region").
export function parseRegion(raw, { allowAll = false } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { region: DEFAULT_REGION };
  }
  const value = String(raw).trim().toLowerCase();
  if (allowAll && value === "all") return { region: "all" };
  if (REGIONS.includes(value)) return { region: value };
  return {
    error: `region must be one of: ${REGIONS.join(", ")}${allowAll ? ", all" : ""}.`,
  };
}

// The regions an auth user may use, from auth.users.app_metadata.regions.
// Missing, empty or unrecognised ⇒ [DEFAULT_REGION]: every account that existed
// before regions were introduced is a Manila account, and the RLS policy on
// region_parameters applies the same rule, so no backfill is needed.
export function regionsFromAppMetadata(appMetadata) {
  const raw = appMetadata && Array.isArray(appMetadata.regions) ? appMetadata.regions : null;
  if (!raw) return [DEFAULT_REGION];
  const list = REGIONS.filter((r) => raw.includes(r));
  return list.length ? list : [DEFAULT_REGION];
}

// A `regions` value from a create/update user request. Returns { value } (ids
// in canonical order, deduplicated) or { error }. An empty list is refused:
// nobody becomes region-less.
export function validateRegions(raw) {
  if (!Array.isArray(raw)) {
    return { error: `regions must be an array of region ids (${REGIONS.join(", ")}).` };
  }
  const cleaned = [...new Set(raw.map((r) => String(r ?? "").trim().toLowerCase()).filter(Boolean))];
  const unknown = cleaned.filter((r) => !REGIONS.includes(r));
  if (unknown.length) {
    return { error: `Unknown region(s): ${unknown.join(", ")}. Allowed: ${REGIONS.join(", ")}.` };
  }
  const value = REGIONS.filter((r) => cleaned.includes(r));
  if (!value.length) return { error: "Choose at least one region." };
  return { value };
}

export function regionForbiddenPayload(region) {
  return {
    error: `Your account has no access to the ${regionLabel(region)} calculator.`,
    code: "region_forbidden",
  };
}
