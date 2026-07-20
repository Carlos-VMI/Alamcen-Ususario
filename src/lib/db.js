import Dexie from 'dexie';

export const db = new Dexie('almacen_operario');

db.version(1).stores({
  estanterias_config: 'id, almacen_id, modulo, estante, posicion, articulo_id, sku, updated_at',
  estados_baldas: 'id_balda, estado, updated_at, synced_at',
  cola_sincronizacion: '++id, tipo, entity_id, created_at, attempts'
});

export async function upsertShelfState(idBalda, estado) {
  const now = new Date().toISOString();
  await db.transaction('rw', db.estados_baldas, db.cola_sincronizacion, async () => {
    await db.estados_baldas.put({
      id_balda: idBalda,
      estado,
      updated_at: now,
      synced_at: null
    });

    await db.cola_sincronizacion.add({
      tipo: 'estado_balda.updated',
      entity_id: idBalda,
      payload: {
        id_balda: idBalda,
        estado,
        updated_at: now
      },
      attempts: 0,
      created_at: now,
      last_error: null
    });
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

    await db.cola_sincronizacion.bulkAdd(
      items.map(({ id_balda, estado }) => ({
        tipo: 'estado_balda.updated',
        entity_id: id_balda,
        payload: {
          id_balda,
          estado,
          updated_at: now
        },
        attempts: 0,
        created_at: now,
        last_error: null
      }))
    );
  });
}

export async function replaceShelfConfig(configRows) {
  await db.transaction('rw', db.estanterias_config, async () => {
    await db.estanterias_config.clear();
    await db.estanterias_config.bulkPut(configRows);
  });
}
