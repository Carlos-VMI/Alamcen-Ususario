import {
  db,
  getSyncMetadata,
  mergeRawConfig,
  readRawConfig,
  replaceRawConfig,
  replaceShelfConfig,
  setSyncMetadata,
  upsertShelfStates
} from './db';
import { sendPedidoEmail } from './orderService';
import { supabase } from './supabaseClient';

export const SYNC_INTERVAL_MS = 15000;
export const SYNC_BATCH_SIZE = 50;
export const SYNC_TIMEOUT_MS = 18000;
export const SHELF_STATES = {
  FULL: 'lleno',
  EMPTY: 'vacio',
  ORDERED: 'pedido'
};

function nowIso() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error?.message ?? String(error);
}

function isSchemaCacheError(error) {
  const message = errorMessage(error).toLowerCase();
  return message.includes('schema cache')
    || message.includes('could not find the table')
    || message.includes('relation') && message.includes('does not exist');
}

function maxUpdatedAt(items) {
  return items
    .map((item) => item.payload?.updated_at)
    .filter(Boolean)
    .sort()
    .at(-1) || nowIso();
}

function withTimeout(promise, label, timeoutMs = SYNC_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} excedio ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

function configSyncKey(almacenId) {
  return `remote_config_synced_at:${almacenId}`;
}

function statesSyncKey(almacenId) {
  return `remote_states_synced_at:${almacenId}`;
}

const LEGACY_QUEUE_PURGE_KEY = 'legacy_estados_baldas_queue_purged_v1';

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

function normalizeRole(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'admin' || value === 'administrador') return 'administrador';
  if (value === 'repositor') return 'repositor';
  return 'operario';
}

function makeShelfId(moduleId, shelfNumber, position) {
  return `${moduleId}-E${shelfNumber}-C${position}`;
}

function makeCubetaId(moduleId, shelfNumber, position, suffix) {
  return `${makeShelfId(moduleId, shelfNumber, position)}-${suffix}`;
}

function makeAssignmentKey(moduleId, shelfNumber, position) {
  return `${moduleId}:${shelfNumber}:${position}`;
}

function makeDisplayLocation(module, shelfNumber, position) {
  return `${module.nombre || `Modulo ${module.orden ?? ''}`.trim()} - Estante ${shelfNumber} - Balda ${position}`;
}

function makeCompactLocation(module, shelfNumber, position) {
  return `M${toNumber(module.orden, 0)}E${shelfNumber}C${position}`;
}

function parseCoordinate(value) {
  const text = String(value ?? '').toUpperCase();
  const match = text.match(/M(?:ODULO)?\s*0*(\d+)\s*E\s*0*(\d+)\s*C\s*0*(\d+)/i);
  if (!match) return null;

  return {
    moduleOrder: toNumber(match[1], null),
    shelfNumber: toNumber(match[2], null),
    position: toNumber(match[3], null)
  };
}

function buildArticleCubetas(article, suffixSource) {
  const suffixes = normalizeSuffixes(suffixSource).length
    ? normalizeSuffixes(suffixSource)
    : [{ sufijo: article.sufijo ?? '01', capacidad: article.capacidad ?? 0 }];

  return suffixes.map((suffix, index) => {
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
      estado: suffix.estado || SHELF_STATES.FULL,
      estado_updated_at: suffix.estado_updated_at || article.updated_at,
      updated_at: article.updated_at
    };
  });
}

function collectArticleAssignments(articles, modules) {
  const assignments = new Map();
  const modulesByOrder = new Map(modules.map((module) => [toNumber(module.orden, 0), module]));

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
        sku: article.sku,
        descripcion: article.descripcion,
        cubetas: buildArticleCubetas(article, location.sufijos ?? article.sufijos).map((cubeta, index) => {
          const suffix = location.sufijo && index === 0 ? normalizeSuffix(location.sufijo) : cubeta.sufijo;
          return {
            ...cubeta,
            sufijo: suffix,
            sku: `${article.sku}-${suffix}`,
            capacidad: toNumber(location.capacidad ?? cubeta.capacidad, cubeta.capacidad)
          };
        }),
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
        sku: article.sku,
        descripcion: article.descripcion,
        cubetas: buildArticleCubetas(article, suffixes.length ? suffixes : [{ sufijo: suffix, capacidad: article.capacidad }]),
        updated_at: article.updated_at
      });
    }

    const coordinate = parseCoordinate(article.ubicacion)
      ?? parseCoordinate(article.sku)
      ?? parseCoordinate(article.codigo_articulo)
      ?? parseCoordinate(article.codigo_cliente);

    if (coordinate?.moduleOrder && coordinate.shelfNumber && coordinate.position) {
      const module = modulesByOrder.get(coordinate.moduleOrder);
      if (module) {
        assignments.set(makeAssignmentKey(module.id, coordinate.shelfNumber, coordinate.position), {
          articulo_id: article.id,
          codigo_articulo: article.codigo_articulo ?? null,
          codigo_cliente: article.codigo_cliente ?? null,
          sku_base: article.sku,
          sku: article.sku,
          descripcion: article.descripcion,
          cubetas: buildArticleCubetas(article, article.sufijos),
          updated_at: article.updated_at
        });
      }
    }
  }

  return assignments;
}

