import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_REGION,
  REGIONS,
  regionLabel,
  regionsFromAppMetadata,
  regionForbiddenPayload,
} from "./regions.js";

// v3-231 — one payload PER REGION in public.region_parameters (migration
// 20261028). The legacy one-row app_parameters is Luzon's row until the
// cut-over: the frontend's direct-read fallback and the mcp/ connector still
// read it, so every Luzon save is MIRRORED into it (writeRegionPayload), and
// while the new table does not exist yet (backend deployed before the
// migration) Luzon is read from and written to the legacy row directly.
const LEGACY_TABLE = "app_parameters";
const REGION_TABLE = "region_parameters";
const LOCAL_JSON_STORAGE = "local-json";
// Luzon keeps the historical file name (tracked in git, used by dev-server);
// every other region gets its own file beside it.
const localJsonPath = (region) =>
  path.join(
    process.cwd(),
    "data",
    region === DEFAULT_REGION
      ? "parameters.local.json"
      : `parameters.${region}.local.json`,
  );
const LOCAL_AUDIT_PATH = path.join(
  process.cwd(),
  "data",
  "parameter-audit.local.jsonl",
);

const EDIT_ROLES = new Set([
  "edit",
  "engineering",
  "product",
  "inventory",
  "finco",
]);

// Maps a role stored in public.user_roles (app_role enum) to the internal
// admin edit-role vocabulary this service enforces. Only these DB roles may
// write parameters; 'view', 'rep', 'customer' (and anything unmapped) are
// read-only and get a 403.
const DB_ROLE_TO_EDIT_ROLE = {
  admin: "edit",
  engineering: "engineering",
  product: "product",
  inventory: "inventory",
  // v3-180 — FinCo/OpCo separation. The financing entity edits its own
  // parameters (financing limits + interest rates + returns assumptions) and
  // nothing else. Requires the matching value in the user_roles enum — see
  // supabase/migrations/20260901_add_finco_role.sql.
  finco: "finco",
};

const ROLE_ADMIN_SECTIONS = {
  engineering: new Set([
    "solarPanel",
    "variableCharges",
    "roofMaterial",
    "miscCatalog",
    "location",
    "cabling",
    "batteryPackage",
    "standaloneCharges",
    "fixedOverhead",
    "scheduleConstants",
    "maintenance",
  ]),
  product: new Set([
    "margins",
    "quoteValidity",
    // v3-180 — 'quoteLimits' now carries minSystemKwp only; the minimum
    // down-payment tiers and maximum tenor moved to 'financingTerms' (FinCo).
    "quoteLimits",
    "step1Defaults",
    // v3-159 — Product-settable default down payment (a pre-fill, not a floor).
    "step3Defaults",
    "promoCodes",
    "maintenance",
    // NOTE: 'interestRates' deliberately left OFF this role — v3-180 moved the
    // whole Interest Rates section to the FinCo role below.
  ]),
  // v3-180 — FinCo Admin: the financing entity's parameters ONLY.
  finco: new Set([
    "financingTerms",
    "interestRates",
    "returnsAssumptions",
    "duInflationReference",
  ]),
  // Inventory-only editor — Inventory tab sections only. Not an upstream
  // v3-207 role; added by this deployment (migration 20260731_add_inventory_role).
  inventory: new Set(["solarPanel", "cabling", "batteryPackage"]),
};

const ROLE_INVENTORY_ACCESS = {
  engineering: true,
  inventory: true,
  product: false,
  finco: false,
};

