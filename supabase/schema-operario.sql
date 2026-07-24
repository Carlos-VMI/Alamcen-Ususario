-- La app operario no usa una tabla remota separada `estados_baldas`.
-- El estado remoto de cada cubeta se persiste dentro de
-- public.almacen_articulos.sufijos, junto al sufijo/capacidad existente.

alter table public.almacen_articulos
  add column if not exists sufijos jsonb not null default '[{"sufijo":"01","capacidad":1}]'::jsonb;

-- Cada elemento de `sufijos` puede tomar esta forma:
-- {
--   "sufijo": "01",
--   "capacidad": 300,
--   "estado": "lleno",
--   "estado_updated_at": "2026-07-24T00:00:00.000Z"
-- }

notify pgrst, 'reload schema';
