// =============================================================================
// TOOLS — what the "Internal Calculator" MCP connector offers Claude
// -----------------------------------------------------------------------------
// Eight read-only tools. Every one takes `environment` (production | staging |
// testing) so the team can check a staging parameter change before it is
// promoted, and every one answers JSON. Nothing here writes anywhere: the
// database role is SELECT-only, Odoo is never contacted, and the proposal tool
// only RETURNS the payload the calculator would push.
// =============================================================================

import { z } from "zod";
import { computeProposal } from "@solviva/calc-engine";
import {
  ENVIRONMENTS,
  ENVIRONMENT_KEYS,
  EnvironmentError,
  isConfigured,
  readAuditEvents,
  readParameters,
} from "./db.js";
import { ENGINE_VERSION, buildState, projectQuote, runQuote, withRuntime } from "./engine.js";
import { SECTIONS, marginSchedule, parametersView, rateTable } from "./parameters.js";
import { buildProposal } from "./proposal.js";
import { ToolError, manila, round2, tidy } from "./util.js";

export const SERVER_NAME = "internalcalc";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `Read-only access to Solviva's Internal Calculator: the pricing engine (@solviva/calc-engine ${ENGINE_VERSION}) run on the live admin parameters of the production, staging or testing calculator database.

What it is for: checking how a quote is priced (every line with its COGS, gross margin, MDR allowance and VAT, and which margin rule priced it), reading the parameters behind the prices (margin curves, component margins, interest-rate surface, promo codes, inventory, battery packages, catalog, charges), seeing who changed a parameter and when, comparing scenarios, and assembling a complete proposal from a rep's inputs.

Conventions: prices are PHP and VAT-inclusive; margins and rates are fractions (0.22 = 22%); tenor 0 = Direct Purchase (0% interest, no DST); times are Manila. COGS and margins are INTERNAL — never put them in anything a customer will see; calc_proposal already omits them.

Gathering a proposal from a rep, ask for (defaults in brackets): phase [single]; monthly bill and utility rate [calculator defaults]; the big appliances with on/off hours and days per week (optional); savings target [50%]; roof material [metal]; installation location on Luzon and road-km from the Parañaque hub [18]; whether they want a battery / a specific package / net metering / RSD; financing: tenor in months [0 = direct purchase], down payment % [calculator default], promo code; then the customer's name, email, mobile, installation address and Odoo lead id, and the agent's name/email/phone. Run calc_quote first to sanity-check the system and price, then calc_proposal. This connector cannot create the Odoo quotation or the PDF: a rep does that from the calculator.`;

// ─── schemas ─────────────────────────────────────────────────────────────────

const environment = z
  .enum(ENVIRONMENT_KEYS)
  .default("production")
  .describe("Which calculator database to use: production (the live Internal Calculator), staging or testing.");

const appliance = z.object({
  name: z.string().describe("A device-library name, e.g. '1.5hp AC', 'Microwave/Toaster', 'Level-2 EV Charger' (see calc_parameters section devices)."),
  count: z.number().int().min(1).max(99).default(1),
  onHour: z.number().min(0).max(24).describe("Hour the device switches on, 0–24 (decimals allowed)."),
  offHour: z.number().min(0).max(24).describe("Hour it switches off, 0–24."),
  daysPerWeek: z.number().int().min(1).max(7).default(7),
});

const miscRow = z.object({
  catalogId: z.string().optional().describe("Id or label of a misc-catalog item (calc_parameters section misc_catalog). Omit for a free-form row."),
  description: z.string().optional().describe("Free-form row description (when no catalogId)."),
  count: z.number().min(0).max(999).default(1),
  unitPrice: z.number().min(0).optional().describe("Free-form row unit price, VAT-inclusive pesos (ignored for catalog rows)."),
});

