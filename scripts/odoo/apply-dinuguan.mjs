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
//   064G  the package products (A / B / C, plus "D. Interest" for 064S) and
//         the Sales Package configuration model that points at them
//   064D  what the order lines need: the "12%" sale tax price-included (as
//         on the staging build) and the company's discount product
//   064C  the quotation header fields the push fills — Payment Scheme, Mode,
//         Tenor, Downpayment %, Amount, Financed Amount (064S), Create Mode
//         (SOLSB-23) — their defaults, and a form group showing them
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
const STEP_ORDER = ["064G", "064D", "064C", "064I", "064E", "064B", "064L"];
const only = flags.only ? String(flags.only).split(",").map((s) => s.trim()) : null;
const skip = new Set(flags.skip ? String(flags.skip).split(",").map((s) => s.trim()) : []);
const steps = STEP_ORDER.filter((s) => (!only || only.includes(s)) && !skip.has(s));

const cfg = loadEnv(flags);
guardTarget(cfg, flags, { write: true });
const APPLY = !!flags.yes;
const now = () => new Date().toISOString();

// ─── Names and archs (the natural keys) ──────────────────────────────────────
// Mirror of PACKAGE_PRODUCT_NAMES in src/odooQuotationService.js.
//
// Types and categories copy the STAGING set (user decision 2026-10-06):
// A and B are the services Andrian Jim Cubillas created by hand on the
// staging build on 2026-09-18 in the default category ("All"); C is the
// Goods product this script made in "Solar System" on 2026-09-25 and D the
// service it made there on 2026-10-01. Production has none of the four, so
// this is what it gets. `solarSystemCategory: false` leaves the product in
// Odoo's default category, as on staging.
export const PACKAGE_PRODUCTS = [
  { code: "IC-PKG-A", name: "A. Solar Package", type: "service", solarSystemCategory: false },
  { code: "IC-PKG-B", name: "B. Battery Package", type: "service", solarSystemCategory: false },
  { code: "IC-PKG-C", name: "C. Misc. Materials, Labor, Services & Other Adjustments", type: "consu", solarSystemCategory: true },
  // 064S — the interest line of an RTO quotation. A service: nothing is
  // delivered. Taxes are left at the company default; Finance decides the
  // VAT treatment of interest on the product itself.
  { code: "IC-PKG-D", name: "D. Interest", type: "service", solarSystemCategory: true },
];

// 064G criterion 2 — a "Sales Package" configuration model (Sales ›
// Configuration › Sales Packages), one record per package, each pointing at
// its product.product. The calculator does not read it; it is the place the
// business keeps the package ↔ product mapping that the quotation lines use.
const PKG_MODEL = "x_sales_package";
const PKG_MODEL_FIELDS = [
  { name: "x_name", ttype: "char", field_description: "Sales Package", required: true },
  { name: "x_code", ttype: "char", field_description: "Code" },
  { name: "x_sequence", ttype: "integer", field_description: "Sequence" },
  { name: "x_product_id", ttype: "many2one", relation: "product.product", on_delete: "set null", field_description: "Product" },
];
const PKG_ACTION_NAME = "Sales Packages";
const PKG_MENU_NAME = "Sales Packages";

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

// 064D — the sale tax the package products carry. On the staging build AJ set
// it to "Included in Price" + "Affect Base of Subsequent Taxes" on 2026-09-18;
// the calculator's VAT-inclusive subtotals rely on that. User decision
// 2026-10-06: production gets the same. Natural key: name + sale + company 1.
// NOTE: this is a property of the tax itself — every product and line that
// carries "12%" is read as VAT-inclusive once it is set, not only quotations.
const TAX_NAME = "12%";
const TAX_WANTED = { price_include_override: "tax_included", include_base_amount: true };

