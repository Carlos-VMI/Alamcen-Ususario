create table if not exists public.estados_baldas (
  id_balda text primary key,
  estado text not null check (estado in ('lleno', 'vacio')),
  updated_at timestamptz not null,
  synced_at timestamptz
);

alter table public.estados_baldas enable row level security;

drop policy if exists "Operarios sincronizan estados" on public.estados_baldas;

create policy "Operarios sincronizan estados"
on public.estados_baldas for all
to authenticated
using (true)
with check (true);
