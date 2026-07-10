begin;

create table if not exists public.app_parameters (
  id boolean primary key default true check (id),
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.app_parameters (id, payload)
values (true, '{}'::jsonb)
on conflict (id) do nothing;

grant select on public.app_parameters to anon, authenticated;

grant insert , update on public.app_parameters to authenticated;

commit;