// The package's front door. Consumers may also import any file by subpath
// (`@solviva/calc-engine/calculations.js`), which is what the Internal
// Calculator frontend does; the backend uses these named exports.
export { computeProposal, deriveInstallDate } from "./proposal.js";
export { DEFAULTS, buildRuntime, applyRuntime } from "./runtime.js";
export { ADMIN_PARAMS } from "./data/adminParams.js";
export {
  PANEL_SETTINGS,
  INVERTERS_SINGLE_PHASE,
  INVERTERS_THREE_PHASE,
} from "./data/inventory.js";
export { DEVICES } from "./data/devices.js";
export * as calculations from "./calculations.js";
export * as schedule from "./schedule.js";
export * as boq from "./boq.js";
export * as payoff from "./payoff.js";
export * as duInflation from "./duInflation.js";
