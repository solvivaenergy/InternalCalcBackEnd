-- InternalCalc bootstrap for Supabase project gbwfhacvklwieqnydqzb
-- Creates the role system and the parameter blob store used by admin save/load.

begin;

-- Role enum used by public.user_roles.role
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'app_role' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.app_role AS ENUM (
      'admin',
      'engineering',
      'product',
      'view',
      'rep',
      'customer'
    );
  END IF;
END
$$;

-- One row per auth user to control app-level access.
create table if not exists public.user_roles (
    user_id uuid primary key references auth.users (id) on delete cascade,
    role public.app_role not null default 'customer',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.user_roles enable row level security;

-- Users can read their own role.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_roles'
      AND policyname = 'Users can read their own role'
  ) THEN
    CREATE POLICY "Users can read their own role"
      ON public.user_roles
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END
$$;

-- Parameters source of truth (single blob row).
create table if not exists public.app_parameters (
  id boolean primary key default true,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.app_parameters (id, payload)
values (true, '{}'::jsonb)
on conflict (id) do nothing;

-- Optional helper for SQL checks.
-- Uses text comparison so it works whether user_roles.role is app_role enum
-- or a pre-existing text column.
create or replace function public.has_role(required_role text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and lower(ur.role::text) = lower(required_role)
  );
$$;

-- Demo account role mappings.
insert into
    public.user_roles (user_id, role)
select u.id, 'admin'
from auth.users u
where
    u.email = 'admin.demo@aboitizpower.com' on conflict (user_id) do
update
set role = excluded.role,
updated_at = now();

insert into
    public.user_roles (user_id, role)
select u.id, 'rep'
from auth.users u
where
    u.email = 'sales.rep.demo@aboitizpower.com' on conflict (user_id) do
update
set role = excluded.role,
updated_at = now();

insert into
    public.user_roles (user_id, role)
select u.id, 'admin'
from auth.users u
where
    u.email = 'roald.reyes@aboitizpower.com' on conflict (user_id) do
update
set role = excluded.role,
updated_at = now();

commit;