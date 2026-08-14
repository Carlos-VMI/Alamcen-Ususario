-- La app operario no usa una tabla remota separada `estados_baldas`.
-- El estado remoto de cada cubeta se persiste dentro de
-- public.almacen_articulos.sufijos, junto al sufijo/capacidad existente.

alter table public.almacen_articulos
  add column if not exists sufijos jsonb not null default '[{"sufijo":"01","capacidad":1}]'::jsonb;

alter table public.almacen_bases
  add column if not exists ancho_estante_cm numeric not null default 100;

alter table public.almacen_modulos
  add column if not exists ancho_estante_cm numeric;

alter table public.almacen_estantes
  add column if not exists esp32_ip text,
  add column if not exists total_leds integer not null default 60,
  add column if not exists cajones jsonb not null default '[]'::jsonb;

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
--   "ancho_cm": 20,
--   "esp32_ip": "192.168.1.50",
--   "startLed": 0,
--   "ledCount": 12
-- }

notify pgrst, 'reload schema';
