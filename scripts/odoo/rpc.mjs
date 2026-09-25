// Shared JSON-RPC plumbing for the scripts/odoo/*.mjs commands.
//
// Credentials come from the same ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY
// variables the server uses. Pick the environment with
//     --env-file .env.staging      (or DOTENV_CONFIG_PATH=.env.staging)
// The target host and database are printed before anything runs — read them.
//
// Safety rails shared by every command:
//   • a database whose name does not contain "staging" or "dev" is treated as
//     PRODUCTION and refused unless --allow-prod is passed;
//   • nothing is written unless --yes is passed (dry-run otherwise).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_DIR = path.join(SCRIPT_DIR, "manifests");

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[a.slice(2)] = next; i++; }
    else flags[a.slice(2)] = true;
  }
  return { flags, positional };
}

export function loadEnv(flags) {
  const file = flags["env-file"] || process.env.DOTENV_CONFIG_PATH || ".env";
  const resolved = path.resolve(process.cwd(), file);
  if (fs.existsSync(resolved)) dotenv.config({ path: resolved, override: false });
  const cfg = {
    url: (process.env.ODOO_URL || "").replace(/\/+$/, ""),
    db: process.env.ODOO_DB || "",
    user: process.env.ODOO_USER || "",
    apiKey: process.env.ODOO_API_KEY || "",
    envFile: fs.existsSync(resolved) ? resolved : null,
  };
  const missing = ["url", "db", "user", "apiKey"].filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(`Missing Odoo credentials (${missing.map((k) => `ODOO_${k === "apiKey" ? "API_KEY" : k.toUpperCase()}`).join(", ")}). Pass --env-file <path> or set them in the environment.`);
  }
  return cfg;
}

export function looksLikeProduction(cfg) {
  return !/staging|dev|test/i.test(cfg.db);
}

export function guardTarget(cfg, flags, { write }) {
  console.log(`Target : ${cfg.url}`);
  console.log(`Database: ${cfg.db}`);
  console.log(`User   : ${cfg.user}`);
  if (looksLikeProduction(cfg) && !flags["allow-prod"]) {
    throw new Error("This database does not look like staging. Re-run with --allow-prod if production is really intended.");
  }
  if (write && !flags.yes) {
    console.log("DRY RUN — nothing will be written. Add --yes to apply.");
  }
}

export async function connect(cfg) {
  async function rpc(params) {
    const res = await fetch(`${cfg.url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params }),
    });
    if (!res.ok) throw new Error(`odoo http ${res.status}`);
    const body = await res.json();
    if (body.error) {
      const d = body.error.data || {};
      const msg = String(d.message || body.error.message || "").split("\n").slice(0, 3).join(" | ");
      const err = new Error(`${d.name || "odoo fault"}: ${msg.slice(0, 400)}`);
      err.odoo = d;
      throw err;
    }
    return body.result;
  }
  const version = await rpc({ service: "common", method: "version", args: [] });
  const uid = await rpc({ service: "common", method: "authenticate", args: [cfg.db, cfg.user, cfg.apiKey, {}] });
  if (typeof uid !== "number") {
    throw new Error("Odoo rejected the credentials (authenticate returned false). On an Odoo.sh staging build, generate a NEW API key there: neutralisation deletes the copied ones.");
  }
  const call = (model, method, args = [], kwargs = {}) =>
    rpc({ service: "object", method: "execute_kw", args: [cfg.db, uid, cfg.apiKey, model, method, args, kwargs] });

  const api = {
    uid,
    version: version && version.server_version,
    call,
    searchRead: (model, domain, fields, extra = {}) => call(model, "search_read", [domain], { fields, ...extra }),
    async one(model, domain, fields = ["id"]) {
      const rows = await api.searchRead(model, domain, fields, { limit: 1 });
      return rows && rows[0] ? rows[0] : null;
    },
    async xmlid(module, name) {
      const row = await api.one("ir.model.data", [["module", "=", module], ["name", "=", name]], ["res_id", "model"]);
      if (!row) throw new Error(`xml id ${module}.${name} not found on this database`);
      return row.res_id;
    },
    async modelId(model) {
      const row = await api.one("ir.model", [["model", "=", model]], ["id"]);
      if (!row) throw new Error(`model ${model} not found`);
      return row.id;
    },
  };
  console.log(`Connected: Odoo ${api.version}, uid ${uid}`);
  return api;
}

// ─── Manifest ────────────────────────────────────────────────────────────────
// One JSON file per database records every record this tooling created or
// modified, so verify/rollback act only on what apply did.
export function manifestPath(cfg) {
  return path.join(MANIFEST_DIR, `${cfg.db}.json`);
}

export function readManifest(cfg) {
  const p = manifestPath(cfg);
  if (!fs.existsSync(p)) return { db: cfg.db, url: cfg.url, created: [], modified: [], steps: {}, runs: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeManifest(cfg, manifest) {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(manifestPath(cfg), JSON.stringify(manifest, null, 2) + "\n");
}

export function findCreated(manifest, model, key) {
  return manifest.created.find((r) => r.model === model && r.key === key) || null;
}

export function recordCreated(manifest, entry) {
  const idx = manifest.created.findIndex((r) => r.model === entry.model && r.key === entry.key);
  if (idx >= 0) manifest.created[idx] = { ...manifest.created[idx], ...entry };
  else manifest.created.push(entry);
}

export function recordModified(manifest, entry) {
  // Keep the FIRST "before" value: repeated applies must not overwrite the
  // original with an intermediate state.
  const existing = manifest.modified.find((r) => r.model === entry.model && r.id === entry.id && r.field === entry.field);
  if (existing) { existing.after = entry.after; existing.at = entry.at; return; }
  manifest.modified.push(entry);
}
