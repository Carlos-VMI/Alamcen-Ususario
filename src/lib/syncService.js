import { db, replaceShelfConfig } from './db';
import { supabase } from './supabaseClient';

export const SYNC_INTERVAL_MS = 15000;
export const SYNC_BATCH_SIZE = 50;

function nowIso() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error?.message ?? String(error);
}

export const syncService = {
  async downloadRemoteConfig(almacenId) {
    const { data, error } = await supabase
      .from('estanterias_config')
      .select('*')
      .eq('almacen_id', almacenId)
      .order('modulo', { ascending: true })
      .order('estante', { ascending: true })
      .order('posicion', { ascending: true });

    if (error) throw error;

    const rows = data ?? [];
    await replaceShelfConfig(rows);
    return rows;
  },

  async updateShelfState(idBalda, estado) {
    const updatedAt = nowIso();

    await db.transaction('rw', db.estados_baldas, db.cola_sincronizacion, async () => {
      await db.estados_baldas.put({
        id_balda: idBalda,
        estado,
        updated_at: updatedAt,
        synced_at: null
      });

      await this.enqueue({
        tipo: 'estado_balda.updated',
        entity_id: idBalda,
        payload: {
          id_balda: idBalda,
          estado,
          updated_at: updatedAt
        }
      });
    });
  },

  async requestReposition(balda) {
    const createdAt = nowIso();

    await this.enqueue({
      tipo: 'reposicion.requested',
      entity_id: balda.id,
      payload: {
        id_balda: balda.id,
        sku: balda.sku,
        descripcion: balda.descripcion,
        modulo: balda.modulo,
        estante: balda.estante,
        posicion: balda.posicion,
        ubicacion: `${balda.modulo} - Estante ${balda.estante} - Posicion ${balda.posicion}`,
        created_at: createdAt
      }
    });
  },

  async enqueue(operation) {
    return db.cola_sincronizacion.add({
      ...operation,
      attempts: 0,
      created_at: operation.created_at ?? nowIso(),
      last_error: null
    });
  },

  async pendingCount() {
    return db.cola_sincronizacion.count();
  },

  async flushPendingQueue({ limit = SYNC_BATCH_SIZE } = {}) {
    if (!navigator.onLine) return { synced: 0, skipped: 'offline' };

    const items = await db.cola_sincronizacion.orderBy('created_at').limit(limit).toArray();
    let synced = 0;

    for (const item of items) {
      try {
        await this.syncQueueItem(item);
        await db.cola_sincronizacion.delete(item.id);
        synced += 1;
      } catch (error) {
        await db.cola_sincronizacion.update(item.id, {
          attempts: (item.attempts ?? 0) + 1,
          last_error: errorMessage(error)
        });
        throw error;
      }
    }

    return { synced };
  },

  async syncQueueItem(item) {
    if (item.tipo === 'estado_balda.updated') {
      const { error } = await supabase.from('estados_baldas').upsert(item.payload, {
        onConflict: 'id_balda'
      });

      if (error) throw error;

      await db.estados_baldas.update(item.entity_id, {
        synced_at: nowIso()
      });
      return;
    }

    if (item.tipo === 'reposicion.requested') {
      const { error } = await supabase.functions.invoke('solicitar-reposicion', {
        body: item.payload
      });

      if (error) throw error;
      return;
    }

    throw new Error(`Tipo de cola no soportado: ${item.tipo}`);
  }
};
