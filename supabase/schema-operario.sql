-- La app operario no usa una tabla remota separada `estados_baldas`.
-- El estado remoto de cada cubeta se persiste dentro de
-- public.almacen_articulos.sufijos, junto al sufijo/capacidad existente.

alter table public.almacen_articulos
  add column if not exists sufijos jsonb not null default '[{"sufijo":"01","capacidad":1}]'::jsonb;

alter table public.almacen_bases
  add column if not exists ancho_estante_cm numeric not null default 100;

alter table public.almacen_modulos
  add column if not exists ancho_estante_cm numeric,
  add column if not exists controlador_id uuid,
  add column if not exists canal_led integer not null default 1;

alter table public.almacen_estantes
  add column if not exists esp32_ip text,
  add column if not exists total_leds integer not null default 60,
  add column if not exists cajones jsonb not null default '[]'::jsonb;

create table if not exists public.almacen_iot_controladores (
  id uuid primary key default gen_random_uuid(),
  almacen_id uuid not null references public.almacen_bases(id) on delete cascade,
  nombre text not null,
  ip text not null,
  tipo_tira text not null default 'WS2812B',
  leds_por_metro integer not null default 60,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.almacen_cubetas_catalogo (
  id uuid primary key default gen_random_uuid(),
  almacen_id uuid not null references public.almacen_bases(id) on delete cascade,
  codigo text not null,
  nombre text not null,
  ancho_cm numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.almacen_configuracion (
  id uuid primary key default gen_random_uuid(),
  almacen_id uuid not null references public.almacen_bases(id) on delete cascade,
  notificacion_reposicion_email text,
  enviar_reporte_orden boolean not null default true,
  enviar_resumen_diario boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.almacen_notificacion_emails (
  id uuid primary key default gen_random_uuid(),
  almacen_id uuid not null references public.almacen_bases(id) on delete cascade,
  categoria text not null default 'reposicion',
  email text not null,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.almacen_notificacion_emails
  add column if not exists categoria text not null default 'reposicion',
  add column if not exists activo boolean not null default true;

-- Cada elemento de `sufijos` puede tomar esta forma:
-- {
--   "sufijo": "01",
--   "capacidad": 300,
--   "estado": "lleno",
--   "estado_updated_at": "2026-07-24T00:00:00.000Z"
-- }

-- Cada elemento de `almacen_estantes.cajones` queda calculado por la app
-- de administracion:
-- {
--   "posicion": 1,
--   "etiqueta": "C1",
--   "cubeta_id": "uuid-catalogo",
--   "cubeta_codigo": "C1",
--   "ancho_cm": 20,
--   "controlador_id": "uuid-controlador",
--   "esp32_ip": "192.168.1.50",
--   "canal": 1,
--   "startLed": 0,
--   "ledCount": 12
-- }

alter table public.almacen_bases enable row level security;
alter table public.almacen_articulos enable row level security;
alter table public.almacen_operadores enable row level security;
alter table public.almacen_configuracion enable row level security;
alter table public.almacen_notificacion_emails enable row level security;
alter table public.almacen_modulos enable row level security;
alter table public.almacen_estantes enable row level security;

drop policy if exists "Lectura publica operario bases" on public.almacen_bases;
drop policy if exists "Lectura publica operario articulos" on public.almacen_articulos;
drop policy if exists "Actualizacion publica operario estados articulos" on public.almacen_articulos;
drop policy if exists "Lectura publica operario operadores activos" on public.almacen_operadores;
drop policy if exists "Lectura publica operario configuracion" on public.almacen_configuracion;
drop policy if exists "Lectura publica de emails activos de reposicion" on public.almacen_notificacion_emails;
drop policy if exists "Lectura publica operario modulos" on public.almacen_modulos;
drop policy if exists "Lectura publica operario estantes" on public.almacen_estantes;

create policy "Lectura publica operario bases"
on public.almacen_bases for select
to anon
using (true);

create policy "Lectura publica operario articulos"
on public.almacen_articulos for select
to anon
using (true);

create policy "Actualizacion publica operario estados articulos"
on public.almacen_articulos for update
to anon
using (true)
with check (true);

create policy "Lectura publica operario operadores activos"
on public.almacen_operadores for select
to anon
using (activo = true);

create policy "Lectura publica operario configuracion"
on public.almacen_configuracion for select
to anon
using (true);

create policy "Lectura publica de emails activos de reposicion"
on public.almacen_notificacion_emails for select
to anon
using (categoria = 'reposicion' and activo = true);

create policy "Lectura publica operario modulos"
on public.almacen_modulos for select
to anon
using (true);

create policy "Lectura publica operario estantes"
on public.almacen_estantes for select
to anon
using (true);

grant select on public.almacen_bases to anon;
grant select on public.almacen_articulos to anon;
grant update (sufijos, updated_at) on public.almacen_articulos to anon;
grant select on public.almacen_operadores to anon;
grant select on public.almacen_configuracion to anon;
grant select (id, almacen_id, categoria, email, activo, created_at, updated_at) on public.almacen_notificacion_emails to anon;
grant select on public.almacen_modulos to anon;
grant select on public.almacen_estantes to anon;

notify pgrst, 'reload schema';
