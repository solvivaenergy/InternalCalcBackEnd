import { createClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";
import path from "node:path";

const TABLE = "app_parameters";
const LOCAL_JSON_STORAGE = "local-json";
const LOCAL_JSON_PATH = path.join(
  process.cwd(),
  "data",
  "parameters.local.json",
);

const EDIT_ROLES = new Set(["edit", "engineering", "product", "inventory"]);

// Maps a role stored in public.user_roles (app_role enum) to the internal
// admin edit-role vocabulary this service enforces. Only these DB roles may
// write parameters; 'view', 'rep', 'customer' (and anything unmapped) are
// read-only and get a 403.
const DB_ROLE_TO_EDIT_ROLE = {
  admin: "edit",
  engineering: "engineering",
  product: "product",
  inventory: "inventory",
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
    "quoteLimits",
    "step1Defaults",
    "interestRates",
    "promoCodes",
    "maintenance",
  ]),
  // Inventory-only editor — Inventory tab sections only.
  inventory: new Set(["solarPanel", "cabling", "batteryPackage"]),
};

const ROLE_INVENTORY_ACCESS = {
  engineering: true,
  inventory: true,
  product: false,
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
  grossMarginMiscMin: "margins",
  grossMarginMiscMid: "margins",
  grossMarginMiscMax: "margins",
  grossMarginReference: "margins",
  merchantDiscountRate: "margins",
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
  lcoeNpvDiscountRate: "scheduleConstants",
  maintenanceInflationRate: "scheduleConstants",
  netMeteringEfficiency: "scheduleConstants",
  preventiveMaintenancePerPanelCogs: "scheduleConstants",
  preventiveMaintenancePerVisitCogs: "scheduleConstants",
  minDaysToFirstPostInstallPayment: "scheduleConstants",
  // Promo Codes
  promoCodes: "promoCodes",
  // Quote Validity
  quoteValidityDays: "quoteValidity",
  // Quote Limits (v3-68)
  minSystemKwp: "quoteLimits",
  minDpTiers: "quoteLimits",
  maxTenorMonths: "quoteLimits",
  // Step 1 Defaults (v3-70)
  defaultUtilityRate: "step1Defaults",
  defaultMonthlyBill: "step1Defaults",
  // Maintenance Mode
  gateAuthEnabled: "maintenance",
};

// Verifies the caller's Supabase JWT and resolves their edit-role from
// public.user_roles. Returns { role } on success or { status, error } on
// failure. The service-role client can both validate the token
// (auth.getUser) and read user_roles under RLS-bypass.
async function resolveEditRole(supabase, accessToken) {
  if (!accessToken) {
    return { status: 401, error: "Missing bearer token" };
  }
  const { data: userData, error: userError } =
    await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return { status: 401, error: "Invalid or expired session token" };
  }
  const userId = userData.user.id;

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
    return { role: editRole, userId };
  } catch (error) {
    return {
      role: "edit",
      userId,
      fallback: true,
    };
  }
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

function getSupabaseClient() {
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

async function readCurrentPayload(supabase) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("payload")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    throw new Error(`Supabase query failed for ${TABLE}: ${error.message}`);
  }
  return data?.payload && typeof data.payload === "object" ? data.payload : {};
}

async function readLocalJsonPayload() {
  try {
    const raw = await fs.readFile(LOCAL_JSON_PATH, "utf8");
    const payload = JSON.parse(raw);
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Local parameter file could not be read: ${error.message}`);
  }
}

async function writePayload(supabase, payload) {
  const { error } = await supabase.from(TABLE).upsert(
    {
      id: true,
      payload,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) {
    throw new Error(`Supabase upsert failed for ${TABLE}: ${error.message}`);
  }
}

async function writeLocalJsonPayload(payload) {
  const directory = path.dirname(LOCAL_JSON_PATH);
  const temporaryPath = `${LOCAL_JSON_PATH}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, LOCAL_JSON_PATH);
}

export async function getParameters() {
  assertLocalJsonStorage();
  if (isLocalJsonStorage()) return await readLocalJsonPayload();
  const supabase = getSupabaseClient();
  return await readCurrentPayload(supabase);
}

export async function putParameters(body, accessToken, claimedRole) {
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
    ? { role: claimedRole || "edit", local: true }
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

  const current = localJsonStorage
    ? await readLocalJsonPayload()
    : await readCurrentPayload(supabase);

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

  if (localJsonStorage) {
    await writeLocalJsonPayload(merged);
  } else {
    await writePayload(supabase, merged);
  }
  return {
    status: 200,
    payload: {
      ok: true,
      savedAt: new Date().toISOString(),
      role: role,
      appliedAdminKeys,
      ignoredAdminKeys,
      inventoryApplied,
    },
  };
}
