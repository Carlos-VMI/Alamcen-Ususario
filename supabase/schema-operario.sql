create table if not exists public.estanterias_config (
  id text primary key,
  almacen_id uuid not null,
  modulo text not null,
  estante integer not null check (estante between 1 and 8),
  posicion integer not null check (posicion between 1 and 8),
  articulo_id uuid,
  sku text,
  descripcion text,
  capacidad integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.estados_baldas (
  id_balda text primary key references public.estanterias_config(id) on delete cascade,
  estado text not null check (estado in ('lleno', 'vacio')),
  updated_at timestamptz not null,
  synced_at timestamptz
);

alter table public.estanterias_config enable row level security;
alter table public.estados_baldas enable row level security;

drop policy if exists "Operarios leen configuracion" on public.estanterias_config;
drop policy if exists "Operarios sincronizan estados" on public.estados_baldas;

create policy "Operarios leen configuracion"
on public.estanterias_config for select
to authenticated
using (true);

create policy "Operarios sincronizan estados"
on public.estados_baldas for all
to authenticated
using (true)
with check (true);
