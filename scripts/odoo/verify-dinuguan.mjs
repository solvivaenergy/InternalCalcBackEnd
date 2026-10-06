// Sprint Dinuguan — read-only verification of the Odoo-side configuration.
//
//   node scripts/odoo/verify-dinuguan.mjs --env-file .env.staging [--lead-id 99889]
//
// Checks every record apply-dinuguan.mjs is responsible for, renders the CRM
// opportunity form to confirm the Generate Proposal button is present (and
// New Quotation hidden when 064L is applied), and — with --lead-id — runs the
// server action exactly as the button would and prints the URL it returns.
// Nothing is written.
import { parseArgs, loadEnv, guardTarget, connect, readManifest } from "./rpc.mjs";

const { flags } = parseArgs();
const cfg = loadEnv(flags);
guardTarget(cfg, flags, { write: false });
const api = await connect(cfg);
const manifest = readManifest(cfg);

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { failures++; console.log(`  ✗ ${msg}`); };
const info = (msg) => console.log(`  · ${msg}`);

// 064G
console.log("064G — products");
const PACKAGE_NAMES = ["A. Solar Package", "B. Battery Package", "C. Misc. Materials, Labor, Services & Other Adjustments", "D. Interest"];
for (const name of PACKAGE_NAMES) {
  const row = await api.one("product.template", [["name", "=", name], ["active", "in", [true, false]]], ["id", "active", "type", "list_price", "categ_id", "default_code", "taxes_id"]);
  if (!row) bad(`missing product "${name}"`);
  else ok(`${name} (id ${row.id}, ${row.type}, ₱${row.list_price}, ${row.categ_id ? row.categ_id[1] : "no category"}, taxes ${JSON.stringify(row.taxes_id)}${row.active ? "" : ", ARCHIVED"})`);
}
console.log("064G — Sales Package model");
const pkgModel = await api.one("ir.model", [["model", "=", "x_sales_package"]], ["id"]);
if (!pkgModel) bad("model x_sales_package missing");
else {
  ok(`model x_sales_package (id ${pkgModel.id})`);
  const pkgFields = new Set((await api.searchRead("ir.model.fields", [["model", "=", "x_sales_package"]], ["name"])).map((f) => f.name));
  for (const f of ["x_name", "x_code", "x_sequence", "x_product_id"]) {
    if (pkgFields.has(f)) ok(`field x_sales_package.${f}`); else bad(`field x_sales_package.${f} missing`);
  }
  try {
    const rows = await api.searchRead("x_sales_package", [], ["x_name", "x_code", "x_product_id"], { order: "x_sequence asc" });
    const names = rows.map((r) => r.x_name);
    for (const name of PACKAGE_NAMES) {
      const r = rows.find((x) => x.x_name === name);
      if (!r) bad(`no Sales Package record "${name}"`);
      else if (!r.x_product_id) bad(`Sales Package "${name}" has no product`);
      else ok(`Sales Package "${name}" → ${r.x_product_id[1]}`);
    }
    if (rows.length > PACKAGE_NAMES.length) info(`extra Sales Package records: ${names.filter((n) => !PACKAGE_NAMES.includes(n)).join(", ")}`);
  } catch (err) { bad(`x_sales_package not readable: ${err.message}`); }
  const menu = await api.one("ir.ui.menu", [["name", "=", "Sales Packages"]], ["id", "complete_name"]);
  if (menu) ok(`menu ${menu.complete_name} (id ${menu.id})`); else bad("menu Sales › Configuration › Sales Packages missing");
}

// 064D
console.log("064D — order-line prerequisites");
const tax12 = await api.one("account.tax", [["name", "=", "12%"], ["type_tax_use", "=", "sale"], ["company_id", "=", 1]], ["id", "price_include_override", "include_base_amount"]);
if (!tax12) bad('sale tax "12%" not found');
else if (tax12.price_include_override === "tax_included") ok(`tax "12%" (id ${tax12.id}) is price-included${tax12.include_base_amount ? ", affects base of subsequent taxes" : ""}`);
else bad(`tax "12%" (id ${tax12.id}) is NOT price-included (${JSON.stringify(tax12.price_include_override)}) — 064D order totals would come out 12% high`);
const discountProduct = await api.one("res.company", [["id", "=", 1]], ["sale_discount_product_id"]);
if (discountProduct && discountProduct.sale_discount_product_id) ok(`company discount product: ${discountProduct.sale_discount_product_id[1]} (id ${discountProduct.sale_discount_product_id[0]})`);
else bad("company has no sale_discount_product_id (064D discount lines need it)");

