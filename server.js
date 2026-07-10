import express from "express";
import { buildQuote } from "./src/quoteService.js";
import { getParameters, putParameters } from "./src/parametersService.js";

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

app.put("/api/parameters", async (req, res) => {
  try {
    const suppliedPassword = req.headers["x-solviva-edit-password"] || "";
    const claimedRole = req.headers["x-solviva-role"] || "";
    const result = await putParameters(req.body, claimedRole, suppliedPassword);
    return res.status(result.status).json(result.payload);
  } catch (error) {
    return res.status(500).json({
      error: "Failed to save parameters.",
      detail: String(error?.message || error),
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  console.log(`InternalCalc backend listening on port ${port}`);
});
