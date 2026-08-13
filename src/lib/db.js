import Dexie from 'dexie';

export const db = new Dexie('almacen_operario');

db.version(1).stores({
  estanterias_config: 'id, almacen_id, modulo, estante, posicion, articulo_id, sku, updated_at',
  estados_baldas: 'id_balda, estado, updated_at, synced_at',
  cola_sincronizacion: '++id, tipo, entity_id, created_at, attempts'
});

db.version(2).stores({
  estanterias_config: 'id, almacen_id, modulo, estante, posicion, articulo_id, sku, updated_at',
  estados_baldas: 'id_balda, estado, updated_at, synced_at',
  cola_sincronizacion: '++id, tipo, entity_id, created_at, attempts',
  almacen_modulos: 'id, almacen_id, orden, updated_at',
  almacen_estantes: 'id, modulo_id, numero, updated_at',
  almacen_articulos: 'id, almacen_id, sku, updated_at',
  sync_metadata: 'key'
});

db.version(3).stores({
  estanterias_config: 'id, almacen_id, modulo, estante, posicion, articulo_id, sku, updated_at',
  estados_baldas: 'id_balda, estado, updated_at, synced_at',
  cola_sincronizacion: '++id, tipo, entity_id, created_at, attempts',
  almacen_modulos: 'id, almacen_id, orden, updated_at',
  almacen_estantes: 'id, modulo_id, numero, updated_at',
  almacen_articulos: 'id, almacen_id, sku, updated_at',
  sync_metadata: 'key',
  led_mappings: 'id, almacen_id, esp32Ip, id_balda'
});

async function enqueueStateChange(idBalda, estado, updatedAt) {
  const existing = await db.cola_sincronizacion
    .where('entity_id')
    .equals(idBalda)
    .and((item) => item.tipo === 'estado_balda.updated')
    .first();

  const payload = {
    id_balda: idBalda,
    estado,
    updated_at: updatedAt
  };

  if (existing) {
    await db.cola_sincronizacion.update(existing.id, {
      payload,
      attempts: 0,
      created_at: updatedAt,
      last_error: null
    });
    return;
  }

  await db.cola_sincronizacion.add({
    tipo: 'estado_balda.updated',
    entity_id: idBalda,
    payload,
    attempts: 0,
    created_at: updatedAt,
    last_error: null
  });
}

export async function upsertShelfState(idBalda, estado) {
  const now = new Date().toISOString();
  await db.transaction('rw', db.estados_baldas, db.cola_sincronizacion, async () => {
    await db.estados_baldas.put({
      id_balda: idBalda,
      estado,
      updated_at: now,
      synced_at: null
    });

    await enqueueStateChange(idBalda, estado, now);
  });
}

export async function upsertShelfStates(items) {
  if (!items.length) return;

  const now = new Date().toISOString();
  await db.transaction('rw', db.estados_baldas, db.cola_sincronizacion, async () => {
    await db.estados_baldas.bulkPut(
      items.map(({ id_balda, estado }) => ({
        id_balda,
        estado,
        updated_at: now,
        synced_at: null
      }))
    );

    for (const { id_balda, estado } of items) {
      await enqueueStateChange(id_balda, estado, now);
    }
  });
}

export async function replaceShelfConfig(configRows) {
  await db.transaction('rw', db.estanterias_config, async () => {
    await db.estanterias_config.clear();
    await db.estanterias_config.bulkPut(configRows);
  });
}

export async function replaceRawConfig({ modules, shelves, articles }) {
  await db.transaction('rw', db.almacen_modulos, db.almacen_estantes, db.almacen_articulos, async () => {
    await db.almacen_modulos.clear();
    await db.almacen_estantes.clear();
    await db.almacen_articulos.clear();
    if (modules.length) await db.almacen_modulos.bulkPut(modules);
    if (shelves.length) await db.almacen_estantes.bulkPut(shelves);
    if (articles.length) await db.almacen_articulos.bulkPut(articles);
  });
}

export async function mergeRawConfig({ modules, shelves, articles }) {
  await db.transaction('rw', db.almacen_modulos, db.almacen_estantes, db.almacen_articulos, async () => {
    if (modules.length) await db.almacen_modulos.bulkPut(modules);
    if (shelves.length) await db.almacen_estantes.bulkPut(shelves);
    if (articles.length) await db.almacen_articulos.bulkPut(articles);
  });
}

export async function readRawConfig(almacenId) {
  const modules = await db.almacen_modulos.where('almacen_id').equals(almacenId).toArray();
  const moduleIds = new Set(modules.map((module) => module.id));
  const shelves = (await db.almacen_estantes.toArray()).filter((shelf) => moduleIds.has(shelf.modulo_id));
  const articles = await db.almacen_articulos.where('almacen_id').equals(almacenId).toArray();
  return { modules, shelves, articles };
}

export async function getSyncMetadata(key) {
  const row = await db.sync_metadata.get(key);
  return row?.value ?? null;
}

export async function setSyncMetadata(key, value) {
  await db.sync_metadata.put({ key, value, updated_at: new Date().toISOString() });
}
