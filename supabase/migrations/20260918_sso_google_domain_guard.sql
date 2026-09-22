begin;

-- ---------------------------------------------------------------------------
-- v3-214 — Google Workspace SSO: server-side domain guard.
--
-- The calculator now offers "Sign in with Google". Google returns a verified
-- email, and Supabase links that identity to an EXISTING auth.users row when
-- the email matches — so current password accounts keep their user_id, their
-- app_metadata.role and their user_roles row. That path never inserts into
-- auth.users and is untouched by this file.
--
-- What this file governs is the OTHER path: a Google account that does NOT
-- already exist here. Without a guard, any Google user on earth could sign in
-- and receive a fresh auth.users row (and, via fetchUserRole's default, the
-- 'customer' role — i.e. the customer calculator). The `hd` parameter the
-- frontend sends is only a hint to Google's account chooser, not a control.
-- This trigger is the control: a Google sign-UP whose email domain is not on
-- the allow-list is refused before the row exists.
--
-- Scoped to provider = 'google' on purpose. Email/password accounts are
-- created by the seed scripts (scripts/seed-*.mjs) for BOTH solvivaenergy.com
-- and aboitizpower.com staff; an unscoped domain rule would break seeding the
-- seven aboitizpower.com users. Those users are not on Google Workspace and
-- keep password login.
--
-- To the client, a RAISE inside an auth.users trigger surfaces as the generic
-- "Database error saving new user" — Login.jsx recognises that and shows the
-- domain message instead.
--
-- Idempotent: safe to re-run in the Supabase SQL editor.
-- Apply on: staging AND production (both point at the same auth schema shape).
-- ---------------------------------------------------------------------------

create or replace function public.sso_google_domain_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    -- Keep in step with SSO_ALLOWED_DOMAINS in the frontend's
    -- src/lib/supabaseClient.js. The frontend copy is UX only; this is the rule.
    allowed constant text[] := array['solvivaenergy.com'];
    v_provider text := coalesce(new.raw_app_meta_data->>'provider', '');
    v_domain   text := lower(split_part(coalesce(new.email, ''), '@', 2));
begin
    if v_provider = 'google' and not (v_domain = any (allowed)) then
        raise exception using
            errcode = 'P0001',
            message = format(
                'Sign in with Google is limited to Solviva Energy accounts; %s is not allowed.',
                v_domain);
    end if;
    return new;
end;
$$;

drop trigger if exists sso_google_domain_guard on auth.users;

create trigger sso_google_domain_guard
    before insert on auth.users
    for each row
    execute function public.sso_google_domain_guard();

-- ---------------------------------------------------------------------------
-- OPTIONAL — NOT APPLIED. Auto-onboard new Google users as reps.
--
-- As shipped, a first-time Google user who passes the domain guard has no
-- app_metadata.role and no user_roles row, so fetchUserRole gives them
-- 'customer' until someone runs a seed script — exactly today's onboarding
-- policy, just with a second way to sign in. That is the safe default and is
-- what the frontend was built against.
--
-- If the business decides every @solvivaenergy.com Google sign-in should
-- start as a sales rep with no manual step, uncomment the block below. It sets
-- app_metadata.role = 'rep', which is what fetchUserRole reads first and what
-- the seed scripts set for reps. It deliberately does NOT write user_roles:
-- that table's CHECK constraint has no 'rep' value (the seeds write 'view'
-- there), and elevated roles (admin/product/engineering/inventory/finco) must
-- stay a manual, audited assignment.
--
-- create or replace function public.sso_google_default_rep()
-- returns trigger
-- language plpgsql
-- set search_path = public
-- as $$
-- begin
--     if coalesce(new.raw_app_meta_data->>'provider','') = 'google'
--        and coalesce(new.raw_app_meta_data->>'role','') = '' then
--         new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb)
--                                  || jsonb_build_object('role', 'rep');
--     end if;
--     return new;
-- end;
-- $$;
--
-- drop trigger if exists sso_google_default_rep on auth.users;
-- create trigger sso_google_default_rep
--     before insert on auth.users
--     for each row
--     execute function public.sso_google_default_rep();
-- ---------------------------------------------------------------------------

commit;
