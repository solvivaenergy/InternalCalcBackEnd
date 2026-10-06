# @solviva/calc-engine — the sizing and pricing engine

Everything that turns calculator inputs and admin parameters into numbers
lives here, once. Nothing in this package may import React, the DOM, Vite
(`import.meta.env`), `fetch`, storage or Supabase. That rule is what lets the
same files run in the rep's browser (the Internal Calculator) and in Node
(this backend's estimate endpoint for the website), so the two can never
disagree.

Moved here from `InternalCalcFrontEnd/src/engine` at its commit `3324a7e`
(2026-09-27), where it had been lifted out of `src/lib` and `src/data` with a
byte-identical parity check (see `parity/`).

| File | What it holds |
| --- | --- |
| `calculations.js` | Excel-mirror formulas: PMT/PV/IRR, consumption, panel recommendation, inverters, cabling, package line items, payment terms |
| `schedule.js` | Hourly curve, battery sizing, `optimizeSystem` sweep, cash flows, payment annex |
| `boq.js`, `payoff.js`, `duInflation.js` | BOQ lines, payoff chart model, DU inflation notes |
| `proposal.js` | `computeProposal(state, generatedDate)` — the whole pipeline in one call (App.jsx's model memo, lifted out) |
| `runtime.js` | `buildRuntime(defaults, overrides)` — bundled defaults + a stored `app_parameters` payload → effective parameters (legacy migrations, COGS back-fill, derived prices). `applyRuntime(rt)` writes one into the live objects. |
| `data/*.js` | Bundled defaults and catalog helpers (`ADMIN_PARAMS`, `PANEL_SETTINGS`, inverter lists, `DEVICES`) |
| `constants.js` | Constants the engine needs that the frontend's `config.js` used to own |
| `index.js` | Named exports for Node consumers; the frontend imports files by subpath |
| `parity/` | The harness that proves a change did not move a number (not shipped in the tarball) |

## Who uses it, and how

- **This backend** — a workspace package (`workspaces` in the root
  `package.json`), so `import { computeProposal } from "@solviva/calc-engine"`
  resolves to this folder with no publish step.
- **InternalCalcFrontEnd** — depends on the tarball attached to the GitHub
  Release `calc-engine-v<version>` (public repo, so `npm ci` fetches it with no
  token). The frontend runs the engine in the browser and fills the live
  objects itself (`paramsService.load()`); this backend fills them with
  `applyRuntime(buildRuntime(DEFAULTS, payload))`.
- **The website calculator** — never imports it. It calls this backend's
  estimate endpoint, which runs `computeProposal()` here.

## The live-mutation pattern

The engine functions read the catalog from the module objects exported by
`data/*.js`. `paramsService.load()` (browser) and `applyRuntime()` (Node) fill
those objects in place after fetching the stored payload, so every function
sees the live values without threading parameters through each call. A change
in the admin screens therefore reaches every quote — and the website — with no
deploy.

## Releasing a change

1. Change the code. Run `parity/` against the previous release: a refactor
   must be identical; a deliberate formula change must differ only where you
   meant it to.
2. Bump `version` in `package.json` (semver: a formula change is at least a
   minor bump).
3. Merge, then tag the commit `calc-engine-v<version>` and push the tag. The
   `calc-engine-release` workflow packs the folder and attaches the tarball to
   a GitHub Release.
4. In the frontend, point `@solviva/calc-engine` at the new tarball URL and
   `npm install`, so both runtimes ship the same version.
