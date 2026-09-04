-- Adds the 'finco' admin role (FinCo Admin) to the public.user_roles allowlist.
--
-- Background: upstream calculator release v3-180 separated the financing
-- entity (FinCo) from OpCo and moved its parameters behind a fifth admin role.
-- FinCo edits Financing Limits (minimum down-payment tiers, maximum tenor),
-- the whole Interest Rates section, Returns Assumptions (DU tariff inflation
-- default, IRR horizon) and the advisory DU Inflation Reference — and nothing
-- else. See src/parametersService.js (ROLE_ADMIN_SECTIONS.finco), which is the
-- server-side security boundary, and the frontend mirror in
-- src/lib/permissions.js.
--
-- ⚠ SCHEMA DRIFT — this migration handles BOTH shapes on purpose:
--   * PRODUCTION: user_roles.role is a TEXT column guarded by the CHECK
--     constraint `user_roles_role_check` (the app_role enum from the bootstrap
--     migration was never applied because the table pre-existed).
--   * STAGING:    user_roles.role is the app_role ENUM (freshly-built DB).
-- Running the wrong branch errors out, so the shape is detected first.
--
-- Roles 'rep'/'customer' intentionally stay out of this table — they are
-- carried in auth metadata instead.
--
-- NOTE: `alter type ... add value` cannot run inside an explicit transaction
-- block, so this file deliberately does NOT wrap everything in begin/commit.

-- ── Branch 1: enum-typed role column (staging) ───────────────────────────────
do $$
begin
  if exists (
    select 1
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'app_role'
  ) and not exists (
    select 1
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'app_role'
       and e.enumlabel = 'finco'
  ) then
    execute 'alter type public.app_role add value ''finco''';
  end if;
end
$$;

-- ── Branch 2: TEXT + CHECK constraint (production) ───────────────────────────
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'user_roles'
       and column_name  = 'role'
       and data_type    = 'text'
  ) then
    alter table public.user_roles
      drop constraint if exists user_roles_role_check;

    alter table public.user_roles
      add constraint user_roles_role_check check (
        role in (
          'admin',
          'engineering',
          'product',
          'inventory',
          'finco',
          'view'
        )
      );
  end if;
end
$$;