export const QUOTE_INPUT_SHAPE = {
  phase: z.enum(["single", "three"]).default("single").describe("Electrical service: single-phase or three-phase."),
  monthlyBill: z.number().min(0).max(10_000_000).optional().describe("Customer's monthly electricity bill in pesos [calculator default]."),
  utilityRate: z.number().gt(0).max(100).optional().describe("Utility rate, pesos per kWh [calculator default]."),
  appliances: z.array(appliance).max(7).optional().describe("Up to 7 appliance rows that shape the day/night profile."),
  desiredSavingsPct: z.number().min(0).max(1).optional().describe("Savings target as a fraction [0.5]."),
  optimizationMode: z.enum(["panels", "battery", "cost"]).optional().describe("Step 2A objective: 'panels' (fewest panels, store all excess) [default], 'battery' or 'cost'."),
  conservativeSizing: z.boolean().optional().describe("Peaks-and-valleys sizing when appliances run fewer than 7 days a week."),
  panelCount: z.number().int().min(0).max(2000).nullable().optional().describe("Override the recommended panel count (0 = no solar array, e.g. a battery-only or RSD-only order)."),
  inverters: z.array(z.number().nullable()).max(3).optional().describe("Up to 3 inverter slots by rated kW (null = the recommendation for that slot). Must be in-stock sizes for the phase."),
  expansion: z.object({ existingKwp: z.number().gt(0), existingInverterKw: z.number().gt(0).optional() }).optional().describe("Panels-only expansion of an existing array: no inverter is priced."),
  batteryKwh: z.number().min(0).max(1000).nullable().optional().describe("Override the recommended battery size in kWh (0 = no battery)."),
  batteryPackageId: z.string().optional().describe("Battery package id or label (calc_parameters section battery_packages); default = the optimiser's pick."),
  batteryRackIncluded: z.boolean().optional(),
  batteryAtsIncluded: z.boolean().optional(),
  batteryCritLoadsIncluded: z.boolean().optional(),
  dcCableMeters: z.number().min(0).max(5000).optional().describe("Total DC cable run in metres [30 included]."),
  acCableMeters: z.number().min(0).max(5000).optional().describe("Total AC cable run in metres [10 included]."),
  rsdEnabled: z.boolean().optional().describe("Include the Rapid Shutdown Device."),
  rsdStandalonePanelCount: z.number().int().min(0).max(2000).optional().describe("Panels an RSD-only retrofit covers (when panelCount is 0)."),
  netMeteringEnabled: z.boolean().optional(),
  roofMaterial: z.enum(["metal", "asphalt", "concrete"]).optional(),
  location: z.string().optional().describe("'luzon' [default] or 'other'; off-Luzon delivery ids are currently switched off."),
  locationKm: z.number().min(0).max(2000).optional().describe("Road-km from the Parañaque hub [18]; free delivery within the configured radius."),
  locationRegion: z.string().optional(),
  locationProvince: z.string().optional(),
  locationCity: z.string().optional(),
  miscMaterials: z.array(miscRow).max(12).optional().describe("Step 2F rows: catalog items or free-form materials/labor/services/credits."),
  tenor: z.number().int().min(0).max(120).optional().describe("Financing term in months; 0 = Direct Purchase [default 0]."),
  downPaymentPct: z.number().min(0).max(1).optional().describe("Down payment as a fraction of the net price [calculator default]."),
  promoCode: z.string().optional(),
  irrYears: z.number().int().min(1).max(30).optional().describe("Returns horizon [25]."),
  duRateInflation: z.number().min(0).max(0.1).optional().describe("Assumed annual utility-tariff inflation [FinCo default]."),
  generatedDate: z.string().optional().describe("Quote issue date (ISO); anchors validity, install date and the payment schedule [now]."),
};

const includeShape = z
  .object({
    annex: z.boolean().optional().describe("Full schedule of payments (up to 62 rows)."),
    cashflows: z.boolean().optional().describe("30-year cash-flow table behind payback/IRR."),
    hourly: z.boolean().optional().describe("24-hour load/solar/battery simulation."),
    boq: z.boolean().optional().describe("Bill of quantities [true]."),
    orderLines: z.boolean().optional().describe("Odoo order lines per package [true]."),
  })
  .optional();

const customerShape = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  mobile: z.string().optional(),
  installAddress: z.string().optional(),
  odooLeadId: z.number().int().optional().describe("The Odoo opportunity (crm.lead) id, if the customer has one."),
});

const agentShape = z.object({ name: z.string().optional(), email: z.string().optional(), phone: z.string().optional() }).optional();

