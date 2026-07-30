begin;

-- ---------------------------------------------------------------------------
-- Role-based access control: app_role enum, user_roles table, has_role().
--
-- This is the prerequisite for the RLS policies in
-- 20260707_create_inventory_tables.sql (which reference public.has_role(...)
-- and public.app_role) and for the JWT-authed admin pipeline in
-- src/parametersService.js (which reads public.user_roles).
--
-- Fully idempotent: safe to run repeatedly in the Supabase SQL editor or via
-- `supabase db reset`. Also seeds a test user so the login flow can be
-- exercised end to end.
-- ---------------------------------------------------------------------------

-- pgcrypto provides crypt()/gen_salt() (used to hash the seed user's password)
-- and gen_random_uuid(). Supabase enables it by default; this is a no-op then.
create extension if not exists pgcrypto;

-- ── app_role enum ──────────────────────────────────────────────────────────
-- create type is not idempotent on its own, so guard it.
do $$
begin
    if not exists (
        select 1
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        where t.typname = 'app_role'
          and n.nspname = 'public'
    ) then
        create type public.app_role as enum (
            'admin',
            'engineering',
            'product',
            'view',
            'rep',
            'customer'
        );

end if;

end $$;

-- ── user_roles table ───────────────────────────────────────────────────────
-- One role per user (user_id is the primary key) — both the frontend
-- (fetchUserRole) and the backend (resolveEditRole) query with .maybeSingle(),
-- so at most one row per user is expected.
create table if not exists public.user_roles (
    user_id uuid primary key references auth.users (id) on delete cascade,
    role public.app_role not null,
    updated_at timestamptz not null default now()
);

-- ── has_role(roles[]) ──────────────────────────────────────────────────────
-- Returns true when the CURRENT authenticated user (auth.uid()) has a role in
-- the supplied array. SECURITY DEFINER so RLS policies can call it without the
-- caller needing direct select on user_roles. Signature matches the inventory
-- migration's policies: public.has_role(array['admin','engineering']::public.app_role[]).
create or replace function public.has_role(roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.user_roles ur
        where ur.user_id = auth.uid()
          and ur.role = any (roles)
    );
$$;

-- ── RLS on user_roles ──────────────────────────────────────────────────────
alter table public.user_roles enable row level security;

-- Each user may read their own role row (the frontend login flow needs this
-- via the anon/authenticated client). The service-role key used by the backend
-- bypasses RLS entirely.
drop policy if exists user_roles_read_own on public.user_roles;

create policy user_roles_read_own on public.user_roles for
select to authenticated using (auth.uid () = user_id);

-- Admins may read every role row (e.g. a future user-management screen).
drop policy if exists user_roles_read_admin on public.user_roles;

create policy user_roles_read_admin on public.user_roles for
select to authenticated using (
    public.has_role(array['admin']::public.app_role[])
);

-- Only admins may assign or change roles.
drop policy if exists user_roles_write_admin on public.user_roles;

create policy user_roles_write_admin on public.user_roles for all to authenticated using (
    public.has_role(array['admin']::public.app_role[])
)
with
    check (
        public.has_role(array['admin']::public.app_role[])
    );

grant select on public.user_roles to authenticated;

-- ── Seed test user ─────────────────────────────────────────────────────────
-- Creates test@solvivaenergy.com (password: $olviva@2026) in auth.users with a
-- confirmed email + matching identity, then assigns the 'admin' role so the
-- full admin pipeline can be exercised. Idempotent: the user is only inserted
-- when absent, and the role is upserted. Change 'admin' below to test other
-- routes (rep, product, engineering, view, customer).
do $$
declare
    v_user_id uuid;
begin
    select id into v_user_id
    from auth.users
    where email = 'test@solvivaenergy.com';

    if v_user_id is null then
        v_user_id := gen_random_uuid();

        insert into auth.users (
            instance_id,
            id,
            aud,
            role,
            email,
            encrypted_password,
            email_confirmed_at,
            created_at,
            updated_at,
            raw_app_meta_data,
            raw_user_meta_data,
            confirmation_token,
            recovery_token,
            email_change_token_new,
            email_change
        )
        values (
            '00000000-0000-0000-0000-000000000000',
            v_user_id,
            'authenticated',
            'authenticated',
            'test@solvivaenergy.com',
            crypt('$olviva@2026', gen_salt('bf')),
            now(),
            now(),
            now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{}'::jsonb,
            '',
            '',
            '',
            ''
        );

        -- Matching identity row (required for email/password sign-in). The
        -- provider_id column is present on modern Supabase; identity_data must
        -- carry sub + email.
        insert into auth.identities (
            id,
            user_id,
            provider_id,
            identity_data,
            provider,
            last_sign_in_at,
            created_at,
            updated_at
        )
        values (
            gen_random_uuid(),
            v_user_id,
            v_user_id::text,
            json_build_object(
                'sub', v_user_id::text,
                'email', 'test@solvivaenergy.com',
                'email_verified', true
            )::jsonb,
            'email',
            now(),
            now(),
            now()
        );
    end if;

    insert into public.user_roles (user_id, role)
    values (v_user_id, 'admin')
    on conflict (user_id) do update
    set role = excluded.role,
        updated_at = now();
end
$$;

commit;