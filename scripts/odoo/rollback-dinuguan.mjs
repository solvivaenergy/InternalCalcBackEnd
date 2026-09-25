// Sprint Dinuguan — undo what apply-dinuguan.mjs did on ONE database, using its
// manifest. Only records the manifest marks `created: true` are removed;
// modified records get their recorded "before" value back.
//
//   node scripts/odoo/rollback-dinuguan.mjs --env-file .env.staging              # plan only
//   node scripts/odoo/rollback-dinuguan.mjs --env-file .env.staging --yes        # execute
//   ... --only 064L,064B          roll back a subset (default: every step, newest first)
//   ... --delete-products         unlink the 064G products instead of archiving them
//
// DATA WARNING: removing the manual fields (064E) and the x_boq_line model
// (064I) drops their database columns/table, including any values quotations
// already hold. The plan lists the row counts before asking for --yes.
import {
  parseArgs, loadEnv, guardTarget, connect, readManifest, writeManifest,
} from "./rpc.mjs";

const { flags } = parseArgs();
const cfg = loadEnv(flags);
guardTarget(cfg, flags, { write: true });
const APPLY = !!flags.yes;
const api = await connect(cfg);
const manifest = readManifest(cfg);
const only = flags.only ? new Set(String(flags.only).split(",").map((s) => s.trim())) : null;
const inScope = (step) => !only || only.has(step);

// Reverse of the apply order, and within a step: views before fields before
// models, so nothing is referenced when it is removed.
const STEP_ORDER = ["064L", "064B", "064E", "064I", "064G"];
const MODEL_ORDER = ["ir.ui.view", "ir.actions.server", "ir.config_parameter", "ir.model.access", "ir.model.fields", "ir.model", "product.template"];

async function exists(model, id) {
  const rows = await api.searchRead(model, [["id", "=", id], ...(model === "product.template" ? [["active", "in", [true, false]]] : [])], ["id"], { limit: 1 });
  return rows.length > 0;
}

const plan = [];
for (const step of STEP_ORDER) {
  if (!inScope(step)) continue;
  // Restore modified values first (automation code, config parameter).
  for (const m of manifest.modified.filter((x) => x.step === step)) {
    plan.push({ kind: "restore", step, ...m });
  }
  const created = manifest.created.filter((c) => c.step === step && c.created);
  // Fields on sale.order must go before the x_boq_line model (the o2m points at it).
  created.sort((a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model)
    || (a.model === "ir.model.fields" ? (a.key.startsWith("sale.order.") ? -1 : 1) - (b.key.startsWith("sale.order.") ? -1 : 1) : 0));
  for (const c of created) plan.push({ kind: "remove", step, ...c });
}

if (!plan.length) { console.log("Nothing to roll back for this database."); process.exit(0); }

console.log(`\nPlan (${plan.length} actions):`);
for (const p of plan) {
  if (p.kind === "restore") console.log(`  ~ ${p.step} restore ${p.model} ${p.id}.${p.field} to its previous value`);
  else if (p.model === "product.template") console.log(`  - ${p.step} ${flags["delete-products"] ? "unlink" : "archive"} product ${p.id} "${p.key}"`);
  else console.log(`  - ${p.step} unlink ${p.model} ${p.id} "${p.key}"`);
}
if (plan.some((p) => p.model === "ir.model" || (p.model === "ir.model.fields" && p.key.startsWith("sale.order.x_calc_")))) {
  const quotes = await api.call("sale.order", "search_count", [[["x_calc_proposal_ref", "!=", false]]]).catch(() => null);
  let boqRows = null;
  try { boqRows = await api.call("x_boq_line", "search_count", [[]]); } catch (_) { /* model gone already */ }
  console.log(`\nDATA WARNING: ${quotes ?? "?"} quotation(s) carry calculator figures and ${boqRows ?? "?"} BOQ row(s) exist. Removing the fields/model drops them.`);
}
if (!APPLY) { console.log("\nPlan only. Re-run with --yes to execute."); process.exit(0); }

const done = [];
try {
  for (const p of plan) {
    if (p.kind === "restore") {
      await api.call(p.model, "write", [[p.id], { [p.field]: p.before }]);
      manifest.modified = manifest.modified.filter((m) => !(m.model === p.model && m.id === p.id && m.field === p.field));
      console.log(`  ~ restored ${p.model} ${p.id}.${p.field}`);
      continue;
    }
    if (!(await exists(p.model, p.id))) {
      console.log(`  · ${p.model} ${p.id} already gone`);
      manifest.created = manifest.created.filter((c) => !(c.model === p.model && c.id === p.id));
      continue;
    }
    if (p.model === "product.template" && !flags["delete-products"]) {
      await api.call(p.model, "write", [[p.id], { active: false }]);
      console.log(`  - archived product ${p.id} "${p.key}"`);
      // Keep the manifest entry: the product still exists (archived) and a
      // re-apply will find and reuse it.
      continue;
    }
    await api.call(p.model, "unlink", [[p.id]]);
    manifest.created = manifest.created.filter((c) => !(c.model === p.model && c.id === p.id));
    console.log(`  - unlinked ${p.model} ${p.id} "${p.key}"`);
    done.push(p);
  }
  for (const step of STEP_ORDER) if (inScope(step) && manifest.steps[step]) manifest.steps[step].rolledBack = new Date().toISOString();
  manifest.runs.push({ at: new Date().toISOString(), rollback: true, steps: STEP_ORDER.filter(inScope), actions: done.length });
  writeManifest(cfg, manifest);
  console.log("\nRollback complete. Manifest updated.");
} catch (err) {
  writeManifest(cfg, manifest);
  console.error(`\nFAILED after ${done.length} removal(s): ${err.message}`);
  console.error("The manifest reflects what was removed; re-run to continue.");
  process.exit(1);
}