function buildShelfConfig({ modules, shelves, articles, almacenId }) {
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  const assignments = collectArticleAssignments(articles, modules);

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
        ?? null;
      const shelfId = makeShelfId(shelf.modulo_id, shelf.numero, position);
      const cubetas = (assignment?.cubetas ?? []).map((cubeta, cubetaIndex) => ({
        ...cubeta,
        id: makeCubetaId(shelf.modulo_id, shelf.numero, position, cubeta.sufijo ?? normalizeSuffix(null, cubetaIndex)),
        almacen_id: almacenId,
        modulo_id: shelf.modulo_id,
        modulo: module.nombre || `Modulo ${module.orden ?? ''}`.trim(),
        modulo_orden: toNumber(module.orden, 0),
        estante_id: shelf.id,
        estante: shelf.numero,
        posicion: position,
        etiqueta_balda: `C${position}`,
        ubicacion: makeDisplayLocation(module, shelf.numero, position),
        codigo_ubicacion: makeCompactLocation(module, shelf.numero, position)
      }));

      return {
        id: shelfId,
        almacen_id: almacenId,
        modulo_id: shelf.modulo_id,
        modulo: module.nombre || `Modulo ${module.orden ?? ''}`.trim(),
        modulo_orden: toNumber(module.orden, 0),
        estante_id: shelf.id,
        estante: shelf.numero,
        posicion: position,
        etiqueta_balda: `C${position}`,
        articulo_id: assignment?.articulo_id ?? null,
        codigo_articulo: assignment?.codigo_articulo ?? null,
        codigo_cliente: assignment?.codigo_cliente ?? null,
        sku_base: assignment?.sku_base ?? null,
        sku: assignment?.sku ?? null,
        descripcion: assignment?.descripcion ?? null,
        capacidad: cubetas.reduce((sum, cubeta) => sum + toNumber(cubeta.capacidad, 0), 0),
        cubetas,
        ubicacion: makeDisplayLocation(module, shelf.numero, position),
        codigo_ubicacion: makeCompactLocation(module, shelf.numero, position),
        updated_at: [module.updated_at, shelf.updated_at, assignment?.updated_at].filter(Boolean).sort().at(-1) ?? nowIso()
      };
    });
  });
}

