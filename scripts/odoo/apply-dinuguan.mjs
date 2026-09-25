// Sprint Dinuguan — Odoo-side configuration, applied over JSON-RPC.
//
//   node scripts/odoo/apply-dinuguan.mjs --env-file .env.staging \
//        --calculator-url https://staging-internalcalc.solvivaenergy.com        # dry run
//   node scripts/odoo/apply-dinuguan.mjs --env-file .env.staging \
//        --calculator-url https://staging-internalcalc.solvivaenergy.com --yes  # apply
//   ... --only 064G,064I        run a subset       ... --skip 064L   leave one out
//   ... --allow-prod            required when the database name has no "staging"
//
// Every step is idempotent: records are looked up by a natural key (product
// name, model name, field name, view name, action name, parameter key) and
// created only when absent. Everything created or modified is written to
// scripts/odoo/manifests/<database>.json, which verify-dinuguan.mjs checks
// and rollback-dinuguan.mjs undoes. The manifest is the deployment record —
// commit it.
//
// Stories covered (see docs/dinuguan-odoo-deployment.md):
//   064G  three package products
//   064I  Bill of Quantities table on the quotation (x_boq_line)
//   064E  calculator financing fields on sale.order + the bill-schedule
//         automation anchored on the calculator's amortisation
//   064B  "Generate Proposal" button on the CRM opportunity
//   064L  hide the "New Quotation" button on the CRM opportunity
//
// The ORM calls here are the same ones Odoo Studio makes (manual ir.model /
// ir.model.fields, inherited ir.ui.view, code ir.actions.server). Records are
// NOT part of Studio's customization module, but Studio can still edit them.
import {
  parseArgs, loadEnv, guardTarget, connect,
  readManifest, writeManifest, findCreated, recordCreated, recordModified,
} from "./rpc.mjs";

const { flags } = parseArgs();
const STEP_ORDER = ["064G", "064I", "064E", "064B", "064L"];
const only = flags.only ? String(flags.only).split(",").map((s) => s.trim()) : null;
const skip = new Set(flags.skip ? String(flags.skip).split(",").map((s) => s.trim()) : []);
const steps = STEP_ORDER.filter((s) => (!only || only.includes(s)) && !skip.has(s));

const cfg = loadEnv(flags);
guardTarget(cfg, flags, { write: true });
const APPLY = !!flags.yes;
const now = () => new Date().toISOString();

// ─── Names and archs (the natural keys) ──────────────────────────────────────
export const PACKAGE_PRODUCTS = [
  { code: "IC-PKG-A", name: "A. Solar Package" },
  { code: "IC-PKG-B", name: "B. Battery Package" },
  { code: "IC-PKG-C", name: "C. Misc. Materials, Labor, Services & Other Adjustments" },
];

const BOQ_MODEL = "x_boq_line";
const BOQ_FIELDS = [
  // x_name is created first and is the model's display name. It IS the
  // "Prod Description" column of story 064I.
  { name: "x_name", ttype: "char", field_description: "Prod Description", required: false },
  { name: "x_sale_order_id", ttype: "many2one", relation: "sale.order", on_delete: "cascade", field_description: "Quotation", required: true, index: true },
  { name: "x_sequence", ttype: "integer", field_description: "Sequence" },
  { name: "x_package", ttype: "char", field_description: "Package" },
  { name: "x_product", ttype: "char", field_description: "Product" },
  { name: "x_quantity", ttype: "float", field_description: "Quantity" },
  { name: "x_unit", ttype: "char", field_description: "Unit" },
];

