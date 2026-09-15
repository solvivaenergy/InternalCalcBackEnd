// MUST stay first: loads .env relative to this repo rather than to cwd, which
// is the frontend directory when its dev script launches this server.
import "./src/loadEnv.js";
import { randomUUID } from "node:crypto";
import express from "express";
import { buildQuote } from "./src/quoteService.js";
import {
  getParameters,
  putParameters,
  getAuditEvents,
} from "./src/parametersService.js";
import { getCrmContact } from "./src/crmContactService.js";

const app = express();
const port = process.env.PORT || 3000;
const allowedOrigins = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    allowedOrigins.includes("*") ||
    (origin && allowedOrigins.includes(origin))
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      allowedOrigins.includes("*") ? "*" : origin,
    );
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
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

app.post("/api/quote", async (req, res) => {
  try {
    const payload =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body.input && typeof req.body.input === "object"
          ? req.body.input
          : req.body
        : null;

    if (!payload) {
      return res
        .status(400)
        .json({ error: "Request body must be a JSON object." });
    }

    const result = await buildQuote(payload);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      error: "Failed to generate quote.",
      detail: String(error?.message || error),
    });
  }
});

app.get("/api/parameters", async (_req, res) => {
  try {
    const data = await getParameters();
    return res.status(200).json(data || {});
  } catch (error) {
    return res.status(500).json({
      error: "Failed to load parameters.",
      detail: String(error?.message || error),
    });
  }
});

app.get("/api/parameter-audit", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    const claimedRole = req.headers["x-solviva-role"] || "";
    const result = await getAuditEvents(
      accessToken,
      claimedRole,
      req.query.limit,
    );
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return res.status(500).json({
      error: "Failed to load audit history.",
      detail: String(error?.message || error),
    });
  }
});

app.put("/api/parameters", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    const claimedRole = req.headers["x-solviva-role"] || "";
    const requestId = randomUUID();
    const result = await putParameters(
      req.body,
      accessToken,
      claimedRole,
      requestId,
    );
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return res.status(500).json({
      error: "Failed to save parameters.",
      detail: String(error?.message || error),
    });
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
    const authHeader = req.headers["authorization"] || "";
    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    const result = await getCrmContact(req.query.projectNumber, accessToken);
    return res.status(result.status).json(result.payload);
  } catch (error) {
    // No `detail` here, unlike the routes above: an Odoo fault message carries
    // a traceback plus the database name and the integration username.
    console.error("[crm-contact] unexpected", error);
    return res.status(500).json({ error: "CRM lookup failed." });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  console.log(`InternalCalc backend listening on port ${port}`);
});