// Mirror of the frontend's PARAM_KEY_TO_SECTION (src/lib/permissions.js). This
// is the server-side security boundary: only keys listed here can be written,
// and only by a role whose allowlist includes the mapped section. Keep in sync
// with the frontend map — the app is COGS-based (v3-83+), so the editable keys
// are the `*Cogs` inputs plus the array/structural params below.
const PARAM_KEY_TO_SECTION = {
  // Margins & Merchant Discount (the two levers that drive every derived price)
  financingEntityName: "margins",
  financingEntityIsSeparate: "margins",
  grossMarginMinKwp: "margins",
  grossMarginMidKwp: "margins",
  grossMarginMaxKwp: "margins",
  grossMarginMin: "margins",
  grossMarginMid: "margins",
  grossMarginMax: "margins",
  grossMarginSolarMin: "margins",
  grossMarginSolarMid: "margins",
  grossMarginSolarMax: "margins",
  grossMarginBatteryMin: "margins",
  grossMarginBatteryMid: "margins",
  grossMarginBatteryMax: "margins",
  grossMarginBatteryMinKwh: "margins",
  grossMarginBatteryMidKwh: "margins",
  grossMarginBatteryMaxKwh: "margins",
  grossMarginMiscMin: "margins",
  grossMarginMiscMid: "margins",
  grossMarginMiscMax: "margins",
  // v3-190 — moved to FinCo (UI label renamed; key kept for stored payloads).
  grossMarginReference: "returnsAssumptions",
  merchantDiscountRate: "margins",
  // v3-226 — sales commission allowance; grosses up every COGS-derived price.
  salesCommissionRate: "margins",
  // Interest Rates
  rateAnchorMax: "interestRates",
  rateAnchorMid: "interestRates",
  rateAnchorMin: "interestRates",
  rateTenorWeight: "interestRates",
  rateStepPct: "interestRates",
  earlyPayoffDiscountRate: "interestRates",
  documentaryStampTaxRate: "interestRates",
  // Solar Panel & Mounting
  mountingSupportFloorCogs: "solarPanel",
  mountingSupportPctOfPanels: "solarPanel",
  // Variable Charges
  additionalDcCablePerMeterCogs: "variableCharges",
  additionalAcCablePerMeterCogs: "variableCharges",
  laborInstallationPerKwpCogs: "variableCharges",
  rsdVariablePerPanelCogs: "variableCharges",
  rsdFixedTransmitterCogs: "variableCharges",
  rsdAvailable: "variableCharges",
  // Roof Material
  roofAsphaltPerKwpCogs: "roofMaterial",
  roofConcretePerKwpCogs: "roofMaterial",
  // Misc Materials / Labor / Services catalog (v3-138)
  miscCatalog: "miscCatalog",
  // Location / Delivery
  deliveryLocations: "location",
  luzonOver30FixedFeeCogs: "location",
  luzonOver30PerKmCogs: "location",
  // Cabling
  cablingTiers: "cabling",
  cablingTiersThreePhase: "cabling",
  // Battery Packages
  batteryPackages: "batteryPackage",
  // Standalone Retrofit Charges
  rsdStandaloneLaborPerPanelCogs: "standaloneCharges",
  rsdStandaloneLaborMobilizationCogs: "standaloneCharges",
  inverterStandaloneLaborPerUnitCogs: "standaloneCharges",
  inverterStandaloneMobilizationCogs: "standaloneCharges",
  // Fixed Overhead
  fixedOverheadDeliveryLogisticsCogs: "fixedOverhead",
  fixedOverheadWarehouseCogs: "fixedOverhead",
  fixedOverheadCustomsCogs: "fixedOverhead",
  fixedOverheadSafetySupervisionCogs: "fixedOverhead",
  fixedOverheadTestingCogs: "fixedOverhead",
  // Schedule Constants
  kWhPerKwpPerDay: "scheduleConstants",
  batteryEfficiency: "scheduleConstants",
  maxDailySpillKwh: "scheduleConstants",
  batteryDepthOfDischarge: "scheduleConstants",
  panelAnnualDegradation: "scheduleConstants",
  lcoeNpvDiscountRate: "returnsAssumptions", // v3-190 — Engineering → FinCo
  maintenanceInflationRate: "returnsAssumptions", // v3-190 — Engineering → FinCo
  netMeteringEfficiency: "scheduleConstants",
  preventiveMaintenancePerPanelCogs: "scheduleConstants",
  preventiveMaintenancePerVisitCogs: "scheduleConstants",
  minDaysToFirstPostInstallPayment: "scheduleConstants",
  // Promo Codes
  promoCodes: "promoCodes",
  // Quote Validity
  quoteValidityDays: "quoteValidity",
  // Quote Limits (v3-68) — minSystemKwp ONLY since v3-180.
  minSystemKwp: "quoteLimits",
  // Financing Limits (v3-180) — moved out of 'quoteLimits' to the FinCo role
  // when the financing entity was separated from OpCo.
  minDpTiers: "financingTerms",
  maxTenorMonths: "financingTerms",
  // Step 1 Defaults (v3-70)
  defaultUtilityRate: "step1Defaults",
  defaultMonthlyBill: "step1Defaults",
  // Step 3 Defaults (v3-159) — Product-settable default down payment.
  defaultDownPaymentPct: "step3Defaults",
  // Location (v3-199) — the Luzon free-delivery radius became a parameter;
  // it was a hardcoded 30 km before.
  luzonFreeTravelKm: "location",
  // v3-231 — region-aware delivery (engine 1.3.0): the region's name on the
  // delivery line / picker / proposal, its dispatch hub, and whether that hub
  // exists yet (false ⇒ ₱0 delivery at any km). odooCompanyId is the Odoo
  // company/branch a region's leads live in (null until Finance registers
  // the Cebu branch) — the lead↔region guard compares against it.
  deliveryRegionLabel: "location",
  deliveryHubLabel: "location",
  deliveryHubEnabled: "location",
  odooCompanyId: "location",
  // Margins (v3-191) — per-component margin table plus the three-phase curve
  // anchors and the no-inverter (expansion / RSD-only / battery-only) margins.
  componentMargins: "margins",
  grossMarginMinTp: "margins",
  grossMarginMidTp: "margins",
  grossMarginMaxTp: "margins",
  grossMarginMinKwpTp: "margins",
  grossMarginMidKwpTp: "margins",
  grossMarginMaxKwpTp: "margins",
  grossMarginNoInverterSp: "margins",
  grossMarginNoInverterTp: "margins",
  // Returns Assumptions (v3-181 / v3-187) — FinCo-owned.
  duRateInflationDefault: "returnsAssumptions",
  irrYearsDefault: "returnsAssumptions",
  // DU Inflation Reference (v3-183 / v3-190) — advisory calculator; never
  // reaches a quote, but FinCo authors it and it travels with the PDF note.
  duInflationBasis: "duInflationReference",
  duInflationDate1: "duInflationReference",
  duInflationDate2: "duInflationReference",
  duInflationRate1: "duInflationReference",
  duInflationRate2: "duInflationReference",
  duInflationSourceName: "duInflationReference",
  duInflationSourceUrl: "duInflationReference",
  // Maintenance Mode
  gateAuthEnabled: "maintenance",
};

// Verifies the caller's Supabase JWT and resolves their edit-role from
// public.user_roles. Returns { role } on success or { status, error } on
// failure. The service-role client can both validate the token
// (auth.getUser) and read user_roles under RLS-bypass.
// Exported (v3-215) so usersService.js applies the SAME Super Admin bar as
// audit history rather than growing a second role resolver that drifts.
export async function resolveEditRole(supabase, accessToken) {
  if (!accessToken) {
    return { status: 401, error: "Missing bearer token" };
  }
  const { data: userData, error: userError } =
    await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return { status: 401, error: "Invalid or expired session token" };
  }
  const userId = userData.user.id;
  // v3-231 — the regions this account may use (auth.getUser reads GoTrue's
  // stored user, not the JWT claims, so a change made in User Management is
  // enforced here immediately). Missing ⇒ ['luzon'] (src/regions.js).
  const regions = regionsFromAppMetadata(userData.user.app_metadata);

  try {
    const { data: roleRow, error: roleError } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    if (roleError) {
      if (
        String(roleError.message).includes("does not exist") ||
        String(roleError.message).includes("Could not find the table")
      ) {
        return {
          role: "edit",
          userId,
          regions,
          fallback: true,
        };
      }
      return {
        status: 500,
        error: `Failed to look up user role: ${roleError.message}`,
      };
    }
    const dbRole = roleRow?.role;
    const editRole = DB_ROLE_TO_EDIT_ROLE[dbRole];
    if (!editRole) {
      return {
        status: 403,
        error: "Your account does not have permission to edit parameters.",
      };
    }
    return {
      role: editRole,
      userId,
      email: userData.user.email || null,
      regions,
    };
  } catch (error) {
    return {
      role: "edit",
      userId,
      email: userData.user.email || null,
      regions,
      fallback: true,
    };
  }
}