// 064C
console.log("064C — quotation header fields (Payment Scheme, Downpayment, Create Mode, Financed Amount)");
const STUDIO_EXPECTED = {
  x_studio_payment_scheme: ["selection", ["direct", "rto"]],
  x_studio_mode: ["selection", ["downpayment", "nodown", "straight"]],
  x_studio_create_mode: ["selection", ["manual", "automatic"]],
  x_studio_percentage: ["float"],
  x_studio_down_amount: ["monetary"],
  x_studio_tenor: ["integer"],
  x_studio_financed_amount: ["monetary"],
};
const studioMeta = await api.call("sale.order", "fields_get", [Object.keys(STUDIO_EXPECTED)], { attributes: ["type", "selection"] });
for (const [name, [ttype, keys]] of Object.entries(STUDIO_EXPECTED)) {
  const f = studioMeta[name];
  if (!f) { bad(`sale.order.${name} missing`); continue; }
  if (f.type !== ttype) { bad(`sale.order.${name} is ${f.type}, expected ${ttype}`); continue; }
  if (!keys) { ok(`sale.order.${name} ${ttype}`); continue; }
  const have = (f.selection || []).map((s) => s[0]);
  const missing = keys.filter((k) => !have.includes(k));
  if (missing.length) bad(`sale.order.${name} lacks option(s) ${missing.join(", ")} (has ${have.join(", ") || "none"})`);
  else ok(`sale.order.${name} ${ttype} [${have.join(", ")}]`);
}
const createModeDefault = await api.one("ir.default", [["field_id.model", "=", "sale.order"], ["field_id.name", "=", "x_studio_create_mode"], ["user_id", "=", false], ["company_id", "=", false]], ["json_value"]);
if (createModeDefault && createModeDefault.json_value === '"manual"') ok("default Create Mode = manual (hand-made quotations stay Manual)");
else bad(`default Create Mode is ${createModeDefault ? createModeDefault.json_value : "unset"} (expected "manual")`);
try {
  const soView = await api.call("sale.order", "get_views", [[[false, "form"]]], {});
  const arch = soView.views.form.arch || "";
  const visible = ["x_studio_payment_scheme", "x_studio_mode", "x_studio_tenor", "x_studio_percentage", "x_studio_down_amount", "x_studio_financed_amount"];
  const shown = visible.filter((n) => arch.includes(`name="${n}"`));
  if (shown.length === visible.length) ok("quotation form shows Payment Scheme, Mode, Tenor, Percentage, Amount and Financed Amount");
  else bad(`quotation form is missing ${visible.filter((n) => !shown.includes(n)).join(", ")}`);
  (arch.includes('name="x_studio_create_mode"') ? ok : info)("Create Mode on the form (debug-mode users only, as on staging)");
} catch (err) { bad(`sale.order form failed to render: ${err.message}`); }

// 064I
console.log("064I — Bill of Quantities");
const boqModel = await api.one("ir.model", [["model", "=", "x_boq_line"]], ["id", "name"]);
if (!boqModel) bad("model x_boq_line missing");
else {
  ok(`model x_boq_line (id ${boqModel.id})`);
  const fields = await api.searchRead("ir.model.fields", [["model", "=", "x_boq_line"]], ["name", "ttype", "relation"]);
  const names = new Set(fields.map((f) => f.name));
  for (const f of ["x_name", "x_sale_order_id", "x_sequence", "x_package", "x_product", "x_quantity", "x_unit"]) {
    if (names.has(f)) ok(`field x_boq_line.${f}`); else bad(`field x_boq_line.${f} missing`);
  }
  const access = await api.searchRead("ir.model.access", [["model_id", "=", boqModel.id]], ["name", "group_id", "perm_read", "perm_write", "perm_create", "perm_unlink"]);
  if (access.length) ok(`access rules: ${access.map((a) => `${a.name} [${a.group_id ? a.group_id[1] : "everyone"}]`).join(", ")}`);
  else bad("no access rule on x_boq_line");
  try {
    const count = await api.call("x_boq_line", "search_count", [[]]);
    ok(`x_boq_line readable (${count} rows)`);
  } catch (err) { bad(`x_boq_line not readable: ${err.message}`); }
}
const soFields = await api.call("sale.order", "fields_get", [], { attributes: ["type", "relation"] });
if (soFields.x_boq_line_ids) ok(`sale.order.x_boq_line_ids (${soFields.x_boq_line_ids.type} → ${soFields.x_boq_line_ids.relation})`);
else bad("sale.order.x_boq_line_ids missing");
const boqView = await api.one("ir.ui.view", [["name", "=", "Internal Calculator: sale.order Bill of Quantities page"]], ["id", "active"]);
if (boqView && boqView.active) ok(`BOQ page view (id ${boqView.id})`); else bad("BOQ page view missing or inactive");

