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

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSuffixes(sufijos) {
  if (Array.isArray(sufijos)) return sufijos;
  if (typeof sufijos === 'string') {
    try {
      const parsed = JSON.parse(sufijos);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function makeShelfId(moduleId, shelfNumber, position) {
  return `${moduleId}-E${shelfNumber}-P${position}`;
}

function makeAssignmentKey(moduleId, shelfNumber, position) {
  return `${moduleId}:${shelfNumber}:${position}`;
}

function collectArticleAssignments(articles) {
  const assignments = new Map();

  for (const article of articles) {
    const directLocations = Array.isArray(article.ubicaciones) ? article.ubicaciones : [];

    for (const location of directLocations) {
      const moduleId = location.modulo_id ?? location.module_id;
      const shelfNumber = toNumber(location.estante ?? location.numero_estante ?? location.shelf);
      const position = toNumber(location.posicion ?? location.balda ?? location.position);
      if (!moduleId || !shelfNumber || !position) continue;

      assignments.set(makeAssignmentKey(moduleId, shelfNumber, position), {
        articulo_id: article.id,
        sku: `${article.sku}${location.sufijo ? `-${location.sufijo}` : ''}`,
        descripcion: article.descripcion,
        capacidad: toNumber(location.capacidad, 0)
      });
    }

    const moduleId = article.modulo_id ?? article.module_id;
    const shelfNumber = toNumber(article.estante ?? article.numero_estante ?? article.shelf);
    const position = toNumber(article.posicion ?? article.balda ?? article.position);

    if (moduleId && shelfNumber && position) {
      const suffixes = normalizeSuffixes(article.sufijos);
      const suffix = article.sufijo ?? suffixes[0]?.sufijo;
      assignments.set(makeAssignmentKey(moduleId, shelfNumber, position), {
        articulo_id: article.id,
        sku: `${article.sku}${suffix ? `-${suffix}` : ''}`,
        descripcion: article.descripcion,
        capacidad: toNumber(article.capacidad ?? suffixes[0]?.capacidad, 0)
      });
    }
  }

  return assignments;
}

function buildShelfConfig({ modules, shelves, articles, almacenId }) {
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  const assignments = collectArticleAssignments(articles);

  return shelves.flatMap((shelf) => {
    const module = modulesById.get(shelf.modulo_id);
    if (!module) return [];

    const count = Math.min(8, Math.max(0, toNumber(shelf.cantidad_baldas, 0)));
    return Array.from({ length: count }, (_, index) => {
      const position = index + 1;
      const assignment = assignments.get(makeAssignmentKey(shelf.modulo_id, shelf.numero, position));

      return {
        id: makeShelfId(shelf.modulo_id, shelf.numero, position),
        almacen_id: almacenId,
        modulo_id: shelf.modulo_id,
        modulo: module.nombre || `Modulo ${module.orden ?? ''}`.trim(),
        estante_id: shelf.id,
        estante: shelf.numero,
        posicion: position,
        articulo_id: assignment?.articulo_id ?? null,
        sku: assignment?.sku ?? null,
        descripcion: assignment?.descripcion ?? null,
        capacidad: assignment?.capacidad ?? 0,
        updated_at: [module.updated_at, shelf.updated_at, assignment?.updated_at].filter(Boolean).sort().at(-1) ?? nowIso()
      };
    });
  });
}

export const syncService = {
  async downloadRemoteConfig(almacenId) {
    const { data: modules, error: modulesError } = await supabase
      .from('almacen_modulos')
      .select('*')
      .eq('almacen_id', almacenId)
      .order('orden', { ascending: true });

    if (modulesError) throw modulesError;

    const moduleIds = (modules ?? []).map((module) => module.id);
    const { data: shelves, error: shelvesError } = moduleIds.length
      ? await supabase
        .from('almacen_estantes')
        .select('*')
        .in('modulo_id', moduleIds)
        .order('numero', { ascending: true })
      : { data: [], error: null };

    if (shelvesError) throw shelvesError;

    const { data: articles, error: articlesError } = await supabase
      .from('almacen_articulos')
      .select('*')
      .eq('almacen_id', almacenId)
      .order('descripcion', { ascending: true });

    if (articlesError) throw articlesError;

    const rows = buildShelfConfig({
      modules: modules ?? [],
      shelves: shelves ?? [],
      articles: articles ?? [],
      almacenId
    });
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