// Mirror of CALC_FIELD_MAP in src/odooQuotationService.js.
const CALC_FIELDS = [
  { name: "x_calc_proposal_ref", ttype: "char", field_description: "Proposal Ref.", index: true },
  { name: "x_calc_generated_at", ttype: "datetime", field_description: "Proposal Generated" },
  { name: "x_calc_financing_type", ttype: "char", field_description: "Financing Type" },
  { name: "x_calc_net_price", ttype: "float", field_description: "Net Price" },
  { name: "x_calc_discount_amount", ttype: "float", field_description: "Discount" },
  { name: "x_calc_promo_code", ttype: "char", field_description: "Promo Code" },
  { name: "x_calc_downpayment_pct", ttype: "float", field_description: "Down Payment %" },
  { name: "x_calc_downpayment_amount", ttype: "float", field_description: "Down Payment" },
  { name: "x_calc_tenor_months", ttype: "integer", field_description: "Tenor (months)" },
  { name: "x_calc_interest_rate_pa", ttype: "float", field_description: "Interest Rate p.a." },
  { name: "x_calc_monthly_amortization", ttype: "float", field_description: "Monthly Amortization" },
  { name: "x_calc_total_amount_due", ttype: "float", field_description: "Total Amount Due (before DST)" },
  { name: "x_calc_dst", ttype: "float", field_description: "Documentary Stamp Tax" },
  { name: "x_calc_total_amount_due_incl_dst", ttype: "float", field_description: "Total Amount Due" },
  { name: "x_calc_system_kwp", ttype: "float", field_description: "System kWp" },
  { name: "x_calc_panel_count", ttype: "integer", field_description: "Panels" },
  { name: "x_calc_battery_kwh", ttype: "float", field_description: "Battery kWh" },
  { name: "x_calc_inverters", ttype: "char", field_description: "Inverters" },
  { name: "x_calc_agent_email", ttype: "char", field_description: "Calculator User" },
];

const VIEW_BOQ = "Internal Calculator: sale.order Bill of Quantities page";
const VIEW_FIGURES = "Internal Calculator: sale.order calculator figures page";
const VIEW_BUTTON = "Internal Calculator: crm.lead Generate Proposal button";
const VIEW_HIDE_NEW_QUOTATION = "Internal Calculator: crm.lead hide New Quotation";
const ACTION_NAME = "Internal Calculator: Generate Proposal";
const PARAM_KEY = "internal_calculator.base_url";
const AUTOMATION_NAME = "Sales Order Payment Terms Auto";
const AUTOMATION_MARKER = "internal_calculator:064E";

const ARCH_BOQ = `<data>
  <xpath expr="//notebook/page[@name='order_lines']" position="after">
    <page string="Bill of Quantities" name="internal_calculator_boq">
      <field name="x_boq_line_ids" nolabel="1" colspan="2">
        <list editable="bottom" default_order="x_sequence, id">
          <field name="x_sequence" widget="handle"/>
          <field name="x_package" string="Package"/>
          <field name="x_product" string="Product"/>
          <field name="x_name" string="Prod Description"/>
          <field name="x_quantity" string="Quantity" sum="Total"/>
          <field name="x_unit" string="Unit"/>
        </list>
      </field>
    </page>
  </xpath>
</data>`;

const ARCH_FIGURES = `<data>
  <xpath expr="//notebook/page[@name='order_lines']" position="after">
    <page string="Internal Calculator" name="internal_calculator_figures">
      <group>
        <group string="Proposal">
          <field name="x_calc_proposal_ref" readonly="1"/>
          <field name="x_calc_generated_at" readonly="1"/>
          <field name="x_calc_agent_email" readonly="1"/>
          <field name="x_calc_system_kwp" readonly="1"/>
          <field name="x_calc_panel_count" readonly="1"/>
          <field name="x_calc_battery_kwh" readonly="1"/>
          <field name="x_calc_inverters" readonly="1"/>
        </group>
        <group string="Financing (from the calculator)">
          <field name="x_calc_financing_type" readonly="1"/>
          <field name="x_calc_net_price" readonly="1"/>
          <field name="x_calc_discount_amount" readonly="1"/>
          <field name="x_calc_promo_code" readonly="1"/>
          <field name="x_calc_downpayment_pct" readonly="1"/>
          <field name="x_calc_downpayment_amount" readonly="1"/>
          <field name="x_calc_tenor_months" readonly="1"/>
          <field name="x_calc_interest_rate_pa" readonly="1"/>
          <field name="x_calc_monthly_amortization" readonly="1"/>
          <field name="x_calc_total_amount_due" readonly="1"/>
          <field name="x_calc_dst" readonly="1"/>
          <field name="x_calc_total_amount_due_incl_dst" readonly="1"/>
        </group>
      </group>
    </page>
  </xpath>
</data>`;