// 064E
console.log("064E — calculator figures + automation");
const calcFields = Object.keys(soFields).filter((k) => k.startsWith("x_calc_"));
if (calcFields.length >= 19) ok(`${calcFields.length} x_calc_* fields on sale.order`);
else bad(`only ${calcFields.length} x_calc_* fields on sale.order (expected 19)`);
const figView = await api.one("ir.ui.view", [["name", "=", "Internal Calculator: sale.order calculator figures page"]], ["id", "active"]);
if (figView && figView.active) ok(`figures page view (id ${figView.id})`); else bad("figures page view missing or inactive");
const automation = await api.one("base.automation", [["name", "=", "Sales Order Payment Terms Auto"], ["model_name", "=", "sale.order"]], ["id", "active", "action_server_ids", "trigger"]);
if (!automation) bad("automation 'Sales Order Payment Terms Auto' not found");
else {
  const [action] = await api.call("ir.actions.server", "read", [[automation.action_server_ids[0]]], { fields: ["code"] });
  if ((action.code || "").includes("internal_calculator:064E")) ok(`automation ${automation.id} (${automation.trigger}, ${automation.active ? "active" : "INACTIVE"}) carries the 064E code`);
  else bad(`automation ${automation.id} still runs the previous code`);
}
try {
  const soView = await api.call("sale.order", "get_views", [[[false, "form"]]], {});
  const arch = soView.views.form.arch || "";
  if (arch.includes("internal_calculator_boq")) ok("quotation form renders the Bill of Quantities page"); else bad("quotation form does not render the BOQ page");
  if (arch.includes("internal_calculator_figures")) ok("quotation form renders the Internal Calculator page"); else bad("quotation form does not render the figures page");
} catch (err) { bad(`sale.order form failed to render: ${err.message}`); }

// 064B
console.log("064B — Generate Proposal button");
const param = await api.one("ir.config_parameter", [["key", "=", "internal_calculator.base_url"]], ["value"]);
if (param && param.value) ok(`internal_calculator.base_url = ${param.value}`); else bad("system parameter internal_calculator.base_url missing");
const action = await api.one("ir.actions.server", [["name", "=", "Internal Calculator: Generate Proposal"], ["model_name", "=", "crm.lead"]], ["id", "state"]);
if (action && action.state === "code") ok(`server action (id ${action.id})`); else bad("server action missing");
const btnView = await api.one("ir.ui.view", [["name", "=", "Internal Calculator: crm.lead Generate Proposal button"]], ["id", "active"]);
if (btnView && btnView.active) ok(`button view (id ${btnView.id})`); else bad("button view missing or inactive");

// 064L
console.log("064L — hide New Quotation");
const hideView = await api.one("ir.ui.view", [["name", "=", "Internal Calculator: crm.lead hide New Quotation"]], ["id", "active"]);
if (hideView && hideView.active) ok(`hide view (id ${hideView.id})`); else info("hide view not applied (expected until the quotation push and the Generate Proposal button are live)");

// Rendered opportunity form
console.log("crm.lead form as the browser receives it");
try {
  const views = await api.call("crm.lead", "get_views", [[[false, "form"]]], {});
  const arch = views.views.form.arch || "";
  const genBtn = arch.match(/<button[^>]*Generate Proposal[^>]*>/);
  if (genBtn) ok(`Generate Proposal button: ${genBtn[0].replace(/\s+/g, " ").slice(0, 200)}`); else bad("Generate Proposal button not in the rendered form");
  const newQ = arch.match(/<button[^>]*action_sale_quotations_new[^>]*>/);
  if (newQ) {
    const hidden = /invisible="(1|True)"/.test(newQ[0]);
    (hideView && hideView.active ? (hidden ? ok : bad) : info)(`New Quotation button: ${newQ[0].replace(/\s+/g, " ").slice(0, 200)}`);
  } else info("New Quotation button not present in the rendered form");
} catch (err) { bad(`crm.lead form failed to render: ${err.message}`); }

// Run the action as the button would
if (flags["lead-id"] && action) {
  const leadId = Number(flags["lead-id"]);
  console.log(`server action run for lead ${leadId}`);
  try {
    const result = await api.call("ir.actions.server", "run", [[action.id]], {
      context: { active_model: "crm.lead", active_id: leadId, active_ids: [leadId] },
    });
    if (result && result.type === "ir.actions.act_url" && /leadId=\d+/.test(result.url)) ok(`returns ${result.url} (target ${result.target})`);
    else bad(`unexpected result ${JSON.stringify(result).slice(0, 200)}`);
  } catch (err) { bad(`action run failed: ${err.message}`); }
}

console.log(`\nManifest steps: ${Object.entries(manifest.steps || {}).map(([k, v]) => `${k}${v.applied ? "" : " (dry)"}`).join(", ") || "none"}`);
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
