// Engine-wide constants that used to live in src/config.js. They sit here so
// the engine has no import that reads import.meta.env (config.js does), which
// is what lets these files run in Node as well as in the browser.
// config.js re-exports them, so UI code keeps importing from there.

// Cable meters bundled into every package at no charge; only meters beyond
// these are billed (calculations.js cabling block).
export const INCLUDED_DC_CABLE_METERS = 30;
export const INCLUDED_AC_CABLE_METERS = 10;
