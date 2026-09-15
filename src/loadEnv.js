// =============================================================================
// ENV LOADING — must be the FIRST import in server.js
// -----------------------------------------------------------------------------
// Loads .env relative to THIS REPO, not to process.cwd().
//
// The bare `import "dotenv/config"` this replaces resolved .env against the
// current working directory. That is correct for `npm start` / `npm run dev`
// inside this repo, but the FRONTEND's dev script launches the backend as
//     concurrently -k "node ../InternalCalcBackEnd/dev-server.js" "vite"
// from the frontend directory — so cwd was InternalCalcFrontEnd, which has no
// .env (its .env.local belongs to Vite). dotenv found nothing, silently, and
// every credential read as undefined.
//
// It went unnoticed because dev-server.js sets PARAMETERS_STORAGE=local-json,
// so the only route that needed secrets locally read a JSON file instead. The
// first route to actually need a credential in local dev (/api/crm-contact)
// failed with "Auth is not configured" and a lookup that never reached Odoo.
//
// Kept as its own module rather than inline in server.js because ES module
// imports are hoisted: anything reading process.env at module-evaluation time
// in a sibling import would otherwise run BEFORE a dotenv.config() call placed
// in server.js's body.
// =============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// override:false keeps real environment variables (Render, CI, a shell export)
// authoritative over anything in a local .env file.
dotenv.config({ path: path.join(repoRoot, ".env"), override: false });
