// Seed (or inspect) one region's row in public.region_parameters from another
// payload — the legacy app_parameters row or another region's row.
//
//   node scripts/seed-region-parameters.mjs                                   # dry run: describe every row
//   node scripts/seed-region-parameters.mjs --region cebu --apply             # app_parameters → cebu (+ CEBU overrides); refuses if cebu exists
//   node scripts/seed-region-parameters.mjs --region cebu --apply --force     # … overwrite an existing cebu row
//   node scripts/seed-region-parameters.mjs --region luzon --apply --force    # re-copy app_parameters → luzon (cut-over sync)
//   node scripts/seed-region-parameters.mjs --region cebu --from luzon --apply --force
//                                                                             # re-base cebu on the live luzon row
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env (production) or
//      DOTENV_CONFIG_PATH=.env.staging for staging. The target host is
//      printed first — read it before trusting the output.
//
// Normally the migration supabase/migrations/20261028_region_parameters.sql
// seeds both rows; this script is for re-seeding, for the testing project,
// and for a region added later. It never prints payload contents (COGS and
// margins) — only sizes, key counts and timestamps.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { REGIONS, DEFAULT_REGION } from "../src/regions.js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

// Keep in step with the jsonb_build_object in the 20261028 migration.
// Cebu: own label, no delivery hub yet (₱0 delivery, no km, Logistics T&C
// clause dropped), no off-island delivery rows, no Odoo company yet, Visayan
// utility as the inflation source (figures stay Meralco's until FinCo
// supplies VECO's).
const REGION_ADMIN_OVERRIDES = {
  cebu: {
    deliveryRegionLabel: "Cebu",
    deliveryHubLabel: "",
    deliveryHubEnabled: false,
    deliveryLocations: [],
    odooCompanyId: null,
    duInflationSourceName: "Visayan Electric (VECO) Rates",
    duInflationSourceUrl: "https://www.visayanelectric.com/",
  },
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--") && !a.includes("=")));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const APPLY = flags.has("--apply");
const FORCE = flags.has("--force");
const region = opt("region");
const from = opt("from") || "app_parameters";

if (region && !REGIONS.includes(region)) {
  console.error(`--region must be one of: ${REGIONS.join(", ")}`);
  process.exit(1);
}
if (from !== "app_parameters" && !REGIONS.includes(from)) {
  console.error(`--from must be app_parameters or one of: ${REGIONS.join(", ")}`);
  process.exit(1);
}
if (APPLY && !region) {
  console.error("--apply needs --region <id>");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const describe = (label, row) => {
  if (!row) return console.log(`  ${label.padEnd(16)} (no row)`);
  const p = row.payload && typeof row.payload === "object" ? row.payload : {};
  const ap = p.adminParams && typeof p.adminParams === "object" ? p.adminParams : {};
  console.log(
    `  ${label.padEnd(16)} updated_at=${row.updated_at}  bytes=${JSON.stringify(p).length}  ` +
      `sections=${Object.keys(p).join(",") || "-"}  adminParams.keys=${Object.keys(ap).length}  ` +
      `regionLabel=${JSON.stringify(ap.deliveryRegionLabel ?? null)}  hubEnabled=${JSON.stringify(ap.deliveryHubEnabled ?? null)}`,
  );
};

async function readLegacy() {
  const { data, error } = await supabase.from("app_parameters").select("payload, updated_at").eq("id", true).maybeSingle();
  if (error) throw error;
  return data;
}
async function readRegion(id) {
  const { data, error } = await supabase.from("region_parameters").select("region, payload, updated_at").eq("region", id).maybeSingle();
  if (error) throw error;
  return data;
}

(async () => {
  console.log(`Target Supabase host: ${new URL(url).host}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "dry run (no changes)"}${region ? `  region=${region}  from=${from}` : ""}\n`);

  const legacy = await readLegacy();
  console.log("Current rows:");
  describe("app_parameters", legacy);
  const rows = {};
  for (const id of REGIONS) {
    rows[id] = await readRegion(id);
    describe(`region:${id}`, rows[id]);
  }
  if (legacy && rows[DEFAULT_REGION]) {
    const same = JSON.stringify(legacy.payload) === JSON.stringify(rows[DEFAULT_REGION].payload);
    console.log(`\n  region:${DEFAULT_REGION} payload ${same ? "==" : "!="} app_parameters payload`);
  }
  if (!region) return;

  const source = from === "app_parameters" ? legacy : rows[from];
  if (!source) {
    console.error(`\nSource ${from} has no row — nothing to copy.`);
    process.exit(1);
  }
  if (rows[region] && !FORCE) {
    console.error(`\nregion:${region} already exists. Re-run with --force to overwrite it.`);
    process.exit(APPLY ? 1 : 0);
  }

  const payload = JSON.parse(JSON.stringify(source.payload || {}));
  const overrides = REGION_ADMIN_OVERRIDES[region];
  if (overrides) {
    payload.adminParams = { ...(payload.adminParams || {}), ...overrides };
  }
  console.log(`\nWould write region:${region} from ${from}${overrides ? ` with ${Object.keys(overrides).length} admin overrides` : ""}:`);
  describe(`region:${region}`, { payload, updated_at: "(now)" });
  if (!APPLY) return;

  const { error } = await supabase
    .from("region_parameters")
    .upsert({ region, payload, updated_at: new Date().toISOString() }, { onConflict: "region" });
  if (error) throw error;
  describe(`region:${region}`, await readRegion(region));
  console.log(`\nDone. region:${region} seeded from ${from}.`);
})().catch((err) => {
  console.error("\nFAILED:", err.message || err);
  process.exit(1);
});