export const syncService = {
  async clearConfigCache(almacenId) {
    await db.transaction(
      'rw',
      db.estanterias_config,
      db.almacen_modulos,
      db.almacen_estantes,
      db.almacen_articulos,
      db.sync_metadata,
      async () => {
        await db.estanterias_config.clear();
        await db.almacen_modulos.clear();
        await db.almacen_estantes.clear();
        await db.almacen_articulos.clear();
        await db.sync_metadata.delete(configSyncKey(almacenId));
        await db.sync_metadata.delete(statesSyncKey(almacenId));
      }
    );
  },

  async forceRefreshRemoteConfig(almacenId) {
    await this.clearConfigCache(almacenId);
    return this.downloadRemoteConfig(almacenId);
  },

  async rebuildShelfConfigFromLocalCache(almacenId) {
    const rawConfig = await readRawConfig(almacenId);
    const rows = buildShelfConfig({
      modules: rawConfig.modules,
      shelves: rawConfig.shelves,
      articles: rawConfig.articles,
      almacenId
    });

    await replaceShelfConfig(rows);
    await this.applyArticleStatesToLocal(rows);
    return rows;
  },

  async applyArticleRealtimeChange(almacenId, payload) {
    const eventType = payload.eventType;
    const nextRow = payload.new;
    const oldRow = payload.old;

    if (eventType === 'DELETE') {
      if (oldRow?.id) await db.almacen_articulos.delete(oldRow.id);
      return this.rebuildShelfConfigFromLocalCache(almacenId);
    }

    if (nextRow?.almacen_id && nextRow.almacen_id !== almacenId) {
      return db.estanterias_config.toArray();
    }

    if (nextRow?.id) {
      await db.almacen_articulos.put(nextRow);
      if (nextRow.updated_at) {
        await setSyncMetadata(configSyncKey(almacenId), nextRow.updated_at);
      }
    }

    return this.rebuildShelfConfigFromLocalCache(almacenId);
  },

  async applyModuleRealtimeChange(almacenId, payload) {
    const eventType = payload.eventType;
    const nextRow = payload.new;
    const oldRow = payload.old;

    if (eventType === 'DELETE') {
      if (oldRow?.id) {
        await db.transaction('rw', db.almacen_modulos, db.almacen_estantes, async () => {
          await db.almacen_modulos.delete(oldRow.id);
          await db.almacen_estantes.where('modulo_id').equals(oldRow.id).delete();
        });
      }
      return this.rebuildShelfConfigFromLocalCache(almacenId);
    }

    if (nextRow?.almacen_id && nextRow.almacen_id !== almacenId) {
      return db.estanterias_config.toArray();
    }

    if (nextRow?.id) {
      await db.almacen_modulos.put(nextRow);
      if (nextRow.updated_at) {
        await setSyncMetadata(configSyncKey(almacenId), nextRow.updated_at);
      }
    }

    return this.rebuildShelfConfigFromLocalCache(almacenId);
  },

  async applyShelfRealtimeChange(almacenId, payload) {
    const eventType = payload.eventType;
    const nextRow = payload.new;
    const oldRow = payload.old;

    if (eventType === 'DELETE') {
      if (oldRow?.id) await db.almacen_estantes.delete(oldRow.id);
      return this.rebuildShelfConfigFromLocalCache(almacenId);
    }

    if (nextRow?.modulo_id) {
      const module = await db.almacen_modulos.get(nextRow.modulo_id);
      if (!module || module.almacen_id !== almacenId) {
        return db.estanterias_config.toArray();
      }

      await db.almacen_estantes.put(nextRow);
      if (nextRow.updated_at) {
        await setSyncMetadata(configSyncKey(almacenId), nextRow.updated_at);
      }
    }

    return this.rebuildShelfConfigFromLocalCache(almacenId);
  },

  async downloadRemoteConfig(almacenId, { fullRefresh = false } = {}) {
    const lastSyncAt = fullRefresh ? null : await getSyncMetadata(configSyncKey(almacenId));
    const syncStartedAt = nowIso();

    let modulesQuery = supabase
      .from('almacen_modulos')
      .select('*')
      .eq('almacen_id', almacenId)
      .order('orden', { ascending: true });

    if (lastSyncAt) modulesQuery = modulesQuery.gt('updated_at', lastSyncAt);

    const { data: modules, error: modulesError } = await withTimeout(modulesQuery, 'Descarga de modulos');
    if (modulesError) throw modulesError;

    const localBeforeMerge = fullRefresh ? { modules: [] } : await readRawConfig(almacenId);
    const moduleIds = Array.from(new Set([
      ...localBeforeMerge.modules.map((module) => module.id),
      ...(modules ?? []).map((module) => module.id)
    ]));

    let shelvesResult = { data: [], error: null };
    if (moduleIds.length) {
      let shelvesQuery = supabase
        .from('almacen_estantes')
        .select('*')
        .in('modulo_id', moduleIds)
        .order('numero', { ascending: true });

      if (lastSyncAt) shelvesQuery = shelvesQuery.gt('updated_at', lastSyncAt);
      shelvesResult = await withTimeout(shelvesQuery, 'Descarga de estantes');
    }

    const { data: shelves, error: shelvesError } = shelvesResult;
    if (shelvesError) throw shelvesError;

    let articlesQuery = supabase
      .from('almacen_articulos')
      .select('*')
      .eq('almacen_id', almacenId)
      .order('sku', { ascending: true });

    if (lastSyncAt) articlesQuery = articlesQuery.gt('updated_at', lastSyncAt);

    const { data: articles, error: articlesError } = await withTimeout(articlesQuery, 'Descarga de articulos');
    if (articlesError) throw articlesError;

    if (lastSyncAt) {
      await mergeRawConfig({
        modules: modules ?? [],
        shelves: shelves ?? [],
        articles: articles ?? []
      });
    } else {
      await replaceRawConfig({
        modules: modules ?? [],
        shelves: shelves ?? [],
        articles: articles ?? []
      });
    }

    const rawConfig = await readRawConfig(almacenId);
    const rows = buildShelfConfig({
      modules: rawConfig.modules,
      shelves: rawConfig.shelves,
      articles: rawConfig.articles,
      almacenId
    });

    await replaceShelfConfig(rows);
    await this.applyArticleStatesToLocal(rows);
    await setSyncMetadata(configSyncKey(almacenId), syncStartedAt);
    return rows;
  },

  async applyArticleStatesToLocal(configRows) {
    const pendingStateIds = new Set(
      (await db.cola_sincronizacion
        .where('tipo')
        .equals('estado_balda.updated')
        .toArray())
        .map((item) => item.entity_id)
    );
    const rows = configRows
      .flatMap((row) => row.cubetas?.length ? row.cubetas : [row])
      .filter((cubeta) => cubeta.sku && !pendingStateIds.has(cubeta.id))
      .map((cubeta) => ({
        id_balda: cubeta.id,
        estado: cubeta.estado || SHELF_STATES.FULL,
        updated_at: cubeta.estado_updated_at || cubeta.updated_at || nowIso(),
        synced_at: nowIso()
      }));

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

  async updateManyShelfStates(items) {
    await upsertShelfStates(items);
  },

  async markEmptyShelvesAsOrdered(shelves, statesById) {
    const rows = shelves
      .flatMap((shelf) => shelf.cubetas?.length ? shelf.cubetas : [shelf])
      .filter((shelf) => shelf.sku && statesById.get(shelf.id) === SHELF_STATES.EMPTY)
      .map((shelf) => ({
        id_balda: shelf.id,
        estado: SHELF_STATES.ORDERED
      }));

    await this.updateManyShelfStates(rows);
    return rows.length;
  },

  async enqueuePedidoEmail({ rows, warehouse, operator, reason = 'offline' }) {
    if (!rows.length) return null;

    const createdAt = nowIso();
    return this.enqueue({
      tipo: 'pedido.email',
      entity_id: `pedido:${warehouse?.id || 'almacen'}:${createdAt}`,
      created_at: createdAt,
      payload: {
        rows,
        warehouse,
        operator,
        reason,
        created_at: createdAt
      }
    });
  },

  async getCurrentOperatorRole(almacenId) {
    try {
      const { data: userData } = await supabase.auth.getUser();
      const email = userData?.user?.email;
      if (!email) return 'operario';

      const { data, error } = await supabase
        .from('almacen_operadores')
        .select('rol')
        .eq('almacen_id', almacenId)
        .eq('email', email)
        .eq('activo', true)
        .maybeSingle();

      if (error) return 'operario';
      return normalizeRole(data?.rol);
    } catch {
      return 'operario';
    }
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
    if (operation.tipo === 'estado_balda.updated') {
      const existing = await db.cola_sincronizacion
        .where('entity_id')
        .equals(operation.entity_id)
        .and((item) => item.tipo === operation.tipo)
        .first();

      if (existing) {
        return db.cola_sincronizacion.update(existing.id, {
          payload: operation.payload,
          attempts: 0,
          created_at: operation.created_at ?? nowIso(),
          last_error: null
        });
      }
    }

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

  async purgeLegacyStateQueueOnce() {
    const alreadyPurged = await getSyncMetadata(LEGACY_QUEUE_PURGE_KEY);
    if (alreadyPurged) return 0;

    const legacyItems = await db.cola_sincronizacion
      .where('tipo')
      .equals('estado_balda.updated')
      .toArray();

    if (legacyItems.length) {
      await db.cola_sincronizacion.bulkDelete(legacyItems.map((item) => item.id));
    }

    await setSyncMetadata(LEGACY_QUEUE_PURGE_KEY, nowIso());
    return legacyItems.length;
  },

  async syncStateItemsToArticles(stateItems) {
    const latestByEntity = new Map();
    for (const item of stateItems) {
      const existing = latestByEntity.get(item.entity_id);
      if (!existing || String(item.payload?.updated_at ?? '') >= String(existing.payload?.updated_at ?? '')) {
        latestByEntity.set(item.entity_id, item);
      }
    }

    const configRows = await db.estanterias_config.toArray();
    const cubetasById = new Map();
    for (const row of configRows) {
      const cubetas = row.cubetas?.length ? row.cubetas : [row];
      for (const cubeta of cubetas) {
        cubetasById.set(cubeta.id, cubeta);
      }
    }

    const changesByArticle = new Map();
    for (const item of latestByEntity.values()) {
      const cubeta = cubetasById.get(item.entity_id);
      if (!cubeta?.articulo_id || !cubeta.sufijo) continue;

      const changes = changesByArticle.get(cubeta.articulo_id) ?? [];
      changes.push({ item, cubeta });
      changesByArticle.set(cubeta.articulo_id, changes);
    }

    for (const [articleId, changes] of changesByArticle.entries()) {
      const article = await db.almacen_articulos.get(articleId);
      if (!article) continue;

      const changesBySuffix = new Map(changes.map(({ item, cubeta }) => [cubeta.sufijo, item]));
      const updatedAt = maxUpdatedAt(changes.map(({ item }) => item));
      const suffixes = normalizeSuffixes(article.sufijos).map((suffix, index) => {
        const normalizedSuffix = normalizeSuffix(suffix.sufijo, index);
        const change = changesBySuffix.get(normalizedSuffix);
        if (!change) return suffix;

        return {
          ...suffix,
          sufijo: normalizedSuffix,
          estado: change.payload.estado,
          estado_updated_at: change.payload.updated_at
        };
      });

      const { error } = await withTimeout(
        supabase
          .from('almacen_articulos')
          .update({ sufijos: suffixes, updated_at: updatedAt })
          .eq('id', articleId),
        'Envio batch de estados a articulos'
      );

      if (error) throw error;
      await db.almacen_articulos.update(articleId, { sufijos: suffixes, updated_at: updatedAt });
    }

    return Array.from(latestByEntity.values());
  },

  async flushPendingQueue({ limit = SYNC_BATCH_SIZE } = {}) {
    if (!navigator.onLine) return { synced: 0, skipped: 'offline' };

    const items = await db.cola_sincronizacion.orderBy('created_at').limit(limit).toArray();
    let synced = 0;
    const stateItems = items.filter((item) => item.tipo === 'estado_balda.updated');
    const otherItems = items.filter((item) => item.tipo !== 'estado_balda.updated');

    if (stateItems.length) {
      try {
        const syncedStateItems = await this.syncStateItemsToArticles(stateItems);
        const payload = syncedStateItems.map((item) => ({
          id_balda: item.payload.id_balda,
          estado: item.payload.estado,
          updated_at: item.payload.updated_at
        }));

        const syncedAt = nowIso();
        await db.transaction('rw', db.estados_baldas, db.cola_sincronizacion, async () => {
          await db.estados_baldas.bulkPut(
            payload.map((row) => ({
              id_balda: row.id_balda,
              estado: row.estado,
              updated_at: row.updated_at,
              synced_at: syncedAt
            }))
          );
          await db.cola_sincronizacion.bulkDelete(syncedStateItems.map((item) => item.id));
        });
        synced += syncedStateItems.length;
      } catch (error) {
        if (isSchemaCacheError(error)) {
          await db.cola_sincronizacion.bulkDelete(stateItems.map((item) => item.id));
          return { synced, discarded: stateItems.length, error: errorMessage(error) };
        }

        await db.transaction('rw', db.cola_sincronizacion, async () => {
          for (const item of stateItems) {
            await db.cola_sincronizacion.update(item.id, {
              attempts: (item.attempts ?? 0) + 1,
              last_error: errorMessage(error)
            });
          }
        });
      }
    }

    for (const item of otherItems) {
      try {
        await this.syncQueueItem(item);
        await db.cola_sincronizacion.delete(item.id);
        synced += 1;
      } catch (error) {
        await db.cola_sincronizacion.update(item.id, {
          attempts: (item.attempts ?? 0) + 1,
          last_error: errorMessage(error)
        });
      }
    }

    return { synced };
  },

  async syncQueueItem(item) {
    if (item.tipo === 'estado_balda.updated') {
      await this.syncStateItemsToArticles([item]);
      await db.estados_baldas.put({
        id_balda: item.payload.id_balda,
        estado: item.payload.estado,
        updated_at: item.payload.updated_at,
        synced_at: nowIso()
      });
      return;
    }

    if (item.tipo === 'reposicion.requested') {
      const { error } = await withTimeout(
        supabase.functions.invoke('solicitar-reposicion', {
          body: item.payload
        }),
        'Solicitud de reposicion'
      );

      if (error) throw error;
      return;
    }

    if (item.tipo === 'pedido.email') {
      const payload = item.payload || {};
      await sendPedidoEmail({
        rows: payload.rows || [],
        warehouse: payload.warehouse,
        operator: payload.operator
      });

      const orderedRows = (payload.rows || [])
        .filter((row) => row.id_balda)
        .map((row) => ({
          id_balda: row.id_balda,
          estado: SHELF_STATES.ORDERED
        }));

      if (orderedRows.length) {
        await this.updateManyShelfStates(orderedRows);
      }
      return;
    }

    throw new Error(`Tipo de cola no soportado: ${item.tipo}`);
  }
};
