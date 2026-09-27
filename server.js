// MUST stay first: loads .env relative to this repo rather than to cwd, which
// is the frontend directory when its dev script launches this server.
import "./src/loadEnv.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { buildEstimate } from "./src/estimateService.js";
import {
  getParameters,
  putParameters,
  getAuditEvents,
} from "./src/parametersService.js";
import { getCrmContact } from "./src/crmContactService.js";
import { createQuotationFromProposal } from "./src/odooQuotationService.js";
import {
  listUsers,
  createUser,
  updateUser,
  setUserArchived,
} from "./src/usersService.js";
import { rateLimit } from "./src/rateLimit.js";

const app = express();
const port = process.env.PORT || 3000;

// Render terminates TLS and forwards the caller's address in X-Forwarded-For.
// Trusting that one hop makes req.ip the caller rather than Render's proxy,
// which is what the rate limiter keys on.
app.set("trust proxy", 1);

// CORS (2026-09-27). A browser on a listed origin may call the API; a page on
// any other origin gets no Access-Control-Allow-Origin header and the browser
// blocks the response. Unset used to mean "*" — any website could script calls
// against this service, and both Render services ran that way. Unset now
// means the calculator's own origins (below), so a service with no
// CORS_ORIGINS configured is locked to the two deployed frontends and the
// Vite dev server (DEVELOPER_SETUP.md points local dev at the staging backend).
// Setting CORS_ORIGINS replaces that list; "*" allows all and is what
// dev-server.js uses. Non-browser callers (curl, a server-side fetch from a
// Worker) are unaffected: CORS is enforced by browsers, not by this server.
const DEFAULT_ORIGINS = [
  "https://internalcalc.solvivaenergy.com",
  "https://staging-internalcalc.solvivaenergy.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const corsOriginsRaw = process.env.CORS_ORIGINS;
const allowedOrigins = corsOriginsRaw
  ? corsOriginsRaw
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : DEFAULT_ORIGINS;
const allowAnyOrigin = allowedOrigins.includes("*");
console.log(
  `[cors] ${corsOriginsRaw ? "CORS_ORIGINS" : "built-in default"}: ${allowedOrigins.join(", ")}`,
);

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  if (allowAnyOrigin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-solviva-edit-password, x-solviva-role",
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

// Website estimate (2026-09-27). The External Calculator's Cloudflare Worker
// calls this with the shared PUBLIC_ESTIMATE_KEY and the visitor's address; it
// runs the same @solviva/calc-engine pipeline the Internal Calculator runs in
// a rep's browser and answers a customer-facing projection — no COGS, no
// margins (src/estimateService.js). Registered BEFORE the /api limiter below,
// which keys on req.ip: from here every website visitor would look like the
// Worker's one address. Instead:
//   1. a generous per-address cap bounds anyone probing the URL,
//   2. the shared key is checked (503 when the service has no key at all, so
//      an unconfigured deployment exposes nothing),
//   3. then a per-visitor cap keyed on the address the Worker forwards — read
//      only after the key check, so the header cannot be forged to dodge (1).
const estimateKeyOk = (req) => {
  const expected = process.env.PUBLIC_ESTIMATE_KEY || "";
  const given = req.get("x-estimate-key") || "";
  if (!expected || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
};
app.post(
  "/api/public/estimate",
  rateLimit({ max: Number(process.env.ESTIMATE_RATE_LIMIT_PER_ADDRESS) || 600, windowMs: 60_000 }),
  (req, res, next) => {
    if (!process.env.PUBLIC_ESTIMATE_KEY) {
      return res.status(503).json({ error: "not_configured" });
    }
    if (!estimateKeyOk(req)) {
      return res.status(401).json({ error: "Invalid estimate key." });
    }
    next();
  },
  rateLimit({
    max: Number(process.env.ESTIMATE_RATE_LIMIT_PER_VISITOR) || 30,
    windowMs: 60_000,
    key: (req) => req.get("x-estimate-client-ip") || req.ip,
  }),
  async (req, res) => {
    try {
      const result = await buildEstimate(req.body);
      return res.status(result.status).json(result.payload);
    } catch (error) {
      console.error("[estimate] failed", error);
      return res.status(500).json({ error: "Failed to compute the estimate." });
    }
  },
);

// Every other /api route: RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_SECONDS
// per client address, 429 beyond that. The calculator makes a handful of calls
// per session; the cap exists so a script cannot hammer routes that reach
// Supabase or Odoo on every call.
app.use(
  "/api",
  rateLimit({
    max: Number(process.env.RATE_LIMIT_MAX) || 120,
    windowMs: (Number(process.env.RATE_LIMIT_WINDOW_SECONDS) || 60) * 1000,
  }),
);

const bearerToken = (req) => {
  const authHeader = req.headers["authorization"] || "";
  return authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
};

// The full parameters row — COGS, margin curves and promo codes included,
// because the calculator derives its selling prices from them in the browser.
// Public until 2026-09-27; now needs a signed-in Supabase user, the same rule
// as the direct PostgREST read the frontend falls back to (migration
// 20260922_app_parameters_authenticated_read.sql).
app.get("/api/parameters", async (req, res) => {
  try {
    const result = await getParameters(bearerToken(req));
    return res.status(result.status).json(result.payload);
  } catch (error) {
    console.error("[parameters] load failed", error);
    return res.status(500).json({ error: "Failed to load parameters." });
  }
});

app.get("/api/parameter-audit", async (req, res) => {
  try {
    const claimedRole = req.headers["x-solviva-role"] || "";
    const result = await getAuditEvents(
      bearerToken(req),
      claimedRole,
      req.query.limit,
    );
    return res.status(result.status).json(result.payload);
  } catch (error) {
    console.error("[parameter-audit] load failed", error);
    return res.status(500).json({ error: "Failed to load audit history." });
  }
});

app.put("/api/parameters", async (req, res) => {
  try {
    const claimedRole = req.headers["x-solviva-role"] || "";
    const requestId = randomUUID();
    const result = await putParameters(
      req.body,
      bearerToken(req),
      claimedRole,
      requestId,
    );
    return res.status(result.status).json(result.payload);
  } catch (error) {
    console.error("[parameters] save failed", error);
    return res.status(500).json({ error: "Failed to save parameters." });
  }
});

// Story 043D — resolve an Odoo "Project Number" (a crm.lead id) into the
// customer's name/email/mobile so a rep does not retype what the CRM has.
// Registered BEFORE the catch-all below: a bare app.use matches every path, so
// anything mounted after it is unreachable.
//
// Deliberately does NOT read x-solviva-role. That header is client-supplied;
// this endpoint returns contact PII, so it trusts only the server-verified
// Supabase JWT.
app.get("/api/crm-contact", async (req, res) => {
  try {
    const result = await getCrmContact(req.query.projectNumber, bearerToken(req));
    return res.status(result.status).json(result.payload);
  } catch (error) {
    // No `detail` here: an Odoo fault message carries a traceback plus the
    // database name and the integration username.
    console.error("[crm-contact] unexpected", error);
    return res.status(500).json({ error: "CRM lookup failed." });
  }
});

// v3-215 / v3-218 — Super Admin user management. Every route verifies the
// Supabase JWT server-side and requires user_roles.role = 'admin'
// (src/usersService.js); x-solviva-role is deliberately not read. Registered
// BEFORE the catch-all.
app.get("/api/users", async (req, res) => {
  try {
    const result = await listUsers(bearerToken(req));
    return res.status(result.status).json(result.payload);
  } catch (error) {
    console.error("[users] list failed", error);
    return res.status(500).json({ error: "Failed to load users." });
  }
});

app.post("/api/users", async (req, res) => {
  try {
    const requestId = randomUUID();
    const result = await createUser(req.body, bearerToken(req), requestId);
    return res.status(result.status).json(result.payload);
  } catch (error) {
    // No `detail`: the body holds a password, and a thrown error could echo
    // request state. Log server-side, answer generically.
    console.error("[users] create failed", error);
    return res.status(500).json({ error: "Failed to create the user." });
  }
});

// Edit role / display name / mobile. Body: { role?, displayName?, mobile? }.
app.patch("/api/users/:id", async (req, res) => {
  try {
    const requestId = randomUUID();
    const result = await updateUser(req.params.id, req.body, bearerToken(req), requestId);
    return res.status(result.status).json(result.payload);
  } catch (error) {
    console.error("[users] update failed", error);
    return res.status(500).json({ error: "Failed to update the user." });
  }
});

// Archive = ban (reversible, nothing deleted); restore = lift the ban.
app.post("/api/users/:id/archive", async (req, res) => {
  try {
    const requestId = randomUUID();
    const result = await setUserArchived(req.params.id, true, bearerToken(req), requestId);
    return res.status(result.status).json(result.payload);
  } catch (error) {
    console.error("[users] archive failed", error);
    return res.status(500).json({ error: "Failed to archive the user." });
  }
});

app.post("/api/users/:id/restore", async (req, res) => {
  try {
    const requestId = randomUUID();
    const result = await setUserArchived(req.params.id, false, bearerToken(req), requestId);
    return res.status(result.status).json(result.payload);
  } catch (error) {
    console.error("[users] restore failed", error);
    return res.status(500).json({ error: "Failed to restore the user." });
  }
});

// Sprint Dinuguan (064C/E/J/K) — the calculator pushes a generated proposal as
// a DRAFT quotation on the Odoo opportunity. Any signed-in Supabase user may
// call it (same product decision as /api/crm-contact); the JWT is verified
// server-side and its email picks the salesperson. Never blocks the PDF: the
// frontend renders every non-2xx as a warning banner. Registered BEFORE the
// catch-all.
app.post("/api/odoo/quotation", async (req, res) => {
  try {
    const requestId = randomUUID();
    const result = await createQuotationFromProposal(req.body, bearerToken(req), requestId);
    return res.status(result.status).json(result.payload);
  } catch (error) {
    // No `detail`: an Odoo fault carries a traceback plus the database name
    // and the integration username.
    console.error("[odoo-quotation] unexpected", error);
    return res.status(500).json({ error: "Quotation push failed." });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  console.log(`InternalCalc backend listening on port ${port}`);
});