const archButton = (actionId) => `<data>
  <xpath expr="//button[@name='action_sale_quotations_new']" position="after">
    <button string="Generate Proposal" name="${actionId}" type="action" class="oe_highlight" data-hotkey="g"
            title="Open the Internal Calculator for this opportunity"
            invisible="type == 'lead' or probability == 0 and not active"/>
  </xpath>
</data>`;

const ARCH_HIDE_NEW_QUOTATION = `<data>
  <xpath expr="//button[@name='action_sale_quotations_new']" position="attributes">
    <attribute name="invisible">1</attribute>
  </xpath>
</data>`;

const ACTION_CODE = `# internal_calculator:064B — managed by InternalCalcBackEnd/scripts/odoo/apply-dinuguan.mjs.
# Opens the Internal Calculator for this opportunity. The calculator reads
# ?leadId=, loads the contact through its own backend (story 043D) and, once a
# proposal PDF is generated, creates a quotation on this opportunity (064C).
base_url = (env['ir.config_parameter'].sudo().get_param('${PARAM_KEY}') or '').rstrip('/')
if not base_url:
    raise UserError('The Internal Calculator URL is not configured. Set the System Parameter ${PARAM_KEY}.')
if not record:
    raise UserError('Open an opportunity first.')
action = {
    'type': 'ir.actions.act_url',
    'url': '%s/?leadId=%s' % (base_url, record.id),
    'target': 'new',
}`;

