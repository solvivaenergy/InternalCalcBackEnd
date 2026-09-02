create table if not exists public.parameter_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  actor_role text not null,
  area text not null,
  source text not null,
  occurred_at timestamptz not null default now(),
  timezone text not null default 'Asia/Manila',
  before_payload jsonb not null,
  after_payload jsonb not null,
  changes jsonb not null default '[]'::jsonb,
  applied_admin_keys text[] not null default '{}',
  ignored_admin_keys text[] not null default '{}',
  inventory_applied boolean not null default false,
  request_id uuid,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists parameter_audit_events_occurred_at_idx on public.parameter_audit_events (occurred_at desc);

create index if not exists parameter_audit_events_actor_idx on public.parameter_audit_events (
    actor_user_id,
    occurred_at desc
);

alter table public.parameter_audit_events enable row level security;

revoke all on public.parameter_audit_events from anon, authenticated;