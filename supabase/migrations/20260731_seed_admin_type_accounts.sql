begin;

-- ---------------------------------------------------------------------------
-- Seed the two non-Management admin "type" demo accounts (v3-143).
--
-- The app now has three admin access types, mapped onto the existing roles:
--   • Management       → DB role 'admin'        (all tabs)   — existing accounts
--   • Engineering      → DB role 'engineering'  (Inventory + Engineering tabs)
--   • Consumer Finance → DB role 'product'      (Product tab)
--
-- The two existing 'admin' users (admin.demo@aboitizpower.com and
-- roald.reyes@aboitizpower.com) are already Management — no change needed.
--
-- This migration provisions ONE demo login for each of the other two types so
-- the tab-gating can be exercised end to end. Fully idempotent: each auth user
-- is only inserted when absent, and the role is upserted every run.
--
-- SECURITY: these are shared demo credentials committed to source control.
-- Rotate the passwords (or disable the accounts) before any production use.
-- ---------------------------------------------------------------------------

-- crypt()/gen_salt() for the seed passwords, gen_random_uuid() for ids.
-- Supabase enables pgcrypto by default; this is a no-op then.
create extension if not exists pgcrypto;

-- ── Engineering demo — engineering.demo@aboitizpower.com ────────────────────
do $$
declare
    v_user_id uuid;
begin
    select id into v_user_id
    from auth.users
    where email = 'engineering.demo@aboitizpower.com';

    if v_user_id is null then
        v_user_id := gen_random_uuid();

        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password,
            email_confirmed_at, created_at, updated_at,
            raw_app_meta_data, raw_user_meta_data,
            confirmation_token, recovery_token, email_change_token_new, email_change
        )
        values (
            '00000000-0000-0000-0000-000000000000',
            v_user_id,
            'authenticated',
            'authenticated',
            'engineering.demo@aboitizpower.com',
            crypt('Engr#Solviva2026', gen_salt('bf')),
            now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{}'::jsonb,
            '', '', '', ''
        );

        insert into auth.identities (
            id, user_id, provider_id, identity_data, provider,
            last_sign_in_at, created_at, updated_at
        )
        values (
            gen_random_uuid(),
            v_user_id,
            v_user_id::text,
            json_build_object(
                'sub', v_user_id::text,
                'email', 'engineering.demo@aboitizpower.com',
                'email_verified', true
            )::jsonb,
            'email',
            now(), now(), now()
        );
    end if;

    insert into public.user_roles (user_id, role)
    values (v_user_id, 'engineering')
    on conflict (user_id) do update
    set role = excluded.role,
        updated_at = now();
end
$$;

-- ── Consumer Finance demo — consumerfinance.demo@aboitizpower.com ───────────
do $$
declare
    v_user_id uuid;
begin
    select id into v_user_id
    from auth.users
    where email = 'consumerfinance.demo@aboitizpower.com';

    if v_user_id is null then
        v_user_id := gen_random_uuid();

        insert into auth.users (
            instance_id, id, aud, role, email, encrypted_password,
            email_confirmed_at, created_at, updated_at,
            raw_app_meta_data, raw_user_meta_data,
            confirmation_token, recovery_token, email_change_token_new, email_change
        )
        values (
            '00000000-0000-0000-0000-000000000000',
            v_user_id,
            'authenticated',
            'authenticated',
            'consumerfinance.demo@aboitizpower.com',
            crypt('Finance#Solviva2026', gen_salt('bf')),
            now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{}'::jsonb,
            '', '', '', ''
        );

        insert into auth.identities (
            id, user_id, provider_id, identity_data, provider,
            last_sign_in_at, created_at, updated_at
        )
        values (
            gen_random_uuid(),
            v_user_id,
            v_user_id::text,
            json_build_object(
                'sub', v_user_id::text,
                'email', 'consumerfinance.demo@aboitizpower.com',
                'email_verified', true
            )::jsonb,
            'email',
            now(), now(), now()
        );
    end if;

    insert into public.user_roles (user_id, role)
    values (v_user_id, 'product')
    on conflict (user_id) do update
    set role = excluded.role,
        updated_at = now();
end
$$;

-- ── Re-affirm the two Management accounts (existing 'admin' users) ──────────
-- No-op if they already carry 'admin'; here for documentation + safety.
insert into public.user_roles (user_id, role)
select u.id, 'admin'
from auth.users u
where u.email in ('admin.demo@aboitizpower.com', 'roald.reyes@aboitizpower.com')
on conflict (user_id) do update
set role = excluded.role,
    updated_at = now();

commit;