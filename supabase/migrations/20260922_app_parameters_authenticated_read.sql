-- Lets a SIGNED-IN user read the single public.app_parameters row directly
-- through PostgREST. Apply to BOTH Supabase projects (staging and production).
--
-- Why: the calculator loads this row on boot through the backend's public
-- GET /api/parameters. When that one request fails in a user's browser — seen
-- repeatedly in Sept 2026 for a rep whose managed Chrome could reach
-- supabase.co but not the backend's onrender.com host — the app silently fell
-- back to the BUNDLED defaults: maintenance gate on, 10/15/20% down-payment
-- floors, stale margins. The frontend (src/lib/paramsService.js) now falls
-- back to reading this row with the user's own session, which needs a read
-- policy. 20260812_app_parameters_enable_rls.sql revoked all client access on
-- the grounds that "no app code path relies on anon/authenticated access";
-- that is no longer true for `authenticated`.
--
-- Exposure: none new. GET /api/parameters already returns this exact payload
-- to anyone, unauthenticated, with CORS '*'. This policy is narrower — it
-- requires a Supabase session — and grants no write access: the backend's
-- service-role PUT remains the only write path, and its role allowlist still
-- applies. `anon` deliberately stays revoked.

begin;

grant select on public.app_parameters to authenticated;

drop policy if exists "Signed-in users can read app parameters"
  on public.app_parameters;

create policy "Signed-in users can read app parameters"
  on public.app_parameters
  for select
  to authenticated
  using (true);

commit;