// v3-231 — every role, Super Admin included, is confined to the regions on
// its account. Returns null when allowed, else a { status, payload } result.
function assertRegionAccess(auth, region) {
  const regions = Array.isArray(auth?.regions) ? auth.regions : [DEFAULT_REGION];
  if (regions.includes(region)) return null;
  return { status: 403, payload: regionForbiddenPayload(region) };
}

function isLocalJsonStorage() {
  return (
    process.env.PARAMETERS_STORAGE === LOCAL_JSON_STORAGE &&
    process.env.NODE_ENV === "development"
  );
}

function assertLocalJsonStorage() {
  if (
    process.env.PARAMETERS_STORAGE === LOCAL_JSON_STORAGE &&
    !isLocalJsonStorage()
  ) {
    throw new Error(
      "local-json parameter storage is only allowed when NODE_ENV=development.",
    );
  }
}

function canRoleEditAdminSection(role, sectionKey) {
  if (role === "edit") return true;
  const set = ROLE_ADMIN_SECTIONS[role];
  return set ? set.has(sectionKey) : false;
}

function canRoleEditInventory(role) {
  if (role === "edit") return true;
  return !!ROLE_INVENTORY_ACCESS[role];
}

function deepClone(v) {
  if (v == null) return null;
  return JSON.parse(JSON.stringify(v));
}

// Exported (v3-215) for usersService.js — one service-role client factory.
export function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment variables.",
    );
  }
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// A storage condition the caller must answer with a status (503 while the
// region table is not provisioned, 404 for an unseeded region) rather than a
// 500 — distinguished from a real query failure, which still throws plainly.
class RegionStorageError extends Error {
  constructor(status, payload) {
    super(payload.error);
    this.status = status;
    this.payload = payload;
  }
}
const asStorageResult = (error) =>
  error instanceof RegionStorageError
    ? { status: error.status, payload: error.payload }
    : null;

// PostgREST's wording for a table it does not know (schema cache) — the
// window between this backend deploying and the migration being applied.
const isMissingTableError = (error) =>
  /PGRST205|does not exist|Could not find the table/i.test(
    `${error?.code || ""} ${error?.message || ""}`,
  );

const asPayload = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

async function readLegacyPayload(supabase) {
  const { data, error } = await supabase
    .from(LEGACY_TABLE)
    .select("payload")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    throw new Error(`Supabase query failed for ${LEGACY_TABLE}: ${error.message}`);
  }
  return asPayload(data?.payload);
}

// → { payload, legacy }. `legacy: true` means the region table is not there
// yet and Luzon was served from app_parameters; a write must then go back to
// app_parameters too. Any other region without a table/row is an operator
// problem (run the migration / the seed script), reported as 503 / 404 and
// NEVER merged onto {} — a PUT on an empty payload would persist a half row.
async function readRegionRow(supabase, region) {
  const { data, error } = await supabase
    .from(REGION_TABLE)
    .select("payload")
    .eq("region", region)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) {
      if (region === DEFAULT_REGION) {
        return { payload: await readLegacyPayload(supabase), legacy: true };
      }
      throw new RegionStorageError(503, {
        error: `${regionLabel(region)} parameters are not provisioned on this server yet (apply supabase/migrations/20261028_region_parameters.sql).`,
        code: "region_not_provisioned",
      });
    }
    throw new Error(`Supabase query failed for ${REGION_TABLE}: ${error.message}`);
  }
  if (!data) {
    if (region === DEFAULT_REGION) {
      return { payload: await readLegacyPayload(supabase), legacy: true };
    }
    throw new RegionStorageError(404, {
      error: `${regionLabel(region)} parameters have not been seeded on this server yet (scripts/seed-region-parameters.mjs).`,
      code: "region_not_seeded",
    });
  }
  return { payload: asPayload(data.payload), legacy: false };
}

