begin;

-- ---------------------------------------------------------------------------
-- Inventory / device tables required by the Render backend quote service.
-- These tables mirror the source defaults from src/data/devices.js and
-- src/data/inventory.js in the calculator repo.
-- ---------------------------------------------------------------------------

create table if not exists public.device_settings (
  id boolean primary key default true check (id),
  day_start_hour integer not null default 6 check (day_start_hour between 0 and 23),
  updated_at timestamptz not null default now()
);

create table if not exists public.devices (
  id bigserial primary key,
  name text not null unique,
  peak_kw numeric(8,3) not null,
  duty_factor numeric(8,3) not null,
  sort_order integer not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.panel_settings (
  phase text primary key check (phase in ('single', 'three')),
  panel_watts integer not null,
  panel_direct_price integer not null,
  max_dc_ac_ratio numeric(8,3) not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.inverters (
  id bigserial primary key,
  phase text not null check (phase in ('single', 'three')),
  rated_kw numeric(8,3) not null,
  direct_price integer not null,
  sort_order integer not null,
  updated_at timestamptz not null default now(),
  unique (phase, rated_kw)
);

-- Seed the single-row settings table.
insert into public.device_settings (id, day_start_hour)
values (true, 6)
on conflict (id) do update set
  day_start_hour = excluded.day_start_hour,
  updated_at = now();

-- Seed device library.
insert into public.devices (name, peak_kw, duty_factor, sort_order) values
('1.0hp AC',             1.000, 0.5,  1),
('1.5hp AC',             1.300, 0.5,  2),
('2.0hp AC',             1.800, 0.5,  3),
('2.5hp AC',             2.000, 0.5,  4),
('3.0hp AC',             2.800, 0.5,  5),
('Microwave/Toaster',    1.000, 1.0,  6),
('6" Stove Burner',      1.500, 0.9,  7),
('8" Stove Burner',      2.500, 0.9,  8),
('Electric Oven',        3.000, 0.8,  9),
('Level-1 EV Charger',   1.500, 0.9, 10),
('Level-2 EV Charger',   9.600, 0.9, 11),
('Washing Machine',      0.800, 0.7, 12),
('Elec Clothes Dryer',   5.000, 0.8, 13),
('1kW Motor Load',       1.000, 0.7, 14),
('5kW Heating Element',  5.000, 0.8, 15),
('20W Lighting Element', 0.020, 1.0, 16)
on conflict (name) do update set
  peak_kw = excluded.peak_kw,
  duty_factor = excluded.duty_factor,
  sort_order = excluded.sort_order,
  updated_at = now();

-- Seed panel settings.
insert into public.panel_settings (phase, panel_watts, panel_direct_price, max_dc_ac_ratio) values
('single', 630, 8600, 1.3),
('three',  650, 9000, 1.6)
on conflict (phase) do update set
  panel_watts = excluded.panel_watts,
  panel_direct_price = excluded.panel_direct_price,
  max_dc_ac_ratio = excluded.max_dc_ac_ratio,
  updated_at = now();

-- Seed inverter catalog.
insert into public.inverters (phase, rated_kw, direct_price, sort_order) values
('single',  5.000,  58384, 1),
('single',  6.000,  65967, 2),
('single',  8.000,  87197, 3),
('single', 12.000, 122076, 4),
('single', 16.000, 166054, 5),
('three',   5.000,  67142, 1),
('three',  10.000, 125346, 2),
('three',  16.000, 190962, 3),
('three',  20.000, 214832, 4),
('three',  30.000, 322249, 5),
('three',  50.000, 537081, 6)
on conflict (phase, rated_kw) do update set
  direct_price = excluded.direct_price,
  sort_order = excluded.sort_order,
  updated_at = now();

-- Helpful indexes for lookup and ordering.
create index if not exists devices_sort_order_idx on public.devices (sort_order);
create index if not exists inverters_phase_sort_order_idx on public.inverters (phase, sort_order);

-- RLS: public read, authenticated admin/engineering update.
alter table public.device_settings enable row level security;
alter table public.devices enable row level security;
alter table public.panel_settings enable row level security;
alter table public.inverters enable row level security;

drop policy if exists device_settings_read_all on public.device_settings;
create policy device_settings_read_all on public.device_settings for select using (true);

drop policy if exists devices_read_all on public.devices;
create policy devices_read_all on public.devices for select using (true);

drop policy if exists panel_settings_read_all on public.panel_settings;
create policy panel_settings_read_all on public.panel_settings for select using (true);

drop policy if exists inverters_read_all on public.inverters;
create policy inverters_read_all on public.inverters for select using (true);

drop policy if exists device_settings_update_admin_engineering on public.device_settings;
create policy device_settings_update_admin_engineering
on public.device_settings for update to authenticated
using (public.has_role(array['admin','engineering']::public.app_role[]))
with check (public.has_role(array['admin','engineering']::public.app_role[]));

drop policy if exists devices_update_admin_engineering on public.devices;
create policy devices_update_admin_engineering
on public.devices for update to authenticated
using (public.has_role(array['admin','engineering']::public.app_role[]))
with check (public.has_role(array['admin','engineering']::public.app_role[]));

drop policy if exists panel_settings_update_admin_engineering on public.panel_settings;
create policy panel_settings_update_admin_engineering
on public.panel_settings for update to authenticated
using (public.has_role(array['admin','engineering']::public.app_role[]))
with check (public.has_role(array['admin','engineering']::public.app_role[]));

drop policy if exists inverters_update_admin_engineering on public.inverters;
create policy inverters_update_admin_engineering
on public.inverters for update to authenticated
using (public.has_role(array['admin','engineering']::public.app_role[]))
with check (public.has_role(array['admin','engineering']::public.app_role[]));

grant select on public.device_settings, public.devices, public.panel_settings, public.inverters to anon, authenticated;
grant update on public.device_settings, public.devices, public.panel_settings, public.inverters to authenticated;

commit;