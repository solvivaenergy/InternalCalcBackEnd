#!/usr/bin/env node
// =============================================================================
// Internal Calculator MCP server — read-only pricing, parameters and proposals
// -----------------------------------------------------------------------------
// The calculator's engine (@solviva/calc-engine, a workspace of this repo) run
// on the live admin parameters, exposed to Claude as eight tools (mcp/tools.js).
// Two transports, mirroring the monitoring repo's db_mcp.py:
//
//   node mcp/server.js               stdio, for Claude Code (solviva-inquiry/.mcp.json)
//   node mcp/server.js --http        streamable HTTP on $PORT (default 8083) for
//                                    the claude.ai connector, behind the shared
//                                    bearer token + Anthropic IP allowlist
//
// Environment (see mcp/README.md):
//   DB_MCP_CALC_URL, DB_MCP_CALC_STAGING_URL, DB_MCP_CALC_TESTING_URL
//                              Session-pooler strings for the SELECT-only role
//                              db_mcp_ro (an unset one = that environment is
//                              "not configured")
//   CALC_MCP_SERVICE_TOKEN     shared bearer token (HTTP mode; required)
//   MCP_PUBLIC_HOST            public hostname, for Host-header validation
//   CALC_MCP_ENV_FILE          optional extra .env to load (local runs)
//   MCP_RESTRICT_IPS=false     skip the Anthropic egress allowlist (local only)
// =============================================================================

import "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { bearerAuth, hostGuard } from "./auth.js";
import { configuredEnvironments, closePools } from "./db.js";
import { INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, registerTools } from "./tools.js";

function createServer() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}

function parseArgs(argv) {
  const args = { http: false, port: Number(process.env.PORT) || 8083, allowAnyIp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--allow-any-ip") args.allowAnyIp = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: node mcp/server.js [--http] [--port N] [--allow-any-ip]");
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configured = configuredEnvironments();
  console.error(`[internalcalc-mcp] environments configured: ${configured.join(", ") || "none"}`);

  if (!args.http) {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    return;
  }

  const token = (process.env.CALC_MCP_SERVICE_TOKEN || "").trim();
  if (!token) {
    console.error("CALC_MCP_SERVICE_TOKEN must be set when serving over HTTP.");
    process.exit(1);
  }
  const restrictIps = !args.allowAnyIp && (process.env.MCP_RESTRICT_IPS || "true").toLowerCase() !== "false";
  if (!restrictIps) console.log("[auth] IP allowlist DISABLED — bearer token is the only control.");

  const app = express();
  app.disable("x-powered-by");
  app.use(hostGuard(process.env.MCP_PUBLIC_HOST));
  app.use(bearerAuth({ token, restrictIps }));
  app.use(express.json({ limit: "1mb" }));

  // Stateless streamable HTTP: a fresh server + transport per request, as in
  // the SDK's stateless example, so no session state lives in the container.
  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[mcp] request failed", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });
  const notAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  const listener = app.listen(args.port, "0.0.0.0", () => {
    console.log(`[internalcalc-mcp] listening on :${args.port} (POST /mcp, GET /healthz)`);
  });
  const shutdown = () => {
    listener.close(() => closePools().finally(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
