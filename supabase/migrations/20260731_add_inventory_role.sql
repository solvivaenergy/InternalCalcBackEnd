-- Adds the 'inventory' admin role (Inventory tab only, editable) to the
-- public.user_roles allowlist.
--
-- Production note: user_roles.role is a TEXT column guarded by the CHECK
-- constraint `user_roles_role_check`, previously limited to
-- admin/engineering/product/view. (The app_role enum from the bootstrap
-- migration was never applied because the table pre-existed.) This widens the
-- constraint to include 'inventory'. Roles 'rep'/'customer' intentionally stay
-- out of the table — they are carried in auth metadata instead.

begin;

alter table public.user_roles
drop constraint if exists user_roles_role_check;

alter table public.user_roles
add constraint user_roles_role_check check (
    role in (
        'admin',
        'engineering',
        'product',
        'inventory',
        'view'
    )
);

commit;