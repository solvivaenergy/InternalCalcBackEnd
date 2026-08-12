-- Enables Row Level Security on public.app_parameters and removes the unused
-- direct-client grants.
--
-- Why: the Supabase Security Advisor flags "RLS Disabled in Public" on this
-- table. It holds sensitive internal pricing/COGS config, and the original
-- create migration (20260711_create_app_parameters.sql) granted:
--     select              -> anon, authenticated
--     insert, update      -> authenticated
-- With RLS off, that exposes the whole `payload` to anyone with the public
-- anon key (read) and lets any logged-in user overwrite pricing (write) via
-- PostgREST, bypassing the backend.
--
-- The app only ever reaches this table through the backend, which uses the
-- service_role key (bypasses RLS). So we enable RLS with NO client policies
-- and revoke the unused grants. No app code path relies on anon/authenticated
-- access to this table, so nothing breaks.

begin;

revoke insert , update on public.app_parameters from authenticated;

revoke select on public.app_parameters from anon, authenticated;

alter table public.app_parameters enable row level security;

commit;