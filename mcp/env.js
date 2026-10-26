// =============================================================================
// ENV LOADING for the MCP server — must be the FIRST import in mcp/server.js
// -----------------------------------------------------------------------------
// Same rule as src/loadEnv.js: a real environment variable (Render, a shell
// export) always wins over a file. Two files are consulted, in order:
//
//   1. this repo's .env            (so `npm run mcp` works from the checkout)
//   2. $CALC_MCP_ENV_FILE, if set  (an extra file holding the three read-only
//                                   DB_MCP_CALC_* connection strings; locally
//                                   they live in the monitoring repo's .env,
//                                   which is where the "Solviva Databases"
//                                   connector keeps them)
//
// The server itself needs only the DB_MCP_CALC_* URLs, CALC_MCP_SERVICE_TOKEN
// (HTTP mode) and MCP_PUBLIC_HOST (HTTP mode). It never reads the Supabase
// service-role key, Odoo credentials or anything else the API uses.
// =============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(repoRoot, ".env"), override: false });
if (process.env.CALC_MCP_ENV_FILE) {
  dotenv.config({ path: process.env.CALC_MCP_ENV_FILE, override: false });
}
