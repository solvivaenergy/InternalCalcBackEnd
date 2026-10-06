// Save the live app_parameters payload for capture.mjs. Read-only.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/engine-parity/fetch-params.mjs [out.json]
//
// Takes the two variables from the environment (the backend's .env /
// .env.staging hold them — never paste them anywhere). The payload holds
// COGS and margins: keep the file out of git and out of chat.
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment");
  process.exit(2);
}
const outPath = process.argv[2] || "params.json";
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await sb.from("app_parameters").select("payload, updated_at").eq("id", true).maybeSingle();
if (error) throw new Error(error.message);
const p = data?.payload || {};
writeFileSync(outPath, JSON.stringify(p));
console.log(`${new URL(url).host} updated_at=${data?.updated_at} sections=${Object.keys(p).join(",")} → ${outPath}`);
