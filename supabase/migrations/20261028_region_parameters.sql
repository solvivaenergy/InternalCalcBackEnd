-- Region-aware parameters (v3-231, 2026-10-28).
--
-- One calculator, one parameter payload PER REGION: public.region_parameters
-- holds a row per region ('luzon' = Manila, today's behaviour; 'cebu' = the
-- new office), each with the same payload shape app_parameters has always
-- held ({ adminParams, panelSettings, invertersSinglePhase,
-- invertersThreePhase, devices }). The backend (src/parametersService.js)
-- reads and writes this table by region; the legacy one-row app_parameters
-- is left exactly as it is and the backend MIRRORS every Luzon save into it,
-- because the frontend's direct-read fallback and the mcp/ connector still
-- read it (follow-up: point both at region_parameters, then drop the mirror).
--
-- Apply to STAGING (xifuuxtsdyajcbyksjxx) first; production and testing later
-- with this same file. Idempotent: safe to re-run; never overwrites a row that
-- already exists (an edited Cebu row survives a re-application). Works on both
-- live shapes of app_parameters (staging has CHECK (id), production does not)
-- because it only READS that table.
--
-- Rollback (manual, at the bottom).

begin;

-- 1. The table. No CHECK on `region`: the allowlist lives in src/regions.js
--    and a new region is one INSERT + one constant, not a migration.
create table if not exists public.region_parameters (
  region     text primary key,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2. Seed. Luzon = an exact copy of the live app_parameters row (payload AND
--    updated_at). Cebu = the same payload with the region-specific overrides
--    the engine (calc-engine 1.3.0) understands: its own label, NO delivery
--    hub yet (every Cebu delivery prices ₱0, no km surcharge, and the
--    Logistics T&C clause is dropped), no off-island delivery rows, no Odoo
--    company yet, and the Visayan utility named as the inflation source. The
--    inflation FIGURES (dates/rates/basis) stay Meralco's until FinCo supplies
--    VECO's — recorded in HANDOFF.md. Keep this object in step with
--    CEBU_ADMIN_OVERRIDES in scripts/seed-region-parameters.mjs.
with src as (
  select coalesce((select payload    from public.app_parameters where id = true), '{}'::jsonb) as payload,
         coalesce((select updated_at from public.app_parameters where id = true), now())      as updated_at
)
insert into public.region_parameters (region, payload, updated_at)
select 'luzon', payload, updated_at from src
on conflict (region) do nothing;

with src as (
  select coalesce((select payload from public.app_parameters where id = true), '{}'::jsonb) as payload
)
insert into public.region_parameters (region, payload)
select 'cebu',
       jsonb_set(
         payload,
         '{adminParams}',
         coalesce(payload->'adminParams', '{}'::jsonb) || jsonb_build_object(
           'deliveryRegionLabel',   'Cebu',
           'deliveryHubLabel',      '',
           'deliveryHubEnabled',    false,
           'deliveryLocations',     '[]'::jsonb,
           'odooCompanyId',         null,
           'duInflationSourceName', 'Visayan Electric (VECO) Rates',
           'duInflationSourceUrl',  'https://www.visayanelectric.com/'
         ),
         true
       )
from src
on conflict (region) do nothing;

-- 3. Audit events carry the region they were made in. Existing rows are all
--    Luzon's (the only region that existed).
alter table public.parameter_audit_events
  add column if not exists region text not null default 'luzon';

create index if not exists parameter_audit_events_region_occurred_at_idx
  on public.parameter_audit_events (region, occurred_at desc);

-- 4. Access. Same posture as app_parameters after 20260812 + 20260922 (RLS
--    on, no anon access, signed-in users may READ, only the service role
--    writes) — but scoped: a signed-in user sees only the regions their JWT's
--    app_metadata.regions lists, and an account without the claim is a
--    Manila account, the same rule src/regions.js applies on the API path.
alter table public.region_parameters enable row level security;

revoke all on public.region_parameters from anon, authenticated;
grant select on public.region_parameters to authenticated;

drop policy if exists "Signed-in users can read their regions' parameters" on public.region_parameters;
create policy "Signed-in users can read their regions' parameters"
  on public.region_parameters
  for select
  to authenticated
  using (
    region in (
      select jsonb_array_elements_text(
        case
          when jsonb_typeof(auth.jwt() -> 'app_metadata' -> 'regions') = 'array'
            then auth.jwt() -> 'app_metadata' -> 'regions'
          else '["luzon"]'::jsonb
        end
      )
    )
  );

-- 5. The read-only connector role (20261014) — its default privileges cover
--    tables created by `postgres`, but say so explicitly in case this runs as
--    another role. Guarded: testing/production may not have the role yet.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'db_mcp_ro') then
    grant select on public.region_parameters to db_mcp_ro;
  end if;
end $$;

commit;

-- Rollback (manual):
--   drop index if exists public.parameter_audit_events_region_occurred_at_idx;
--   alter table public.parameter_audit_events drop column if exists region;
--   drop table if exists public.region_parameters;
-- app_parameters was never touched, so the previous backend keeps working
-- (and Luzon edits made in between were mirrored into it).