// 064C — the quotation header fields src/odooQuotationService.js writes on
// create. Definitions copied from the staging build (ir.model.fields read
// 2026-10-06): five made in Studio by AJ on 2026-09-11, Create Mode and
// Financed Amount on 2026-09-30. Same technical names, labels, types,
// selection keys and tracking, so the backend's selection checks pass.
const STUDIO_FIELDS = [
  { name: "x_studio_payment_scheme", ttype: "selection", field_description: "Payment Scheme", tracking: 1,
    selection_ids: [[0, 0, { value: "direct", name: "Direct Purchase", sequence: 0 }], [0, 0, { value: "rto", name: "Rent to Own", sequence: 1 }]] },
  { name: "x_studio_mode", ttype: "selection", field_description: "Mode", tracking: 1,
    selection_ids: [[0, 0, { value: "downpayment", name: "Downpayment", sequence: 0 }], [0, 0, { value: "nodown", name: "No Downpayment", sequence: 1 }], [0, 0, { value: "straight", name: "Straight Payment", sequence: 2 }]] },
  { name: "x_studio_create_mode", ttype: "selection", field_description: "Create Mode",
    selection_ids: [[0, 0, { value: "manual", name: "Manual", sequence: 0 }], [0, 0, { value: "automatic", name: "Automatic", sequence: 1 }]] },
  { name: "x_studio_percentage", ttype: "float", field_description: "Percentage", tracking: 1 },
  { name: "x_studio_down_amount", ttype: "monetary", field_description: "Amount", currency_field: "currency_id" },
  { name: "x_studio_tenor", ttype: "integer", field_description: "Tenor" },
  { name: "x_studio_financed_amount", ttype: "monetary", field_description: "Financed Amount", currency_field: "currency_id" },
];
// Defaults as on staging (ir.default): a quotation made by hand is Manual,
// Direct Purchase, Straight Payment, tenor 0; the push overrides them.
const STUDIO_DEFAULTS = [
  ["x_studio_create_mode", "manual"],
  ["x_studio_payment_scheme", "direct"],
  ["x_studio_mode", "straight"],
  ["x_studio_tenor", 0],
];
const VIEW_SCHEME = "Internal Calculator: sale.order payment scheme fields";
// Added only when no other view already places x_studio_payment_scheme (on
// staging AJ's Studio customisation does). Same groups and visibility rules
// as the staging layout for these seven fields, without the staging-only
// fields around them (order type, payment mode, due dates, amortisation).
const ARCH_SCHEME = `<data>
  <xpath expr="//group[@name='sale_header']" position="after">
    <group name="internal_calculator_scheme">
      <group name="internal_calculator_scheme_left" string="Details">
        <field name="x_studio_create_mode" widget="radio" options="{&quot;horizontal&quot;:true}" groups="base.group_no_one"/>
      </group>
      <group name="internal_calculator_scheme_right" string="Payment Scheme">
        <field name="x_studio_payment_scheme" widget="radio" options="{&quot;horizontal&quot;:true}" readonly="state != 'draft'"/>
        <field name="x_studio_mode" widget="radio" options="{&quot;horizontal&quot;:true}" readonly="state != 'draft'"/>
        <field name="x_studio_tenor" invisible="x_studio_payment_scheme == 'direct'" required="x_studio_payment_scheme == 'rto'" readonly="state != 'draft'"/>
      </group>
    </group>
    <group name="internal_calculator_downpayment">
      <group name="internal_calculator_downpayment_left" string="Downpayment" invisible="x_studio_mode != 'downpayment'">
        <field name="x_studio_percentage" widget="float"/>
        <field name="x_studio_down_amount" string="Amount"/>
      </group>
      <group name="internal_calculator_downpayment_right" string="Summary">
        <field name="x_studio_financed_amount" readonly="1" invisible="x_studio_create_mode != 'automatic'"/>
      </group>
    </group>
  </xpath>
</data>`;

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
      // Type per PACKAGE_PRODUCTS (see the note there). The price is set per
      // quotation line by the calculator (story 064D), so the list price is a
      // ₱1 placeholder following the catalogue's convention.
      type: p.type,
      list_price: 1.0,
      description_sale: "Internal Calculator package line. The price on each quotation comes from the generated proposal.",
    };
    if ("is_storable" in productFields) vals.is_storable = false;
    if (category && p.solarSystemCategory) vals.categ_id = category.id;
    await ensure({
      step: "064G",
      model: "product.template",
      key: p.name,
      domain: [["name", "=", p.name], ["active", "in", [true, false]]],
      vals,
      describe: `${p.code}, ${p.type === "service" ? "service" : "goods"}${p.solarSystemCategory && category ? ", Solar System" : ", default category"}`,
    });
  }

  // Criterion 2 — the Sales Package model, its menu, and one record per
  // package pointing at the product variant.
  const pkgModelId = await ensure({
    step: "064G",
    model: "ir.model",
    key: PKG_MODEL,
    domain: [["model", "=", PKG_MODEL]],
    vals: { name: "Sales Package", model: PKG_MODEL, state: "manual" },
    describe: "manual model (Sales › Configuration › Sales Packages)",
  });
  if (!pkgModelId) { log("  (fields, access rule, menu and records follow once the model exists)"); return; }
  for (const spec of PKG_MODEL_FIELDS) await ensureManualField("064G", PKG_MODEL, pkgModelId, spec);
  const groupUser = await api.xmlid("base", "group_user");
  const groupSalesManager = await api.xmlid("sales_team", "group_sale_manager").catch(() => null);
  await ensure({
    step: "064G",
    model: "ir.model.access",
    key: `${PKG_MODEL}_user`,
    domain: [["model_id", "=", pkgModelId], ["name", "=", `${PKG_MODEL}_user`]],
    vals: { name: `${PKG_MODEL}_user`, model_id: pkgModelId, group_id: groupUser, perm_read: true, perm_write: false, perm_create: false, perm_unlink: false },
    describe: "internal users: read",
  });
  if (groupSalesManager) {
    await ensure({
      step: "064G",
      model: "ir.model.access",
      key: `${PKG_MODEL}_manager`,
      domain: [["model_id", "=", pkgModelId], ["name", "=", `${PKG_MODEL}_manager`]],
      vals: { name: `${PKG_MODEL}_manager`, model_id: pkgModelId, group_id: groupSalesManager, perm_read: true, perm_write: true, perm_create: true, perm_unlink: true },
      describe: "sales managers: read/write/create/unlink",
    });
  }
  const actionId = await ensure({
    step: "064G",
    model: "ir.actions.act_window",
    key: PKG_ACTION_NAME,
    domain: [["name", "=", PKG_ACTION_NAME], ["res_model", "=", PKG_MODEL]],
    vals: { name: PKG_ACTION_NAME, res_model: PKG_MODEL, view_mode: "list,form" },
    describe: "list,form window action",
  });
  const configMenu = await api.xmlid("sale", "menu_sale_config");
  if (actionId) {
    await ensure({
      step: "064G",
      model: "ir.ui.menu",
      key: `Sales/Configuration/${PKG_MENU_NAME}`,
      domain: [["name", "=", PKG_MENU_NAME], ["parent_id", "=", configMenu]],
      vals: { name: PKG_MENU_NAME, parent_id: configMenu, action: `ir.actions.act_window,${actionId}`, sequence: 90 },
      describe: "under Sales › Configuration",
    });
  }
  let sequence = 10;
  for (const p of PACKAGE_PRODUCTS) {
    const tmpl = await api.one("product.template", [["name", "=", p.name], ["active", "in", [true, false]]], ["id", "product_variant_id"]);
    const variantId = tmpl && Array.isArray(tmpl.product_variant_id) ? tmpl.product_variant_id[0] : null;
    await ensure({
      step: "064G",
      model: PKG_MODEL,
      key: p.name,
      domain: [["x_name", "=", p.name]],
      vals: { x_name: p.name, x_code: p.code, x_sequence: sequence, x_product_id: variantId },
      describe: variantId ? `→ product.product ${variantId}` : "(product not found yet)",
    });
    sequence += 10;
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

// A global ir.default (no user, no company, no condition) for a field.
// ir.default.set() is idempotent on Odoo's side, but the record id is what
// rollback needs, so it is looked up after the call.
async function ensureDefault(step, modelName, fieldName, value) {
  const key = `${modelName}.${fieldName}`;
  const domain = [["field_id.model", "=", modelName], ["field_id.name", "=", fieldName], ["user_id", "=", false], ["company_id", "=", false], ["condition", "=", false]];
  const existing = await api.one("ir.default", domain, ["id", "json_value"]);
  if (existing) {
    const known = findCreated(manifest, "ir.default", key);
    recordCreated(manifest, { model: "ir.default", id: existing.id, key, step, created: known ? known.created : false, at: known ? known.at : now() });
    log(`  = ir.default ${key} = ${existing.json_value}`);
    return existing.id;
  }
  if (!APPLY) { log(`  + would set ir.default ${key} = ${JSON.stringify(value)}`); return null; }
  await api.call("ir.default", "set", [modelName, fieldName, value]);
  const row = await api.one("ir.default", domain, ["id"]);
  if (row) recordCreated(manifest, { model: "ir.default", id: row.id, key, step, created: true, at: now() });
  log(`  + ir.default ${key} = ${JSON.stringify(value)}${row ? ` (id ${row.id})` : ""}`);
  return row ? row.id : null;
}

async function step064D() {
  log("064D — order-line prerequisites: price-included 12% tax, company discount product");

  // The tax. Previous values go to the manifest so rollback can restore them.
  const tax = await api.one("account.tax", [["name", "=", TAX_NAME], ["type_tax_use", "=", "sale"], ["company_id", "=", 1]], ["id", "name", ...Object.keys(TAX_WANTED)]);
  if (!tax) {
    log(`  ! sale tax "${TAX_NAME}" not found — the package products will carry the company default; check the VAT treatment by hand`);
  } else {
    const changes = Object.entries(TAX_WANTED).filter(([k, v]) => tax[k] !== v);
    if (!changes.length) {
      log(`  = account.tax ${tax.id} "${tax.name}" is already price-included`);
    } else if (!APPLY) {
      log(`  ~ would set account.tax ${tax.id} "${tax.name}": ${changes.map(([k, v]) => `${k} ${JSON.stringify(tax[k])} → ${JSON.stringify(v)}`).join(", ")}`);
    } else {
      for (const [k, v] of changes) recordModified(manifest, { model: "account.tax", id: tax.id, field: k, before: tax[k], after: v, step: "064D", at: now() });
      await api.call("account.tax", "write", [[tax.id], Object.fromEntries(changes)]);
      log(`  ~ account.tax ${tax.id} "${tax.name}": ${changes.map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join(", ")} (previous values saved in the manifest)`);
    }
  }

  // The company's discount product. The promo Discount lines land on
  // res.company.sale_discount_product_id, which Odoo only fills the first
  // time somebody applies a global discount through the Discount wizard
  // (that is how staging got product 411 on 2026-09-18). Production has the
  // "Discount on lines" group enabled but nobody has used the wizard, so the
  // field is empty and the lines would be skipped. Same values the wizard
  // uses (sale.order.discount._prepare_discount_product_values): a ₱0
  // service with no taxes. Rollback restores the field and archives the
  // product like any other created product.
  const [company] = await api.call("res.company", "read", [[1]], { fields: ["name", "sale_discount_product_id"] });
  if (company.sale_discount_product_id) {
    log(`  = company discount product: ${company.sale_discount_product_id[1]} (product.product ${company.sale_discount_product_id[0]})`);
    return;
  }
  const discountTmplId = await ensure({
    step: "064D",
    model: "product.template",
    key: "Discount",
    domain: [["name", "=", "Discount"], ["type", "=", "service"], ["active", "=", true], ["company_id", "in", [1, false]]],
    vals: { name: "Discount", type: "service", invoice_policy: "order", list_price: 0.0, company_id: 1, taxes_id: false },
    describe: "the Discount wizard's product (₱0 service, no tax) — becomes res.company.sale_discount_product_id",
  });
  if (!discountTmplId) { log("  ~ would set res.company 1 sale_discount_product_id to that product"); return; }
  const [tmpl] = await api.call("product.template", "read", [[discountTmplId]], { fields: ["product_variant_id"] });
  const variantId = Array.isArray(tmpl.product_variant_id) ? tmpl.product_variant_id[0] : null;
  if (!APPLY) { log(`  ~ would set res.company 1 sale_discount_product_id → product.product ${variantId}`); return; }
  if (variantId) {
    recordModified(manifest, { model: "res.company", id: 1, field: "sale_discount_product_id", before: false, after: variantId, step: "064D", at: now() });
    await api.call("res.company", "write", [[1], { sale_discount_product_id: variantId }]);
    log(`  ~ res.company 1 (${company.name}) sale_discount_product_id → product.product ${variantId}`);
  }
}

async function step064C() {
  log("064C — quotation header fields the push fills (Payment Scheme, Downpayment, Create Mode, Financed Amount)");
  const saleOrderModelId = await api.modelId("sale.order");
  let allFields = true;
  for (const spec of STUDIO_FIELDS) {
    const id = await ensureManualField("064C", "sale.order", saleOrderModelId, spec);
    if (!id) allFields = false;
  }
  for (const [field, value] of STUDIO_DEFAULTS) await ensureDefault("064C", "sale.order", field, value);
  if (!allFields) { log("  (form group follows once the fields exist)"); return; }
  const placed = await api.searchRead("ir.ui.view",
    [["model", "=", "sale.order"], ["active", "=", true], ["name", "!=", VIEW_SCHEME], ["arch_db", "ilike", "x_studio_payment_scheme"]],
    ["id", "name"], { limit: 1 });
  if (placed.length) { log(`  = fields already placed by view ${placed[0].id} "${placed[0].name}" — no form group added`); return; }
  const baseForm = await api.xmlid("sale", "view_order_form");
  await ensureView("064C", VIEW_SCHEME, "sale.order", baseForm, ARCH_SCHEME, 92);
}

const STEPS = { "064G": step064G, "064D": step064D, "064C": step064C, "064I": step064I, "064E": step064E, "064B": step064B, "064L": step064L };

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