async function readLocalJsonPayload(region = DEFAULT_REGION) {
  try {
    const raw = await fs.readFile(localJsonPath(region), "utf8");
    return asPayload(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Local parameter file could not be read: ${error.message}`);
  }
}

async function writeLegacyPayload(supabase, payload, updatedAt) {
  const { error } = await supabase.from(LEGACY_TABLE).upsert(
    { id: true, payload, updated_at: updatedAt },
    { onConflict: "id" },
  );
  if (error) {
    throw new Error(`Supabase upsert failed for ${LEGACY_TABLE}: ${error.message}`);
  }
}

// The one place a region row is written. Luzon is ALSO mirrored into the
// legacy app_parameters row — best effort, logged, never fails the save — so
// everything that still reads that row (frontend fallback, mcp/db.js, the
// parity harness) stays current. Remove the mirror once those read
// region_parameters.
async function writeRegionPayload(supabase, region, payload) {
  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from(REGION_TABLE).upsert(
    { region, payload, updated_at: updatedAt },
    { onConflict: "region" },
  );
  if (error) {
    throw new Error(`Supabase upsert failed for ${REGION_TABLE}: ${error.message}`);
  }
  if (region === DEFAULT_REGION) {
    try {
      await writeLegacyPayload(supabase, payload, updatedAt);
    } catch (mirrorError) {
      console.error("[parameters] luzon mirror into app_parameters failed", {
        reason: mirrorError.message,
      });
    }
  }
}

async function writePayload(supabase, region, payload, { legacy = false } = {}) {
  if (legacy) {
    // Region table not provisioned yet: Luzon lives in app_parameters alone.
    await writeLegacyPayload(supabase, payload, new Date().toISOString());
    return;
  }
  await writeRegionPayload(supabase, region, payload);
}

// v3-231 — maintenance mode is GLOBAL by product decision (one gate for the
// whole calculator) while every other parameter is per region. A save that
// changes adminParams.gateAuthEnabled in one region copies the new value into
// every other seeded region row, so the rows always agree on it and the
// frontend keeps its single "save the active region" path. Best effort per
// region; returns the regions that were updated.
const GLOBAL_ADMIN_KEYS = ["gateAuthEnabled"];
async function mirrorGlobalKeys(supabase, region, current, merged) {
  const changed = GLOBAL_ADMIN_KEYS.filter(
    (key) =>
      merged.adminParams?.[key] !== undefined &&
      JSON.stringify(merged.adminParams[key]) !==
        JSON.stringify(current.adminParams?.[key]),
  );
  if (!changed.length) return [];
  const mirrored = [];
  for (const other of REGIONS) {
    if (other === region) continue;
    try {
      const { data, error } = await supabase
        .from(REGION_TABLE)
        .select("payload")
        .eq("region", other)
        .maybeSingle();
      if (error || !data) continue; // not seeded: nothing to keep in step
      const payload = asPayload(data.payload);
      payload.adminParams = { ...(payload.adminParams || {}) };
      for (const key of changed) payload.adminParams[key] = merged.adminParams[key];
      await writeRegionPayload(supabase, other, payload);
      mirrored.push(other);
    } catch (mirrorError) {
      console.error("[parameters] global-key mirror failed", {
        region: other,
        keys: changed,
        reason: mirrorError.message,
      });
    }
  }
  return mirrored;
}

async function writeLocalJsonPayload(payload, region = DEFAULT_REGION) {
  const filePath = localJsonPath(region);
  const temporaryPath = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, filePath);
}

const INVENTORY_AREAS = new Set(["solarPanel", "cabling", "batteryPackage"]);
const ENGINEERING_AREAS = new Set([
  "variableCharges",
  "roofMaterial",
  "miscCatalog",
  "location",
  "standaloneCharges",
  "fixedOverhead",
  "scheduleConstants",
  "maintenance",
]);
const PRODUCT_AREAS = new Set([
  "margins",
  "quoteValidity",
  "quoteLimits",
  "step1Defaults",
  "step3Defaults",
  "promoCodes",
]);
const FINCO_AREAS = new Set([
  "financingTerms",
  "interestRates",
  "returnsAssumptions",
  "duInflationReference",
]);

function areaForPath(changePath) {
  if (
    changePath.startsWith("panelSettings") ||
    changePath.startsWith("invertersSinglePhase") ||
    changePath.startsWith("invertersThreePhase") ||
    changePath.startsWith("devices")
  ) {
    return "Inventory";
  }
  const key = changePath.startsWith("adminParams.")
    ? changePath.slice("adminParams.".length).split(/[.[\]]/)[0]
    : "";
  const section = PARAM_KEY_TO_SECTION[key];
  if (INVENTORY_AREAS.has(section)) return "Inventory";
  if (ENGINEERING_AREAS.has(section)) return "Engineering";
  if (PRODUCT_AREAS.has(section)) return "Product";
  if (FINCO_AREAS.has(section)) return "FinCo";
  return "Other";
}

function buildChanges(before, after, currentPath = "", changes = []) {
  const beforeIsObject = before && typeof before === "object";
  const afterIsObject = after && typeof after === "object";
  if (
    beforeIsObject &&
    afterIsObject &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      buildChanges(before[key], after[key], childPath, changes);
    }
    return changes;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      buildChanges(
        before[index],
        after[index],
        `${currentPath}[${index}]`,
        changes,
      );
    }
    return changes;
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return changes;
  const operation =
    before === undefined ? "add" : after === undefined ? "remove" : "replace";
  changes.push({
    path: currentPath,
    area: areaForPath(currentPath),
    operation,
    before: before === undefined ? null : before,
    after: after === undefined ? null : after,
  });
  return changes;
}

// ── Derived prices are NOT audit inputs ──────────────────────────────────────
// Every `price` / `fixedFee` / `perPanel` / `directPrice` below is recomputed
// client-side from the *Cogs inputs + the live reference margin on each load
// and save (v3-83 deriveDirectPrices). They can never be edited directly, so
// when the reference margin stored here and the margin a saving client last
// derived with disagree, the raw diff lights up every miscCatalog[x].price,
// deliveryLocations[x].fixedFee/perPanel, etc. as "changed" even though no
// admin touched those tables — the phantom 20-field audit events. The real
// input changes (a *Cogs edit, or the margin edit itself) still audit under
// their own paths, so filtering the derived ripple loses no information.
const DERIVED_ADMIN_SCALAR_PRICES = new Set([
  "mountingSupportFloorPrice",
  "additionalDcCablePerMeter",
  "additionalAcCablePerMeter",
  "laborInstallationPerKwp",
  "rsdVariablePerPanel",
  "rsdFixedTransmitter",
  "roofAsphaltPerKwp",
  "roofConcretePerKwp",
  "luzonOver30FixedFee",
  "luzonOver30PerKm",
  "rsdStandaloneLaborPerPanel",
  "rsdStandaloneLaborMobilization",
  "inverterStandaloneLaborPerUnit",
  "inverterStandaloneMobilization",
  "fixedOverheadDeliveryLogistics",
  "fixedOverheadWarehouse",
  "fixedOverheadCustoms",
  "fixedOverheadSafetySupervision",
  "fixedOverheadTesting",
  "preventiveMaintenancePerPanel",
  "preventiveMaintenancePerVisit",
]);
const DERIVED_AUDIT_PATH_PATTERNS = [
  /^adminParams\.miscCatalog\[\d+\]\.price$/,
  /^adminParams\.deliveryLocations\[\d+\]\.(fixedFee|perPanel)$/,
  /^adminParams\.batteryPackages\[\d+\]\.(batteryUnitPrice|batteryRackPrice|atsPrice|criticalLoadsMaterials|laborWithSolarInstall|standaloneLabor)$/,
  /^panelSettings\.(singlePhase|threePhase)\.panelDirectPrice$/,
  /^inverters(Single|Three)Phase\[\d+\]\.directPrice$/,
];
function isDerivedAuditPath(changePath) {
  if (changePath.startsWith("adminParams.")) {
    const key = changePath.slice("adminParams.".length);
    if (!/[.[\]]/.test(key) && DERIVED_ADMIN_SCALAR_PRICES.has(key)) {
      return true;
    }
  }
  return DERIVED_AUDIT_PATH_PATTERNS.some((pattern) =>
    pattern.test(changePath),
  );
}

function getAuditAreas(changes) {
  return [...new Set(changes.map((change) => change.area))];
}

async function writeLocalAuditEvent(event) {
  await fs.mkdir(path.dirname(LOCAL_AUDIT_PATH), { recursive: true });
  await fs.appendFile(LOCAL_AUDIT_PATH, `${JSON.stringify(event)}\n`, "utf8");
}

// One local audit file for every region; each line carries its `region`
// (pre-region lines are Luzon's).
async function readLocalAuditEvents(limit, region = DEFAULT_REGION) {
  try {
    const raw = await fs.readFile(LOCAL_AUDIT_PATH, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (event) => region === "all" || (event.region || DEFAULT_REGION) === region,
      )
      .reverse()
      .slice(0, limit);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`Local audit file could not be read: ${error.message}`);
  }
}

async function writeAuditEvent(supabase, event) {
  if (event.source === LOCAL_JSON_STORAGE) {
    await writeLocalAuditEvent(event);
    return;
  }
  const row = {
    id: event.id,
    actor_user_id: event.actorUserId,
    actor_email: event.actorEmail,
    actor_role: event.actorRole,
    area: event.area,
    source: event.source,
    occurred_at: event.occurredAt,
    timezone: event.timezone,
    before_payload: event.beforePayload,
    after_payload: event.afterPayload,
    changes: event.changes,
    applied_admin_keys: event.appliedAdminKeys,
    ignored_admin_keys: event.ignoredAdminKeys,
    inventory_applied: event.inventoryApplied,
    request_id: event.requestId,
    metadata: event.metadata,
  };
  let { error } = await supabase
    .from("parameter_audit_events")
    .insert({ ...row, region: event.region });
  // Backend deployed before migration 20261028 added the column (PGRST204
  // "Could not find the 'region' column"): a Luzon event is still recorded —
  // the column's default is 'luzon' once it exists.
  if (
    error &&
    event.region === DEFAULT_REGION &&
    /region/i.test(String(error.message)) &&
    /column|schema cache|PGRST204/i.test(`${error.code || ""} ${error.message}`)
  ) {
    ({ error } = await supabase.from("parameter_audit_events").insert(row));
  }
  if (error) {
    throw new Error(`Audit event insert failed: ${error.message}`);
  }
}

// `region` is a region id or "all" (every region, each row carrying its own).
export async function getAuditEvents(
  accessToken,
  claimedRole,
  requestedLimit = 100,
  region = DEFAULT_REGION,
) {
  const limit = Math.min(Math.max(Number(requestedLimit) || 100, 1), 200);
  assertLocalJsonStorage();
  if (isLocalJsonStorage()) {
    if (claimedRole !== "edit") {
      return {
        status: 403,
        payload: { error: "Audit history is restricted to administrators." },
      };
    }
    return { status: 200, payload: await readLocalAuditEvents(limit, region) };
  }

  const supabase = getSupabaseClient();
  const auth = await resolveEditRole(supabase, accessToken);
  if (auth.error) {
    return { status: auth.status, payload: { error: auth.error } };
  }
  if (auth.role !== "edit") {
    return {
      status: 403,
      payload: { error: "Audit history is restricted to administrators." },
    };
  }
  if (region !== "all") {
    const denied = assertRegionAccess(auth, region);
    if (denied) return denied;
  }
  let query = supabase
    .from("parameter_audit_events")
    .select(
      "id, region, actor_user_id, actor_email, actor_role, area, source, occurred_at, timezone, changes, applied_admin_keys, ignored_admin_keys, inventory_applied, request_id, metadata",
    )
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (region !== "all") query = query.eq("region", region);
  else query = query.in("region", auth.regions || [DEFAULT_REGION]);
  const { data, error } = await query;
  if (error) {
    throw new Error(`Audit history query failed: ${error.message}`);
  }
  return { status: 200, payload: data || [] };
}

// Verifies a caller's Supabase JWT and nothing else — no role resolution.
// Exported for endpoints that need only "is this a real signed-in user?", so
// they do not have to construct a second service-role client of their own.
// Returns { userId } on success, or { status, error } on failure, matching
// resolveEditRole's shape and its 401 wording.
export async function verifySession(accessToken) {
  if (!accessToken) {
    return { status: 401, error: "Missing bearer token" };
  }
  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (error) {
    // Misconfiguration, not a caller problem — do not report it as a 401.
    return { status: 500, error: "Auth is not configured." };
  }
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data?.user) {
    return { status: 401, error: "Invalid or expired session token" };
  }
  // email (lower-cased) is what the Odoo services match a salesperson on;
  // regions (v3-231) is what the parameters read is confined to.
  return {
    userId: data.user.id,
    email: (data.user.email || "").trim().toLowerCase(),
    regions: regionsFromAppMetadata(data.user.app_metadata),
  };
}

// Any signed-in user may read the row (2026-09-27; it was public before) —
// for a region on their account (v3-231). The body is the stored payload plus
// a top-level `region` echo, so a frontend can tell it was served the region
// it asked for (buildRuntime ignores the extra key). Returns { status, payload }
// like putParameters so server.js treats the two alike. Local JSON mode skips
// the check: the frontend's local fallback session cannot mint a Supabase
// JWT, and that mode is already refused outside NODE_ENV=development.
export async function getParameters(accessToken, region = DEFAULT_REGION) {
  assertLocalJsonStorage();
  if (isLocalJsonStorage()) {
    return { status: 200, payload: { ...(await readLocalJsonPayload(region)), region } };
  }
  const session = await verifySession(accessToken);
  if (session.error) {
    return { status: session.status, payload: { error: session.error } };
  }
  const denied = assertRegionAccess(session, region);
  if (denied) return denied;
  const supabase = getSupabaseClient();
  try {
    const { payload } = await readRegionRow(supabase, region);
    return { status: 200, payload: { ...payload, region } };
  } catch (error) {
    const result = asStorageResult(error);
    if (result) return result;
    throw error;
  }
}

// The row for server-side callers that decide access themselves (the estimate
// endpoint checks its shared key; the Odoo services read one integration
// setting). Service-role read, no session. Throws for an unprovisioned or
// unseeded region.
export async function readParametersPayload(region = DEFAULT_REGION) {
  assertLocalJsonStorage();
  if (isLocalJsonStorage()) return await readLocalJsonPayload(region);
  const { payload } = await readRegionRow(getSupabaseClient(), region);
  return payload;
}

export async function putParameters(
  body,
  accessToken,
  claimedRole,
  requestId = randomUUID(),
  region = DEFAULT_REGION,
) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, payload: { error: "Body must be a JSON object" } };
  }

  assertLocalJsonStorage();
  const localJsonStorage = isLocalJsonStorage();
  const supabase = localJsonStorage ? null : getSupabaseClient();

  // Local JSON mode is deliberately development-only. The frontend's local
  // fallback session cannot produce a Supabase JWT, so use only its claimed
  // role after the storage mode has passed the development guard.
  const auth = localJsonStorage
    ? {
        role: claimedRole || "edit",
        userId: "local-user",
        email: "local-dev",
        regions: [...REGIONS],
        local: true,
      }
    : await resolveEditRole(supabase, accessToken);
  if (auth.error) {
    return { status: auth.status, payload: { error: auth.error } };
  }
  // The JWT-derived role is authoritative. `claimedRole` (the x-solviva-role
  // header) is advisory only — logged for diagnostics, never trusted.
  const role = auth.role;
  if (!EDIT_ROLES.has(role)) {
    return { status: 403, payload: { error: "Role has no edit access" } };
  }
  const denied = assertRegionAccess(auth, region);
  if (denied) return denied;

  let current;
  let legacy = false;
  if (localJsonStorage) {
    current = await readLocalJsonPayload(region);
  } else {
    try {
      ({ payload: current, legacy } = await readRegionRow(supabase, region));
    } catch (error) {
      const result = asStorageResult(error);
      if (result) return result;
      throw error;
    }
  }

  const merged = {
    adminParams: { ...(current.adminParams || {}) },
    panelSettings: deepClone(current.panelSettings),
    invertersSinglePhase: Array.isArray(current.invertersSinglePhase)
      ? current.invertersSinglePhase.slice()
      : null,
    invertersThreePhase: Array.isArray(current.invertersThreePhase)
      ? current.invertersThreePhase.slice()
      : null,
    devices: Array.isArray(current.devices) ? current.devices.slice() : null,
  };
  if (!merged.panelSettings) delete merged.panelSettings;
  if (!merged.invertersSinglePhase) delete merged.invertersSinglePhase;
  if (!merged.invertersThreePhase) delete merged.invertersThreePhase;
  if (!merged.devices) delete merged.devices;

  const appliedAdminKeys = [];
  const ignoredAdminKeys = [];

  if (body.adminParams && typeof body.adminParams === "object") {
    const ap = body.adminParams;

    delete ap.batteryPer5kWhPrice;
    delete ap.batteryRackPer3Cap;
    delete ap.batteryAtsPrice;
    delete ap.batteryCriticalLoadsMaterials;
    delete ap.batteryLaborWithSolarInstall;
    delete ap.batteryStandaloneLabor;

    delete merged.adminParams.batteryPer5kWhPrice;
    delete merged.adminParams.batteryRackPer3Cap;
    delete merged.adminParams.batteryAtsPrice;
    delete merged.adminParams.batteryCriticalLoadsMaterials;
    delete merged.adminParams.batteryLaborWithSolarInstall;
    delete merged.adminParams.batteryStandaloneLabor;

    for (const target of [ap, merged.adminParams]) {
      const legacy = target.minDownPaymentPct;
      if (
        typeof legacy === "number" &&
        Number.isFinite(legacy) &&
        legacy > 0 &&
        !Array.isArray(target.minDpTiers)
      ) {
        target.minDpTiers = [{ fromNetPrice: 0, minDpPct: legacy }];
      }
      delete target.minDownPaymentPct;
    }

    for (const [key, value] of Object.entries(ap)) {
      const sectionKey = PARAM_KEY_TO_SECTION[key];
      if (!sectionKey) {
        ignoredAdminKeys.push(key);
        continue;
      }
      if (!canRoleEditAdminSection(role, sectionKey)) {
        ignoredAdminKeys.push(key);
        continue;
      }
      merged.adminParams[key] = value;
      appliedAdminKeys.push(key);
    }
  }

  let inventoryApplied = false;
  if (canRoleEditInventory(role)) {
    if (body.panelSettings) {
      merged.panelSettings = body.panelSettings;
      inventoryApplied = true;
    }
    if (Array.isArray(body.invertersSinglePhase)) {
      merged.invertersSinglePhase = body.invertersSinglePhase;
      inventoryApplied = true;
    }
    if (Array.isArray(body.invertersThreePhase)) {
      merged.invertersThreePhase = body.invertersThreePhase;
      inventoryApplied = true;
    }
    if (Array.isArray(body.devices)) {
      merged.devices = body.devices;
      inventoryApplied = true;
    }
  }

  if (
    Array.isArray(merged.adminParams?.cablingTiers) &&
    merged.adminParams.cablingTiers.length === 0
  ) {
    return {
      status: 400,
      payload: { error: "Refusing to save: cablingTiers cannot be empty." },
    };
  }
  if (
    Array.isArray(merged.adminParams?.cablingTiersThreePhase) &&
    merged.adminParams.cablingTiersThreePhase.length === 0
  ) {
    return {
      status: 400,
      payload: {
        error: "Refusing to save: cablingTiersThreePhase cannot be empty.",
      },
    };
  }
  if (
    Array.isArray(merged.adminParams?.batteryPackages) &&
    merged.adminParams.batteryPackages.length === 0
  ) {
    return {
      status: 400,
      payload: {
        error: "Refusing to save: at least one battery package must remain.",
      },
    };
  }
  if (Array.isArray(merged.adminParams?.promoCodes)) {
    const seen = new Set();
    for (const p of merged.adminParams.promoCodes) {
      const c = String(p?.code || "")
        .trim()
        .toUpperCase();
      if (c === "") {
        return {
          status: 400,
          payload: {
            error: "Refusing to save: promo code with empty Code value.",
          },
        };
      }
      if (seen.has(c)) {
        return {
          status: 400,
          payload: {
            error: `Refusing to save: duplicate promo code \"${c}\".`,
          },
        };
      }
      seen.add(c);
    }
  }
  if ("quoteValidityDays" in (merged.adminParams || {})) {
    const v = merged.adminParams.quoteValidityDays;
    if (!Number.isInteger(v) || v < 1) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: quoteValidityDays must be a positive integer (1 or more).",
        },
      };
    }
  }
  if ("minSystemKwp" in (merged.adminParams || {})) {
    const v = merged.adminParams.minSystemKwp;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: minSystemKwp must be a number of 0 or more (0 = no minimum).",
        },
      };
    }
  }
  if ("minDpTiers" in (merged.adminParams || {})) {
    const tiers = merged.adminParams.minDpTiers;
    if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 10) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: minDpTiers must be an array of 1 to 10 tiers.",
        },
      };
    }
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      if (
        !t ||
        typeof t !== "object" ||
        typeof t.fromNetPrice !== "number" ||
        !Number.isFinite(t.fromNetPrice) ||
        t.fromNetPrice < 0 ||
        typeof t.minDpPct !== "number" ||
        !Number.isFinite(t.minDpPct) ||
        t.minDpPct < 0 ||
        t.minDpPct > 0.5
      ) {
        return {
          status: 400,
          payload: {
            error: `Refusing to save: minDpTiers row ${i + 1} must have fromNetPrice ≥ 0 and minDpPct between 0 and 0.5 (0% and 50%).`,
          },
        };
      }
    }
    if (tiers[0].fromNetPrice !== 0) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: the first minDpTiers row must have fromNetPrice 0 (base tier).",
        },
      };
    }
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].fromNetPrice <= tiers[i - 1].fromNetPrice) {
        return {
          status: 400,
          payload: {
            error: `Refusing to save: minDpTiers thresholds must be strictly ascending (row ${i + 1} must exceed row ${i}).`,
          },
        };
      }
    }
  }
  if ("maxTenorMonths" in (merged.adminParams || {})) {
    const v = merged.adminParams.maxTenorMonths;
    if (!Number.isInteger(v) || v < 1 || v > 60) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: maxTenorMonths must be an integer between 1 and 60.",
        },
      };
    }
  }
  if ("defaultUtilityRate" in (merged.adminParams || {})) {
    const v = merged.adminParams.defaultUtilityRate;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: defaultUtilityRate must be a number greater than 0 (₱/kWh).",
        },
      };
    }
  }
  if ("defaultMonthlyBill" in (merged.adminParams || {})) {
    const v = merged.adminParams.defaultMonthlyBill;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: defaultMonthlyBill must be a number greater than 0 (₱).",
        },
      };
    }
  }
  // v3-231 — region-aware delivery (engine 1.3.0) and the Odoo company hook.
  {
    const mp = merged.adminParams || {};
    if ("deliveryRegionLabel" in mp) {
      const v = mp.deliveryRegionLabel;
      if (typeof v !== "string" || !v.trim() || v.trim().length > 40) {
        return {
          status: 400,
          payload: {
            error:
              "Refusing to save: deliveryRegionLabel must be 1 to 40 characters (it names the region on the delivery line and the proposal).",
          },
        };
      }
    }
    if ("deliveryHubEnabled" in mp && typeof mp.deliveryHubEnabled !== "boolean") {
      return {
        status: 400,
        payload: { error: "Refusing to save: deliveryHubEnabled must be true or false." },
      };
    }
    if ("deliveryHubLabel" in mp) {
      const v = mp.deliveryHubLabel;
      if (typeof v !== "string" || v.length > 60) {
        return {
          status: 400,
          payload: { error: "Refusing to save: deliveryHubLabel must be a string of at most 60 characters." },
        };
      }
      if (mp.deliveryHubEnabled !== false && !v.trim()) {
        return {
          status: 400,
          payload: {
            error:
              "Refusing to save: deliveryHubLabel is required while the delivery hub is enabled (it is printed on the delivery line and in the Logistics clause).",
          },
        };
      }
    }
    if ("odooCompanyId" in mp) {
      const v = mp.odooCompanyId;
      if (v !== null && (!Number.isInteger(v) || v < 1)) {
        return {
          status: 400,
          payload: { error: "Refusing to save: odooCompanyId must be null or a positive integer (the Odoo company/branch id)." },
        };
      }
    }
  }

  const ap = merged.adminParams || {};

  // v3-142 — per-package gross-margin CURVE anchors. Each package's three
  // anchors (Min/Med/Max) must be non-decreasing fractions in [0, 1). Equal
  // anchors are allowed (a flat margin, e.g. battery 32/32/32) — the curve
  // degrades to a constant. A package with all three anchors absent falls back
  // to the legacy curve.
  const packageAnchorSets = [
    [
      "A. Solar",
      ["grossMarginSolarMin", "grossMarginSolarMid", "grossMarginSolarMax"],
    ],
    [
      "B. Battery",
      [
        "grossMarginBatteryMin",
        "grossMarginBatteryMid",
        "grossMarginBatteryMax",
      ],
    ],
    [
      "C. Misc",
      ["grossMarginMiscMin", "grossMarginMiscMid", "grossMarginMiscMax"],
    ],
  ];
  for (const [label, keys] of packageAnchorSets) {
    const present = keys.some((k) => k in ap);
    if (!present) continue;
    const [vMin, vMid, vMax] = keys.map((k) => ap[k]);
    const finiteFraction = (v) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1;
    if (
      ![vMin, vMid, vMax].every(finiteFraction) ||
      !(vMin <= vMid && vMid <= vMax)
    ) {
      return {
        status: 400,
        payload: {
          error: `Refusing to save: ${label} package margins must be non-decreasing fractions in [0, 1): Min ≤ Med ≤ Max.`,
        },
      };
    }
  }

  // Shared capacity breakpoints (kWp) — validate when present.
  const kwpKeys = [
    "grossMarginMinKwp",
    "grossMarginMidKwp",
    "grossMarginMaxKwp",
  ];
  if (kwpKeys.some((k) => k in ap)) {
    const [x1, x2, x3] = kwpKeys.map((k) => ap[k]);
    if (
      ![x1, x2, x3].every(
        (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
      ) ||
      !(x1 < x2 && x2 < x3)
    ) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: gross-margin capacity breakpoints (kWp) must be positive and strictly increasing: MinKwp < MidKwp < MaxKwp.",
        },
      };
    }
  }

  // v3-208 — battery capacity breakpoints (kWh). The battery margin rides
  // its own axis (production-main rule); same positive strictly-increasing
  // shape rule as the kWp breakpoints above.
  const batteryKwhKeys = [
    "grossMarginBatteryMinKwh",
    "grossMarginBatteryMidKwh",
    "grossMarginBatteryMaxKwh",
  ];
  if (batteryKwhKeys.some((k) => k in ap)) {
    const [x1, x2, x3] = batteryKwhKeys.map((k) => ap[k]);
    if (
      ![x1, x2, x3].every(
        (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
      ) ||
      !(x1 < x2 && x2 < x3)
    ) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: battery gross-margin capacity breakpoints (kWh) must be positive and strictly increasing: MinKwh < MidKwh < MaxKwh.",
        },
      };
    }
  }

  if ("grossMarginReference" in ap) {
    const v = ap.grossMarginReference;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v >= 1) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: grossMarginReference must be a fraction between 0 and 1 (exclusive of 1).",
        },
      };
    }
  }

  if ("merchantDiscountRate" in ap) {
    const mdr = ap.merchantDiscountRate;
    const mdrCeiling = 1 - 0.12 / 1.12;
    if (
      typeof mdr !== "number" ||
      !Number.isFinite(mdr) ||
      mdr < 0 ||
      mdr >= mdrCeiling
    ) {
      return {
        status: 400,
        payload: {
          error: `Refusing to save: merchantDiscountRate must be between 0 and ${mdrCeiling} (exclusive upper bound).`,
        },
      };
    }
  }

  // v3-226 — the sales commission allowance: a fraction in [0, 1) alone, and
  // jointly with the (merged) MDR the retention 1.12 × (1 − MDR) − commission
  // − 0.12 must stay positive, or directFromCogs() zeroes every price.
  if ("salesCommissionRate" in ap) {
    const cr = ap.salesCommissionRate;
    if (typeof cr !== "number" || !Number.isFinite(cr) || cr < 0 || cr >= 1) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: salesCommissionRate must be a fraction between 0 and 1 (exclusive of 1).",
        },
      };
    }
  }
  {
    const mdr = Number(ap.merchantDiscountRate) || 0;
    const cr = Number(ap.salesCommissionRate) || 0;
    if (!(1.12 * (1 - mdr) - cr - 0.12 > 0)) {
      return {
        status: 400,
        payload: {
          error:
            "Refusing to save: the MDR allowance, the sales commission allowance and the VAT remittance together take the entire sale or more — 1.12 × (1 − merchantDiscountRate) − salesCommissionRate − 0.12 must stay above zero.",
        },
      };
    }
  }

  let mirroredRegions = [];
  if (localJsonStorage) {
    await writeLocalJsonPayload(merged, region);
  } else {
    await writePayload(supabase, region, merged, { legacy });
    if (!legacy) {
      mirroredRegions = await mirrorGlobalKeys(supabase, region, current, merged);
    }
  }
  // Derived COGS→price ripples are filtered out of the audit trail (see
  // isDerivedAuditPath): only authored input changes are recorded, so a save
  // whose payload merely re-derived prices at a different live margin no
  // longer logs phantom miscCatalog/deliveryLocations edits — and produces
  // no event at all when nothing authored changed.
  const changes = buildChanges(current, merged).filter(
    (change) => !isDerivedAuditPath(change.path),
  );
  if (changes.length > 0) {
    const occurredAt = new Date().toISOString();
    const auditEvent = {
      id: randomUUID(),
      region,
      actorUserId: auth.userId || null,
      actorEmail: auth.email || null,
      actorRole: role,
      area: getAuditAreas(changes).join(","),
      areas: getAuditAreas(changes),
      source: localJsonStorage ? LOCAL_JSON_STORAGE : "supabase",
      occurredAt,
      timezone: "Asia/Manila",
      beforePayload: deepClone(current),
      afterPayload: deepClone(merged),
      changes,
      appliedAdminKeys,
      ignoredAdminKeys,
      inventoryApplied,
      requestId,
      metadata: mirroredRegions.length ? { mirroredRegions } : {},
    };
    await writeAuditEvent(supabase, auditEvent);
  }
  return {
    status: 200,
    payload: {
      ok: true,
      savedAt: new Date().toISOString(),
      region,
      role: role,
      appliedAdminKeys,
      ignoredAdminKeys,
      inventoryApplied,
      mirroredRegions,
    },
  };
}
