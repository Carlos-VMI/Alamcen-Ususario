create extension if not exists pgcrypto;

create table if not exists public.estados_baldas (
  id uuid primary key default gen_random_uuid(),
  id_balda text not null unique,
  almacen_id uuid,
  modulo_id uuid,
  estante_id uuid,
  estado text not null default 'lleno',
  updated_at timestamptz not null default now(),
  synced_at timestamptz
);

alter table public.estados_baldas
  drop constraint if exists estados_baldas_estado_check;

alter table public.estados_baldas
  add constraint estados_baldas_estado_check
  check (estado in ('lleno', 'vacio', 'pedido'));

create index if not exists estados_baldas_updated_at_idx
  on public.estados_baldas (updated_at);

create index if not exists estados_baldas_almacen_id_idx
  on public.estados_baldas (almacen_id);

grant select, insert, update, delete on public.estados_baldas to anon;
grant select, insert, update, delete on public.estados_baldas to authenticated;

alter table public.estados_baldas enable row level security;

drop policy if exists "Operarios leen estados" on public.estados_baldas;
drop policy if exists "Operarios insertan estados" on public.estados_baldas;
drop policy if exists "Operarios actualizan estados" on public.estados_baldas;
drop policy if exists "Operarios borran estados" on public.estados_baldas;
drop policy if exists "Operarios sincronizan estados" on public.estados_baldas;

create policy "Operarios leen estados"
on public.estados_baldas for select
to anon, authenticated
using (true);

create policy "Operarios insertan estados"
on public.estados_baldas for insert
to anon, authenticated
with check (true);

create policy "Operarios actualizan estados"
on public.estados_baldas for update
to anon, authenticated
using (true)
with check (true);

create policy "Operarios borran estados"
on public.estados_baldas for delete
to anon, authenticated
using (true);

notify pgrst, 'reload schema';
