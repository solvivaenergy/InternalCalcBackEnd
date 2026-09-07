# InternalCalcBackEnd — Handoff

## 2026-09-07 — Fix phantom derived-price entries in parameter audit history

### Scope

- `PUT /api/parameters` audit diff no longer records derived COGS→price ripples
  (`miscCatalog[x].price`, `deliveryLocations[x].fixedFee/perPanel`,
  `batteryPackages[x].*Price`, inverter `directPrice`, panel `panelDirectPrice`,
  and the 21 derived adminParams scalar prices).
- These fields are recomputed client-side from `*Cogs` inputs + the live
  `grossMarginReference` on every load/save (frontend `deriveDirectPrices`,
  v3-83). When the stored reference margin and a saving client's derivation
  margin disagreed (e.g. an Engineering/Product save after a FinCo margin
  change), the raw deep diff flagged every derived price as "changed" —
  the 20–23-field phantom events seen in staging on Sep 4–5 2026.
- Authored inputs (`*Cogs`, labels, margins, rates, row adds/removes) still
  audit under their own paths; no real change history is lost. A save whose
  only diff was a derived ripple now writes **no** audit event.
- Backward compatible: no schema change; `parameter_audit_events` rows keep
  the same shape. Existing (noisy) rows are untouched.

### Files touched

- `src/parametersService.js` — new `DERIVED_ADMIN_SCALAR_PRICES`,
  `DERIVED_AUDIT_PATH_PATTERNS`, `isDerivedAuditPath()`; `buildChanges()`
  result filtered before the `changes.length > 0` event write.

### Contract changes

- None. Request/response shape unchanged. Frontend needs no update.

### Data changes

- None. No migrations, no RLS changes, no backfill.

### Validation

- `node --check src/parametersService.js` — pass.
- Filter unit-checked against 27 paths: all 10 observed phantom paths
  (miscCatalog/deliveryLocations derived prices etc.) filtered; all 17
  authored-input paths (COGS, labels, margins, row adds, devices, panel
  watts) preserved.
- Verified against live staging `parameter_audit_events`: the Sep 4–5
  multi-area events contained only derived-price replaces + the real edit
  (e.g. `minSystemKwp`, `duRateInflationDefault`); under the new filter
  those events would show 1–4 fields each.

### Deployment notes

- Deploy backend to staging, then production. No env/config changes.
- Optional cleanup: historical phantom-heavy events remain in the table;
  delete or leave per audit-retention preference (no script shipped).
