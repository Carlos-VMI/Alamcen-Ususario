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

function normalizeLocations(ubicaciones) {
  if (Array.isArray(ubicaciones)) return ubicaciones;
  if (typeof ubicaciones === 'string') {
    try {
      const parsed = JSON.parse(ubicaciones);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeSuffix(value, index = 0) {
  const text = String(value ?? '').trim();
  if (text) return text.padStart(2, '0');
  return String(index + 1).padStart(2, '0');
}

function makeShelfId(moduleId, shelfNumber, position) {
  return `${moduleId}-E${shelfNumber}-C${position}`;
}

function makeAssignmentKey(moduleId, shelfNumber, position) {
  return `${moduleId}:${shelfNumber}:${position}`;
}

function makeDisplayLocation(module, shelfNumber, position) {
  return `${module.nombre || `Modulo ${module.orden ?? ''}`.trim()} - Estante ${shelfNumber} - Balda ${position}`;
}

function collectArticleAssignments(articles) {
  const assignments = new Map();

  for (const article of articles) {
    const directLocations = normalizeLocations(article.ubicaciones);

    for (const location of directLocations) {
      const moduleId = location.modulo_id ?? location.module_id;
      const shelfNumber = toNumber(location.estante ?? location.numero_estante ?? location.shelf);
      const position = toNumber(location.posicion ?? location.balda ?? location.position);
      if (!moduleId || !shelfNumber || !position) continue;

      assignments.set(makeAssignmentKey(moduleId, shelfNumber, position), {
        articulo_id: article.id,
        codigo_articulo: article.codigo_articulo ?? null,
        codigo_cliente: article.codigo_cliente ?? null,
        sku_base: article.sku,
        sufijo: location.sufijo ? normalizeSuffix(location.sufijo) : null,
        sku: `${article.sku}${location.sufijo ? `-${normalizeSuffix(location.sufijo)}` : ''}`,
        descripcion: article.descripcion,
        capacidad: toNumber(location.capacidad, 0),
        updated_at: [article.updated_at, location.updated_at].filter(Boolean).sort().at(-1)
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
        codigo_articulo: article.codigo_articulo ?? null,
        codigo_cliente: article.codigo_cliente ?? null,
        sku_base: article.sku,
        sufijo: suffix ? normalizeSuffix(suffix) : null,
        sku: `${article.sku}${suffix ? `-${normalizeSuffix(suffix)}` : ''}`,
        descripcion: article.descripcion,
        capacidad: toNumber(article.capacidad ?? suffixes[0]?.capacidad, 0),
        updated_at: article.updated_at
      });
    }
  }

  return assignments;
}

function flattenArticleSuffixes(articles) {
  return [...articles]
    .sort((a, b) => {
      const bySku = String(a.sku ?? '').localeCompare(String(b.sku ?? ''), 'es', { numeric: true });
      if (bySku !== 0) return bySku;
      return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
    })
    .flatMap((article) => {
      const suffixes = normalizeSuffixes(article.sufijos);
      const normalizedSuffixes = suffixes.length ? suffixes : [{ sufijo: '01', capacidad: article.capacidad ?? 0 }];

      return normalizedSuffixes.map((suffix, index) => {
        const normalizedSuffix = normalizeSuffix(suffix.sufijo, index);
        return {
          articulo_id: article.id,
          codigo_articulo: article.codigo_articulo ?? null,
          codigo_cliente: article.codigo_cliente ?? null,
          sku_base: article.sku,
          sufijo: normalizedSuffix,
          sku: `${article.sku}-${normalizedSuffix}`,
          descripcion: article.descripcion,
          capacidad: toNumber(suffix.capacidad ?? suffix.cantidad ?? article.capacidad, 0),
          updated_at: article.updated_at
        };
      });
    });
}

function buildShelfConfig({ modules, shelves, articles, almacenId }) {
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  const assignments = collectArticleAssignments(articles);
  const sequentialAssignments = flattenArticleSuffixes(
    articles.filter((article) => !article.modulo_id && !article.module_id && normalizeLocations(article.ubicaciones).length === 0)
  );
  let sequentialIndex = 0;

  return [...shelves].sort((a, b) => {
    const moduleA = modulesById.get(a.modulo_id)?.orden ?? 0;
    const moduleB = modulesById.get(b.modulo_id)?.orden ?? 0;
    if (moduleA !== moduleB) return moduleA - moduleB;
    return toNumber(a.numero) - toNumber(b.numero);
  }).flatMap((shelf) => {
    const module = modulesById.get(shelf.modulo_id);
    if (!module) return [];

    const count = Math.min(8, Math.max(0, toNumber(shelf.cantidad_baldas, 0)));
    return Array.from({ length: count }, (_, index) => {
      const position = index + 1;
      const assignment = assignments.get(makeAssignmentKey(shelf.modulo_id, shelf.numero, position))
        ?? sequentialAssignments[sequentialIndex++]
        ?? null;

      return {
        id: makeShelfId(shelf.modulo_id, shelf.numero, position),
        almacen_id: almacenId,
        modulo_id: shelf.modulo_id,
        modulo: module.nombre || `Modulo ${module.orden ?? ''}`.trim(),
        estante_id: shelf.id,
        estante: shelf.numero,
        posicion: position,
        etiqueta_balda: `C${position}`,
        articulo_id: assignment?.articulo_id ?? null,
        codigo_articulo: assignment?.codigo_articulo ?? null,
        codigo_cliente: assignment?.codigo_cliente ?? null,
        sku_base: assignment?.sku_base ?? null,
        sufijo: assignment?.sufijo ?? null,
        sku: assignment?.sku ?? null,
        descripcion: assignment?.descripcion ?? null,
        capacidad: assignment?.capacidad ?? 0,
        ubicacion: makeDisplayLocation(module, shelf.numero, position),
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
      .order('sku', { ascending: true });

    if (articlesError) throw articlesError;

    const rows = buildShelfConfig({
      modules: modules ?? [],
      shelves: shelves ?? [],
      articles: articles ?? [],
      almacenId
    });
    await replaceShelfConfig(rows);
    await this.downloadRemoteStates(rows.map((row) => row.id));
    return rows;
  },

  async downloadRemoteStates(shelfIds) {
    if (!shelfIds.length) return [];

    const { data, error } = await supabase
      .from('estados_baldas')
      .select('*')
      .in('id_balda', shelfIds);

    if (error) throw error;

    const rows = data ?? [];
    if (rows.length) {
      await db.estados_baldas.bulkPut(rows);
    }

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
        sufijo: balda.sufijo,
        capacidad: balda.capacidad,
        ubicacion: balda.ubicacion ?? `${balda.modulo} - Estante ${balda.estante} - Balda ${balda.posicion}`,
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