// ─── helpers ─────────────────────────────────────────────────────────────────

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function respond(fn) {
  return async (args) => {
    try {
      const result = await fn(args || {});
      return { content: [{ type: "text", text: JSON.stringify(tidy(result)) }] };
    } catch (error) {
      const known = error instanceof ToolError || error instanceof EnvironmentError;
      if (!known) console.error("[tool] failed", error);
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  };
}

async function paramsFor(env) {
  const { payload, updatedAt } = await readParameters(env);
  return {
    payload,
    meta: {
      environment: env,
      supabaseRef: ENVIRONMENTS[env].ref,
      parametersUpdatedAt: updatedAt,
      parametersUpdatedAtManila: updatedAt ? manila(updatedAt) : null,
      engineVersion: ENGINE_VERSION,
    },
  };
}

function scenarioSummary(label, projection, warnings) {
  const p = projection;
  return {
    label,
    notes: p.notes,
    system: {
      panelCount: p.system.panelCount,
      systemKwp: p.system.systemKwp,
      inverters: p.system.inverters.map((i) => i.ratedKw),
      batteryKwh: p.system.battery.kwh,
      batteryPackage: p.system.battery.package?.label ?? null,
      coverageSolarPctOfUse: p.savings.coverage.solarPctOfUse,
    },
    pricing: {
      packageTotal: p.pricing.packageTotal,
      discountAmount: p.pricing.discountAmount,
      netPrice: p.pricing.netPrice,
      totalCogs: p.totals.cogs,
      grossMargin: p.totals.grossMargin,
      realizedMarginPct: p.totals.realizedMarginPct,
      terms: p.pricing.selected,
    },
    savings: {
      monthlyPesoSavings: p.savings.monthlyPesoSavings,
      billAfterSolar: p.savings.billAfterSolar,
      paybackLabel: p.savings.paybackLabel,
      irr: p.savings.irr,
    },
    ...(warnings?.length ? { warnings } : {}),
  };
}

// ─── registration ────────────────────────────────────────────────────────────

export function registerTools(server) {
  server.registerTool(
    "calc_environments",
    {
      title: "Calculator environments",
      description:
        "Which calculator databases this server can read (production / staging / testing), the engine version, when each environment's parameters were last saved, and a few counts. Call first when unsure which environment to use.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    respond(async () => {
      const environments = [];
      for (const key of ENVIRONMENT_KEYS) {
        const meta = ENVIRONMENTS[key];
        const row = { environment: key, title: meta.title, supabaseRef: meta.ref, site: meta.site, configured: isConfigured(key) };
        if (row.configured) {
          try {
            const { payload, updatedAt } = await readParameters(key);
            Object.assign(
              row,
              withRuntime(payload, (rt) => ({
                parametersUpdatedAt: updatedAt,
                parametersUpdatedAtManila: updatedAt ? manila(updatedAt) : null,
                storedOverrideKeys: Object.keys(payload.adminParams || {}).length,
                grossMarginReference: rt.adminParams.grossMarginReference,
                merchantDiscountRate: rt.adminParams.merchantDiscountRate,
                invertersInStock: { singlePhase: rt.invertersSinglePhase.filter((i) => i.available !== false).length, threePhase: rt.invertersThreePhase.filter((i) => i.available !== false).length },
                batteryPackages: (rt.adminParams.batteryPackages || []).length,
                promoCodes: (rt.adminParams.promoCodes || []).map((p) => p.code),
                miscCatalogItems: (rt.adminParams.miscCatalog || []).length,
                quoteValidityDays: rt.adminParams.quoteValidityDays,
              })),
            );
          } catch (error) {
            row.error = error.message;
          }
        }
        environments.push(row);
      }
      return {
        server: { name: SERVER_NAME, version: SERVER_VERSION, engineVersion: ENGINE_VERSION, readOnly: true, nowManila: manila(new Date()) },
        environments,
        tools: ["calc_parameters", "calc_margin_schedule", "calc_rate_table", "calc_quote", "calc_compare", "calc_proposal", "calc_parameter_history"],
      };
    }),
  );

  server.registerTool(
    "calc_parameters",
    {
      title: "Calculator parameters",
      description:
        `The effective calculator configuration for an environment (bundled defaults + the stored admin row), by section: ${SECTIONS.join(", ")}. COGS are pre-VAT and Engineering-entered; every referencePrice is the derived direct price at grossMarginReference (what the admin tabs show); a quote re-prices each line at its own resolved margin. 'all' returns every numeric section; 'content' the T&Cs/warranties/disclaimers; 'stored_payload' the raw saved row.`,
      inputSchema: {
        environment,
        section: z.enum(SECTIONS).default("all").describe("Which part of the configuration to return."),
      },
      annotations: READ_ONLY,
    },
    respond(async ({ environment: env, section }) => {
      const { payload, meta } = await paramsFor(env);
      const stored = JSON.parse(JSON.stringify(payload));
      return withRuntime(payload, (rt) => ({ ...meta, section, data: parametersView(rt, section, stored) }));
    }),
  );

  server.registerTool(
    "calc_margin_schedule",
    {
      title: "Margin schedule",
      description:
        "How gross margin is resolved in an environment: the panels margin curve at a set of kWp points (per phase), the battery kWh curve, the per-component margin table and what each component resolves to for every order shape (full system / panels only / no panels), the COGS → price formula, and a worked example. Use it to answer 'what margin applies at X kWp' or 'why is this line priced at Y'.",
      inputSchema: {
        environment,
        kwpPoints: z.array(z.number().min(0).max(1000)).max(40).optional().describe("System sizes in kWp to evaluate [1…40 preset]."),
        batteryKwhPoints: z.array(z.number().min(0).max(1000)).max(40).optional().describe("Battery sizes in kWh to evaluate [0…48 preset]."),
        exampleCogs: z.number().gt(0).max(1e8).optional().describe("COGS used for the examplePrice columns [100000]."),
      },
      annotations: READ_ONLY,
    },
    respond(async ({ environment: env, ...opts }) => {
      const { payload, meta } = await paramsFor(env);
      return withRuntime(payload, (rt) => ({ ...meta, ...marginSchedule(rt, opts) }));
    }),
  );

  server.registerTool(
    "calc_rate_table",
    {
      title: "RTO rate table",
      description:
        "The rent-to-own interest-rate grid (annual rate on the diminishing balance) for a set of tenors × down-payment percentages, the anchors behind it, the minimum-DP tiers and the maximum tenor. Pass netPrice to also get the monthly payment at each cell.",
      inputSchema: {
        environment,
        tenors: z.array(z.number().int().min(0).max(120)).max(20).optional().describe("Tenors in months [1,3,6,9,12,24,36,48,60]."),
        downPayments: z.array(z.number().min(0).max(1)).max(20).optional().describe("Down-payment fractions [0…0.5 preset]."),
        netPrice: z.number().gt(0).optional().describe("A net price to turn the grid into monthly payments."),
      },
      annotations: READ_ONLY,
    },
    respond(async ({ environment: env, ...opts }) => {
      const { payload, meta } = await paramsFor(env);
      return withRuntime(payload, (rt) => ({ ...meta, ...rateTable(rt, opts) }));
    }),
  );

  server.registerTool(
    "calc_quote",
    {
      title: "Price a quote (internal view)",
      description:
        "Run the Internal Calculator's engine on a set of inputs and return the INTERNAL view: consumption and sizing (recommended vs selected), every line item with COGS, gross margin (peso and realised %), MDR allowance, VAT and the margin rule that priced it, package subtotals, the promo/net price, direct-purchase and financed terms with the RA 3765 disclosure, the tenor comparison table, savings/payback/IRR/LCOE, coverage, the schedule preview, the bill of quantities and the Odoo order lines. Omitted inputs take the calculator's defaults, so a call with only monthlyBill reproduces what a rep sees on a fresh session with that bill.",
      inputSchema: { environment, ...QUOTE_INPUT_SHAPE, include: includeShape },
      annotations: READ_ONLY,
    },
    respond(async ({ environment: env, include, ...inputs }) => {
      const { payload, meta } = await paramsFor(env);
      const { projection } = runQuote(payload, inputs, include || {});
      return { ...meta, ...projection };
    }),
  );

  server.registerTool(
    "calc_compare",
    {
      title: "Compare quote scenarios",
      description:
        "Price 2–6 scenarios side by side (same inputs as calc_quote, each with a label) and return a compact summary per scenario: system, net price, total COGS, gross margin and realised %, the selected terms, savings and payback. For 'what if' questions: DP 20% vs 30%, 5 kWh vs 16 kWh battery, single vs three-phase, with/without promo.",
      inputSchema: {
        environment,
        scenarios: z.array(z.object({ label: z.string().min(1), ...QUOTE_INPUT_SHAPE })).min(2).max(6),
      },
      annotations: READ_ONLY,
    },
    respond(async ({ environment: env, scenarios }) => {
      const { payload, meta } = await paramsFor(env);
      const results = scenarios.map(({ label, ...inputs }) => {
        try {
          const { projection } = runQuote(payload, inputs, { boq: false, orderLines: false });
          return scenarioSummary(label, projection);
        } catch (error) {
          if (error instanceof ToolError) return { label, error: error.message };
          throw error;
        }
      });
      return { ...meta, scenarios: results };
    }),
  );

  server.registerTool(
    "calc_proposal",
    {
      title: "Assemble a proposal",
      description:
        "Everything the calculator's proposal PDF prints, as data, for a customer: reference number, issue/validity dates, presented-to/by, system summary, the system package in detail (customer prices only — no COGS or margins), payment options, the selected terms and the RA 3765 disclosure, the full schedule of payments, savings and returns, warranties, the T&Cs with validity tokens filled in, and the disclaimers. Also returns odooPayload: the exact body the calculator would POST to create the draft Odoo quotation — for reference only; this server never writes to Odoo or produces the PDF (a rep does both from the calculator). Run calc_quote first to check the inputs.",
      inputSchema: { environment, ...QUOTE_INPUT_SHAPE, customer: customerShape, agent: agentShape, includeInternal: z.boolean().optional().describe("Also return the internal projection (COGS, margins) under `internal` — never for customer-facing output.") },
      annotations: READ_ONLY,
    },
    respond(async ({ environment: env, customer, agent, includeInternal, ...inputs }) => {
      const { payload, meta } = await paramsFor(env);
      return withRuntime(payload, () => {
        const { state, warnings, generatedDate } = buildState(inputs);
        const model = computeProposal(state, generatedDate);
        const internal = projectQuote({ state, model, generatedDate, warnings, include: { annex: true } });
        const proposal = buildProposal({ internal, model, state: model.fullState, customer, agent: agent || {}, generatedDate, leadId: customer.odooLeadId ?? null });
        return { ...meta, proposal, ...(includeInternal ? { internal } : {}) };
      });
    }),
  );

  server.registerTool(
    "calc_parameter_history",
    {
      title: "Parameter change history",
      description:
        "Who changed which calculator parameter, when (parameter_audit_events), newest first: actor email and role, the admin tab(s) the save touched, the applied parameter keys and the field-level `changes` list (path, before, after). Filter by admin tab (Product, Engineering, FinCo, Inventory — substring match, a save can span several), by actor email substring, or since an ISO timestamp. Derived-price ripples are not audited, only authored inputs.",
      inputSchema: {
        environment,
        limit: z.number().int().min(1).max(200).default(30),
        area: z.string().optional().describe("Admin tab name substring: Product, Engineering, FinCo or Inventory."),
        actor: z.string().optional().describe("Case-insensitive substring of the actor's email."),
        since: z.string().optional().describe("ISO timestamp; events at or after it."),
        includePayloads: z.boolean().optional().describe("Also return the full before/after parameter payloads per event (large)."),
      },
      annotations: READ_ONLY,
    },
    respond(async ({ environment: env, limit, area, actor, since, includePayloads }) => {
      const rows = await readAuditEvents(env, { limit, area, actor, since, includePayloads });
      return {
        environment: env,
        supabaseRef: ENVIRONMENTS[env].ref,
        count: rows.length,
        events: rows.map((r) => ({
          id: r.id,
          occurredAt: r.occurred_at,
          occurredAtManila: manila(r.occurred_at),
          actorEmail: r.actor_email,
          actorRole: r.actor_role,
          area: r.area,
          source: r.source,
          changes: r.changes,
          appliedAdminKeys: r.applied_admin_keys,
          ignoredAdminKeys: r.ignored_admin_keys,
          inventoryApplied: r.inventory_applied,
          requestId: r.request_id,
          metadata: r.metadata,
          ...(includePayloads ? { beforePayload: r.before_payload, afterPayload: r.after_payload } : {}),
        })),
      };
    }),
  );
}

export { round2 };