// Replaces the code of the on-change automation "Sales Order Payment Terms
// Auto". Behaviour kept: Direct Purchase clears the plan; N-month terms get
// the monthly plan and an end date. Fixed: the month count no longer resolves
// "36 Months"/"60 Months" to 6 (the old '6' in name test). Added (064E): the
// tenor prefers the calculator's x_calc_tenor_months, and the single
// recurring line is anchored on x_calc_monthly_amortization.
const AUTOMATION_CODE = `# ${AUTOMATION_MARKER} — managed by InternalCalcBackEnd/scripts/odoo/apply-dinuguan.mjs.
# Edit the script and re-apply rather than editing here; rollback restores the
# previous code from the manifest.
#
# 1. Direct Purchase clears the recurring plan and end date.
# 2. Rent-to-Own: the tenor comes from the calculator (x_calc_tenor_months)
#    when present, else from the FIRST number in the payment-term name.
# 3. The recurring line is anchored on the calculator's own monthly
#    amortisation, which already nets out the down payment and carries the
#    interest, so the bill schedule bills exactly what the proposal printed.

term = record.payment_term_id
term_name = (term.name or '').lower() if term else ''
is_direct = 'direct' in term_name

if term:
    if is_direct:
        record.update({'plan_id': False, 'end_date': False})
    else:
        months = int(record.x_calc_tenor_months or 0)
        if months <= 0:
            digits = ''
            for ch in term_name:
                digits += ch if ch.isdigit() else ' '
            parts = digits.split()
            months = int(parts[0]) if parts else 0
        if months > 0:
            vals = {}
            if not record.plan_id:
                plan = env['sale.subscription.plan'].search([('name', '=ilike', 'Monthly Rent-to-Own')], limit=1)
                if not plan:
                    plan = env['sale.subscription.plan'].search([
                        ('billing_period_value', '=', 1),
                        ('billing_period_unit', '=', 'month'),
                    ], limit=1)
                if plan:
                    vals['plan_id'] = plan.id
            if record.date_order:
                vals['end_date'] = record.date_order + dateutil.relativedelta.relativedelta(months=months)
            if vals:
                record.update(vals)

amort = record.x_calc_monthly_amortization or 0.0
if amort > 0 and not is_direct:
    recurring = record.order_line.filtered(lambda l: l.recurring_invoice and not l.display_type)
    if len(recurring) == 1 and abs(recurring.price_unit - amort) > 0.005:
        recurring.update({'price_unit': amort})
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const api = await connect(cfg);
const manifest = readManifest(cfg);
manifest.url = cfg.url;
const run = { at: now(), steps, apply: APPLY, calculatorUrl: flags["calculator-url"] || null, actions: [] };
const log = (msg) => { console.log(msg); run.actions.push(msg); };

// Look up by natural key; create when absent (and --yes). Returns the id, or
// null in dry-run when the record does not exist yet.
async function ensure({ step, model, key, domain, fields = ["id"], vals, describe }) {
  const existing = await api.one(model, domain, fields);
  if (existing) {
    const known = findCreated(manifest, model, key);
    recordCreated(manifest, { model, id: existing.id, key, step, created: known ? known.created : false, at: known ? known.at : now() });
    log(`  = ${model} "${key}" exists (id ${existing.id})`);
    return existing.id;
  }
  if (!APPLY) { log(`  + would create ${model} "${key}"${describe ? ` — ${describe}` : ""}`); return null; }
  const values = typeof vals === "function" ? await vals() : vals;
  const id = await api.call(model, "create", [values]);
  recordCreated(manifest, { model, id, key, step, created: true, at: now() });
  log(`  + created ${model} "${key}" (id ${id})`);
  return id;
}

async function ensureManualField(step, modelName, modelId, spec) {
  return ensure({
    step,
    model: "ir.model.fields",
    key: `${modelName}.${spec.name}`,
    domain: [["model", "=", modelName], ["name", "=", spec.name]],
    vals: { model_id: modelId, state: "manual", ...spec },
    describe: `${spec.ttype}${spec.relation ? ` → ${spec.relation}` : ""}`,
  });
}

async function ensureView(step, name, model, inheritId, arch, priority) {
  return ensure({
    step,
    model: "ir.ui.view",
    key: name,
    domain: [["name", "=", name], ["model", "=", model]],
    vals: { name, model, type: "form", inherit_id: inheritId, mode: "extension", priority, arch_base: arch },
    describe: `inherits view ${inheritId}`,
  });
}

// ─── Steps ───────────────────────────────────────────────────────────────────
async function step064G() {
  log("064G — package products");
  const productFields = await api.call("product.template", "fields_get", [], { attributes: ["type"] });
  const category = await api.one("product.category", [["name", "=", "Solar System"]], ["id", "complete_name"]);
  if (category) log(`  category: ${category.complete_name} (id ${category.id})`);
  else log("  category 'Solar System' not found — products will use the default category");
  for (const p of PACKAGE_PRODUCTS) {
    const vals = {
      name: p.name,
      default_code: p.code,
      sale_ok: true,
      purchase_ok: false,
      // Goods, like the existing "Solar PV System NkWp" products. The price
      // is set per quotation line by the calculator (story 064D), so the list
      // price is a ₱1 placeholder following the catalogue's convention.
      type: "consu",
      list_price: 1.0,
      description_sale: "Internal Calculator package line. The price on each quotation comes from the generated proposal.",
    };
    if ("is_storable" in productFields) vals.is_storable = false;
    if (category) vals.categ_id = category.id;
    await ensure({
      step: "064G",
      model: "product.template",
      key: p.name,
      domain: [["name", "=", p.name], ["active", "in", [true, false]]],
      vals,
      describe: p.code,
    });
  }
}

async function step064I() {
  log("064I — Bill of Quantities table");
  const saleOrderModelId = await api.modelId("sale.order");
  let boqModelId = await ensure({
    step: "064I",
    model: "ir.model",
    key: BOQ_MODEL,
    domain: [["model", "=", BOQ_MODEL]],
    vals: { name: "Bill of Quantities Line", model: BOQ_MODEL, state: "manual" },
    describe: "manual model",
  });
  if (!boqModelId) { log("  (fields, access rule and page follow once the model exists)"); return; }
  for (const spec of BOQ_FIELDS) await ensureManualField("064I", BOQ_MODEL, boqModelId, spec);
  const groupUser = await api.xmlid("base", "group_user");
  await ensure({
    step: "064I",
    model: "ir.model.access",
    key: `${BOQ_MODEL}_user`,
    domain: [["model_id", "=", boqModelId], ["name", "=", `${BOQ_MODEL}_user`]],
    vals: { name: `${BOQ_MODEL}_user`, model_id: boqModelId, group_id: groupUser, perm_read: true, perm_write: true, perm_create: true, perm_unlink: true },
    describe: "internal users: read/write/create/unlink",
  });
  const o2m = await ensureManualField("064I", "sale.order", saleOrderModelId, {
    name: "x_boq_line_ids", ttype: "one2many", relation: BOQ_MODEL, relation_field: "x_sale_order_id",
    field_description: "Bill of Quantities", copied: true,
  });
  if (!o2m) return;
  const baseForm = await api.xmlid("sale", "view_order_form");
  await ensureView("064I", VIEW_BOQ, "sale.order", baseForm, ARCH_BOQ, 90);
}

async function step064E() {
  log("064E — calculator figures + bill-schedule automation");
  const saleOrderModelId = await api.modelId("sale.order");
  let allFields = true;
  for (const spec of CALC_FIELDS) {
    const id = await ensureManualField("064E", "sale.order", saleOrderModelId, spec);
    if (!id) allFields = false;
  }
  if (allFields) {
    const baseForm = await api.xmlid("sale", "view_order_form");
    await ensureView("064E", VIEW_FIGURES, "sale.order", baseForm, ARCH_FIGURES, 91);
  } else {
    log("  (figures page follows once the fields exist)");
  }

  const automation = await api.one("base.automation", [["name", "=", AUTOMATION_NAME], ["model_name", "=", "sale.order"]], ["id", "action_server_ids", "trigger", "active"]);
  if (!automation) { log(`  ! automation "${AUTOMATION_NAME}" not found — skipping the code update`); return; }
  const actionId = automation.action_server_ids && automation.action_server_ids[0];
  if (!actionId) { log("  ! automation has no server action — skipping"); return; }
  const [action] = await api.call("ir.actions.server", "read", [[actionId]], { fields: ["name", "state", "code"] });
  if (action.state !== "code") { log(`  ! server action ${actionId} is not a code action (${action.state}) — skipping`); return; }
  if ((action.code || "").includes(AUTOMATION_MARKER) && (action.code || "").trim() === AUTOMATION_CODE.trim()) {
    log(`  = automation ${automation.id} / action ${actionId} already carries the ${AUTOMATION_MARKER} code`);
    return;
  }
  if (!allFields) { log("  ! fields not created yet (dry run?) — the automation code references them, so it is updated only in the same --yes run"); }
  if (!APPLY) { log(`  ~ would replace the code of server action ${actionId} ("${action.name}")`); return; }
  recordModified(manifest, { model: "ir.actions.server", id: actionId, field: "code", before: action.code, after: AUTOMATION_CODE, step: "064E", at: now() });
  await api.call("ir.actions.server", "write", [[actionId], { code: AUTOMATION_CODE }]);
  log(`  ~ replaced the code of server action ${actionId} (previous code saved in the manifest)`);
}

async function step064B() {
  log("064B — Generate Proposal button");
  const url = flags["calculator-url"];
  if (!url) throw new Error("--calculator-url is required for step 064B (e.g. https://staging-internalcalc.solvivaenergy.com)");
  const param = await api.one("ir.config_parameter", [["key", "=", PARAM_KEY]], ["id", "value"]);
  if (param) {
    if (param.value !== url) {
      if (APPLY) {
        recordModified(manifest, { model: "ir.config_parameter", id: param.id, field: "value", before: param.value, after: url, step: "064B", at: now() });
        await api.call("ir.config_parameter", "write", [[param.id], { value: url }]);
        log(`  ~ ${PARAM_KEY}: "${param.value}" → "${url}"`);
      } else log(`  ~ would set ${PARAM_KEY} to "${url}" (currently "${param.value}")`);
    } else log(`  = ${PARAM_KEY} = "${url}"`);
    recordCreated(manifest, { model: "ir.config_parameter", id: param.id, key: PARAM_KEY, step: "064B", created: (findCreated(manifest, "ir.config_parameter", PARAM_KEY) || {}).created || false, at: now() });
  } else {
    await ensure({ step: "064B", model: "ir.config_parameter", key: PARAM_KEY, domain: [["key", "=", PARAM_KEY]], vals: { key: PARAM_KEY, value: url }, describe: url });
  }
  const crmLeadModelId = await api.modelId("crm.lead");
  const actionId = await ensure({
    step: "064B",
    model: "ir.actions.server",
    key: ACTION_NAME,
    domain: [["name", "=", ACTION_NAME], ["model_name", "=", "crm.lead"]],
    vals: { name: ACTION_NAME, model_id: crmLeadModelId, state: "code", code: ACTION_CODE },
    describe: "code action returning ir.actions.act_url",
  });
  if (actionId && APPLY) {
    const [current] = await api.call("ir.actions.server", "read", [[actionId]], { fields: ["code"] });
    if ((current.code || "").trim() !== ACTION_CODE.trim()) {
      recordModified(manifest, { model: "ir.actions.server", id: actionId, field: "code", before: current.code, after: ACTION_CODE, step: "064B", at: now() });
      await api.call("ir.actions.server", "write", [[actionId], { code: ACTION_CODE }]);
      log(`  ~ refreshed the code of server action ${actionId}`);
    }
  }
  if (!actionId) { log("  (button view follows once the action exists)"); return; }
  const opporForm = await api.xmlid("sale_crm", "crm_case_form_view_oppor");
  await ensureView("064B", VIEW_BUTTON, "crm.lead", opporForm, archButton(actionId), 99);
}

async function step064L() {
  log("064L — hide New Quotation on the opportunity");
  const opporForm = await api.xmlid("sale_crm", "crm_case_form_view_oppor");
  await ensureView("064L", VIEW_HIDE_NEW_QUOTATION, "crm.lead", opporForm, ARCH_HIDE_NEW_QUOTATION, 100);
}

const STEPS = { "064G": step064G, "064I": step064I, "064E": step064E, "064B": step064B, "064L": step064L };

try {
  for (const s of steps) {
    await STEPS[s]();
    manifest.steps[s] = { ...(manifest.steps[s] || {}), lastRun: now(), applied: APPLY || (manifest.steps[s] || {}).applied || false };
  }
  manifest.runs.push(run);
  writeManifest(cfg, manifest);
  console.log(`\nManifest: scripts/odoo/manifests/${cfg.db}.json`);
  console.log(APPLY ? "Done. Run verify-dinuguan.mjs next." : "Dry run complete. Re-run with --yes to apply.");
} catch (err) {
  manifest.runs.push({ ...run, error: String(err && err.message) });
  writeManifest(cfg, manifest);
  console.error(`\nFAILED: ${err.message}`);
  console.error("The manifest records what was created before the failure; re-running is safe (idempotent).");
  process.exit(1);
}
