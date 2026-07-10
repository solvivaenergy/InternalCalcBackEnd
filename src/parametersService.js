import { createClient } from "@supabase/supabase-js";

const TABLE = "app_parameters";

const EDIT_ROLES = new Set(["edit", "engineering", "product"]);

const ROLE_ADMIN_SECTIONS = {
  engineering: new Set([
    "solarPanel",
    "variableCharges",
    "roofMaterial",
    "location",
    "cabling",
    "batteryPackage",
    "standaloneCharges",
    "fixedOverhead",
    "scheduleConstants",
    "maintenance",
  ]),
  product: new Set([
    "quoteValidity",
    "quoteLimits",
    "step1Defaults",
    "interestRates",
    "promoCodes",
    "maintenance",
  ]),
};

const ROLE_INVENTORY_ACCESS = {
  engineering: true,
  product: false,
};

const PARAM_KEY_TO_SECTION = {
  baseRtoInterestRate: "interestRates",
  smallPackagePanelThreshold: "interestRates",
  smallPackageRiskPremiumBps: "interestRates",
  earlyPayoffDiscountRate: "interestRates",

  minSystemKwp: "quoteLimits",
  minDpTiers: "quoteLimits",
  maxTenorMonths: "quoteLimits",

  defaultUtilityRate: "step1Defaults",
  defaultMonthlyBill: "step1Defaults",

  mountingSupportFloorPrice: "solarPanel",
  mountingSupportPctOfPanels: "solarPanel",

  additionalDcCablePerMeter: "variableCharges",
  additionalAcCablePerMeter: "variableCharges",
  laborInstallationPerKwp: "variableCharges",
  rsdVariablePerPanel: "variableCharges",
  rsdFixedTransmitter: "variableCharges",

  roofAsphaltPerKwp: "roofMaterial",
  roofConcretePerKwp: "roofMaterial",

  cebuFixedFee: "location",
  cebuPerPanel: "location",
  siargaoFixedFee: "location",
  siargaoPerPanel: "location",
  luzonOver30FixedFee: "location",
  luzonOver30PerKm: "location",

  cablingTiers: "cabling",
  cablingTiersThreePhase: "cabling",

  batteryPackages: "batteryPackage",

  rsdStandaloneLaborPerPanel: "standaloneCharges",
  rsdStandaloneLaborMobilization: "standaloneCharges",
  inverterStandaloneLaborPerUnit: "standaloneCharges",
  inverterStandaloneMobilization: "standaloneCharges",

  fixedOverheadDeliveryLogistics: "fixedOverhead",
  fixedOverheadWarehouse: "fixedOverhead",
  fixedOverheadCustoms: "fixedOverhead",
  fixedOverheadSafetySupervision: "fixedOverhead",
  fixedOverheadTesting: "fixedOverhead",

  kWhPerKwpPerDay: "scheduleConstants",
  batteryEfficiency: "scheduleConstants",
  batteryDepthOfDischarge: "scheduleConstants",
  panelAnnualDegradation: "scheduleConstants",
  lcoeNpvDiscountRate: "scheduleConstants",
  maintenanceInflationRate: "scheduleConstants",
  netMeteringEfficiency: "scheduleConstants",
  preventiveMaintenancePerPanel: "scheduleConstants",
  preventiveMaintenancePerVisit: "scheduleConstants",
  minDaysToFirstPostInstallPayment: "scheduleConstants",

  promoCodes: "promoCodes",
  quoteValidityDays: "quoteValidity",
  gateAuthEnabled: "maintenance",
};

function envVarForRole(role) {
  if (role === "edit") return "VITE_SUPERADMIN_PASSWORD";
  if (role === "engineering") return "VITE_ENGINEERING_PASSWORD";
  if (role === "product") return "VITE_PRODUCT_PASSWORD";
  return null;
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

export async function getParameters() {
  const supabase = getSupabaseClient();
  return await readCurrentPayload(supabase);
}

export async function putParameters(body, claimedRole, suppliedPassword) {
  if (!EDIT_ROLES.has(claimedRole)) {
    return {
      status: 401,
      payload: { error: "Missing or invalid role header" },
    };
  }
  const envVarName = envVarForRole(claimedRole);
  const expected = process.env[envVarName];
  if (!expected) {
    return {
      status: 500,
      payload: {
        error: `Server is missing ${envVarName} env var. Configure it on Render.`,
      },
    };
  }
  if (suppliedPassword !== expected) {
    return {
      status: 401,
      payload: { error: "Invalid password for declared role" },
    };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, payload: { error: "Body must be a JSON object" } };
  }

  const supabase = getSupabaseClient();
  const current = await readCurrentPayload(supabase);

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
      if (!canRoleEditAdminSection(claimedRole, sectionKey)) {
        ignoredAdminKeys.push(key);
        continue;
      }
      merged.adminParams[key] = value;
      appliedAdminKeys.push(key);
    }
  }

  let inventoryApplied = false;
  if (canRoleEditInventory(claimedRole)) {
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

  await writePayload(supabase, merged);
  return {
    status: 200,
    payload: {
      ok: true,
      savedAt: new Date().toISOString(),
      role: claimedRole,
      appliedAdminKeys,
      ignoredAdminKeys,
      inventoryApplied,
    },
  };
}
