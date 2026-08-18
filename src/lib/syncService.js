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
import { ledService } from './ledService';
import { sendPedidoEmail } from './orderService';
import { supabase } from './supabaseClient';

export const SYNC_INTERVAL_MS = 7000;
export const SYNC_BATCH_SIZE = 50;
export const SYNC_TIMEOUT_MS = 18000;
export const EMAIL_SEND_TIMEOUT_MS = 70000;
export const EMAIL_RETRY_DELAY_MS = 60000;
export const EMAIL_SENDING_STALE_MS = 120000;
export const SHELF_STATES = {
  FULL: 'lleno',
  EMPTY: 'vacio',
  ORDERED: 'pedido'
};

function nowIso() {
  return new Date().toISOString();
}

function addMsIso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function isPastIso(value) {
  if (!value) return true;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getTime() <= Date.now();
}

function isFreshIso(value, maxAgeMs) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && Date.now() - date.getTime() < maxAgeMs;
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

async function runOptionalQuery(query, label, fallback = []) {
  try {
    const { data, error } = await withTimeout(query, label);
    if (error) {
      console.warn(`[Sync] ${label} fallo; se continua con cache local`, error);
      return fallback;
    }
    return data ?? fallback;
  } catch (error) {
    console.warn(`[Sync] ${label} fallo; se continua con cache local`, error);
    return fallback;
  }
}

function makeQueueStateItem(row, updatedAt = nowIso()) {
  return {
    tipo: 'estado_balda.updated',
    entity_id: row.id_balda,
    payload: {
      id_balda: row.id_balda,
      estado: row.estado,
      updated_at: row.updated_at || updatedAt
    },
    attempts: 0,
    created_at: updatedAt,
    last_error: null
  };
}

function configSyncKey(almacenId) {
  return `remote_config_synced_at:${almacenId}`;
}

function statesSyncKey(almacenId) {
  return `remote_states_synced_at:${almacenId}`;
}

const LEGACY_QUEUE_PURGE_KEY = 'legacy_estados_baldas_queue_purged_v1';
let pendingQueueFlushPromise = null;

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

function normalizeLedCajones(cajones) {
  if (Array.isArray(cajones)) return cajones;
  if (typeof cajones === 'string') {
    try {
      const parsed = JSON.parse(cajones);
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

function makePedidoEntityId(rows, warehouse) {
  const warehouseId = warehouse?.id || 'almacen';
  const rowKey = rows
    .map((row) => String(row.id_balda || row.sku || row.codigo_articulo || row.ubicacion || '').trim())
    .filter(Boolean)
    .sort()
    .join('|');

  let hash = 0;
  for (let index = 0; index < rowKey.length; index += 1) {
    hash = ((hash << 5) - hash + rowKey.charCodeAt(index)) | 0;
  }

  return `pedido:${warehouseId}:${Math.abs(hash)}`;
}

function makeUniquePedidoId(rows, warehouse) {
  const baseId = makePedidoEntityId(rows, warehouse);
  const random =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `${baseId}:${random}`;
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
    const ledCajones = normalizeLedCajones(shelf.cajones);
    const shelfWidthCm = Math.max(1, toNumber(module.ancho_estante_cm, 100));
    const occupiedWidthCm = ledCajones
      .slice(0, count)
      .reduce((sum, cajon) => sum + toNumber(cajon.ancho_cm, 0), 0);
    const freeWidthCm = Math.max(0, shelfWidthCm - occupiedWidthCm);
    const configuredRows = Array.from({ length: count }, (_, index) => {
      const position = index + 1;
      const assignment = assignments.get(makeAssignmentKey(shelf.modulo_id, shelf.numero, position))
        ?? null;
      const shelfId = makeShelfId(shelf.modulo_id, shelf.numero, position);
      const ledCajon = ledCajones.find((item) => toNumber(item.posicion) === position) ?? ledCajones[index] ?? null;
      const ledMapping = ledCajon && (shelf.esp32_ip || ledCajon.esp32_ip)
        ? {
            id_balda: shelfId,
            esp32Ip: String(ledCajon.esp32_ip || shelf.esp32_ip || '').trim(),
            channel: toNumber(ledCajon.canal ?? ledCajon.channel ?? shelf.canal_led, 1),
            startLed: toNumber(ledCajon.startLed, 0),
            ledCount: toNumber(ledCajon.ledCount, 0),
            ancho_cm: toNumber(ledCajon.ancho_cm, 0),
            total_leds: toNumber(shelf.total_leds, 0),
            controlador_id: ledCajon.controlador_id ?? null
          }
        : null;
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
        codigo_ubicacion: makeCompactLocation(module, shelf.numero, position),
        led_mapping: ledMapping
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
        ancho_cm: toNumber(ledCajon?.ancho_cm, count > 0 ? shelfWidthCm / count : shelfWidthCm),
        shelf_width_cm: shelfWidthCm,
        cubetas,
        led_mapping: ledMapping,
        ubicacion: makeDisplayLocation(module, shelf.numero, position),
        codigo_ubicacion: makeCompactLocation(module, shelf.numero, position),
        updated_at: [module.updated_at, shelf.updated_at, assignment?.updated_at].filter(Boolean).sort().at(-1) ?? nowIso()
      };
    });

    if (count === 0 || freeWidthCm <= 0.001) return configuredRows;

    return [
      ...configuredRows,
      {
        id: `${shelf.id || makeShelfId(shelf.modulo_id, shelf.numero, 'row')}-free`,
        almacen_id: almacenId,
        modulo_id: shelf.modulo_id,
        modulo: module.nombre || `Modulo ${module.orden ?? ''}`.trim(),
        modulo_orden: toNumber(module.orden, 0),
        estante_id: shelf.id,
        estante: shelf.numero,
        posicion: count + 1,
        etiqueta_balda: '',
        articulo_id: null,
        codigo_articulo: null,
        codigo_cliente: null,
        sku_base: null,
        sku: null,
        descripcion: null,
        capacidad: 0,
        ancho_cm: freeWidthCm,
        shelf_width_cm: shelfWidthCm,
        cubetas: [],
        led_mapping: null,
        is_free_space: true,
        ubicacion: '',
        codigo_ubicacion: '',
        updated_at: [module.updated_at, shelf.updated_at].filter(Boolean).sort().at(-1) ?? nowIso()
      }
    ];
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
      db.almacen_configuracion,
      db.almacen_notificacion_emails,
      db.sync_metadata,
      async () => {
        await db.estanterias_config.clear();
        await db.almacen_modulos.clear();
        await db.almacen_estantes.clear();
        await db.almacen_articulos.clear();
        await db.almacen_configuracion.clear();
        await db.almacen_notificacion_emails.clear();
        await db.sync_metadata.delete(configSyncKey(almacenId));
        await db.sync_metadata.delete(statesSyncKey(almacenId));
      }
    );
  },

  async forceRefreshRemoteConfig(almacenId) {
    await db.sync_metadata.delete(configSyncKey(almacenId));
    await db.sync_metadata.delete(statesSyncKey(almacenId));
    return this.downloadRemoteConfig(almacenId, { fullRefresh: true });
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

  async applySettingsRealtimeChange(almacenId, payload) {
    const eventType = payload.eventType;
    const nextRow = payload.new;
    const oldRow = payload.old;

    if (eventType === 'DELETE') {
      if (oldRow?.almacen_id === almacenId) await db.almacen_configuracion.delete(almacenId);
      return;
    }

    if (nextRow?.almacen_id !== almacenId) return;

    await db.almacen_configuracion.put(nextRow);
    if (nextRow.updated_at) {
      await setSyncMetadata(configSyncKey(almacenId), nextRow.updated_at);
    }
  },

  async applyNotificationEmailRealtimeChange(almacenId, payload) {
    const eventType = payload.eventType;
    const nextRow = payload.new;
    const oldRow = payload.old;

    if (eventType === 'DELETE') {
      if (oldRow?.almacen_id === almacenId && oldRow?.id) await db.almacen_notificacion_emails.delete(oldRow.id);
      return;
    }

    if (nextRow?.almacen_id !== almacenId) return;

    await db.almacen_notificacion_emails.put(nextRow);
    if (nextRow.updated_at) {
      await setSyncMetadata(configSyncKey(almacenId), nextRow.updated_at);
    }
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

    const localCacheForOptionalTables = await readRawConfig(almacenId);

    const settingsQuery = supabase
      .from('almacen_configuracion')
      .select('*')
      .eq('almacen_id', almacenId);

    const settings = await runOptionalQuery(
      settingsQuery,
      'Descarga de configuracion',
      localCacheForOptionalTables.settings ?? []
    );

    const notificationEmailsQuery = supabase
      .from('almacen_notificacion_emails')
      .select('*')
      .eq('almacen_id', almacenId);

    const notificationEmails = await runOptionalQuery(
      notificationEmailsQuery,
      'Descarga de correos',
      localCacheForOptionalTables.notificationEmails ?? []
    );

    if (lastSyncAt) {
      await mergeRawConfig({
        modules: modules ?? [],
        shelves: shelves ?? [],
        articles: articles ?? [],
        settings: settings ?? [],
        notificationEmails: []
      });
      if (Array.isArray(notificationEmails)) {
        await db.transaction('rw', db.almacen_notificacion_emails, async () => {
          await db.almacen_notificacion_emails.where('almacen_id').equals(almacenId).delete();
          if (notificationEmails.length) await db.almacen_notificacion_emails.bulkPut(notificationEmails);
        });
      }
    } else {
      await replaceRawConfig({
        modules: modules ?? [],
        shelves: shelves ?? [],
        articles: articles ?? [],
        settings: settings ?? [],
        notificationEmails: Array.isArray(notificationEmails) ? notificationEmails : []
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

    const candidates = configRows
      .flatMap((row) => row.cubetas?.length ? row.cubetas : [row])
      .filter((cubeta) => cubeta.sku);

    const existingStates = await db.estados_baldas.bulkGet(candidates.map((cubeta) => cubeta.id));
    const existingById = new Map(
      existingStates
        .filter(Boolean)
        .map((state) => [state.id_balda, state])
    );
    const syncedAt = nowIso();
    const rows = [];

    for (const cubeta of candidates) {
      if (pendingStateIds.has(cubeta.id)) continue;

      const existing = existingById.get(cubeta.id);
      const remoteUpdatedAt = cubeta.estado_updated_at || null;

      if (existing) {
        const localUpdatedAt = existing.updated_at || '';
        const remoteIsAuthoritative = remoteUpdatedAt && String(remoteUpdatedAt) > String(localUpdatedAt);

        if (!remoteIsAuthoritative) continue;
      }

      rows.push({
        id_balda: cubeta.id,
        estado: cubeta.estado || SHELF_STATES.FULL,
        updated_at: remoteUpdatedAt || cubeta.updated_at || syncedAt,
        synced_at: syncedAt,
        articulo_id: cubeta.articulo_id ?? null,
        sku: cubeta.sku ?? null
      });
    }

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

    await ledService.syncShelvesByIds([idBalda]).catch((error) => {
      console.warn('No se pudo actualizar LED fisico', error);
    });
  },

  async updateManyShelfStates(items) {
    await upsertShelfStates(items);
    await ledService.syncShelvesByIds(items.map((item) => item.id_balda)).catch((error) => {
      console.warn('No se pudieron actualizar LEDs fisicos', error);
    });
  },

  async markPedidoRowsQueuedLocally(rows) {
    const orderedRows = rows
      .filter((row) => row.id_balda)
      .map((row) => ({
        id_balda: row.id_balda,
        estado: SHELF_STATES.ORDERED,
        updated_at: nowIso(),
        synced_at: null,
        pending_sync: true,
        pending_reason: 'pedido.email'
      }));

    if (!orderedRows.length) return 0;

    await db.estados_baldas.bulkPut(orderedRows);
    await ledService.syncShelvesByIds(orderedRows.map((row) => row.id_balda)).catch((error) => {
      console.warn('No se pudieron actualizar LEDs fisicos del pedido en cola', error);
    });

    return orderedRows.length;
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

  async sendPedidoNow({ rows, warehouse, operator }) {
    if (!rows.length) return { sent: false, reason: 'empty' };
    if (!navigator.onLine) throw new Error('Sin conexion: no se pudo enviar el correo de reposicion');

    const pedidoId = makeUniquePedidoId(rows, warehouse);
    const emailResult = await withTimeout(
      sendPedidoEmail({
        rows,
        warehouse,
        operator,
        pedidoId
      }),
      'Envio de correo de pedido',
      EMAIL_SEND_TIMEOUT_MS
    );

    if (!emailResult?.sent) {
      throw new Error(emailResult?.reason || 'El correo de reposicion no fue confirmado');
    }

    const orderedRows = rows
      .filter((row) => row.id_balda)
      .map((row) => ({
        id_balda: row.id_balda,
        estado: SHELF_STATES.ORDERED,
        updated_at: nowIso()
      }));

    if (orderedRows.length) {
      await this.updateManyShelfStates(orderedRows);
      try {
        await this.flushPendingQueue();
      } catch (error) {
        console.warn('El correo fue enviado, pero quedo pendiente sincronizar estados', error);
      }
    }

    return { ...emailResult, pedido_id: pedidoId, ordered: orderedRows.length };
  },

  async markPedidoRowsSynced(rows) {
    const orderedRows = rows
      .filter((row) => row.id_balda)
      .map((row) => ({
        id_balda: row.id_balda,
        estado: SHELF_STATES.ORDERED,
        updated_at: nowIso()
      }));

    if (!orderedRows.length) return 0;

    const syncedAt = nowIso();
    const queueStateItems = orderedRows.map((row) => makeQueueStateItem(row, row.updated_at));

    await db.estados_baldas.bulkPut(
      orderedRows.map((row) => ({
        id_balda: row.id_balda,
        estado: row.estado,
        updated_at: row.updated_at,
        synced_at: null
      }))
    );

    try {
      const syncedStateItems = await this.syncStateItemsToArticles(queueStateItems);
      await db.estados_baldas.bulkPut(
        syncedStateItems.map((stateItem) => ({
          id_balda: stateItem.payload.id_balda,
          estado: stateItem.payload.estado,
          updated_at: stateItem.payload.updated_at,
          synced_at: syncedAt
        }))
      );
    } catch (error) {
      for (const stateItem of queueStateItems) {
        await this.enqueue(stateItem);
      }
    }

    await ledService.syncShelvesByIds(orderedRows.map((row) => row.id_balda)).catch((error) => {
      console.warn('No se pudieron actualizar LEDs fisicos tras pedido', error);
    });

    return orderedRows.length;
  },

  async discardPendingPedidoEmails() {
    const items = await db.cola_sincronizacion
      .where('tipo')
      .equals('pedido.email')
      .toArray();

    if (items.length) {
      await db.cola_sincronizacion.bulkDelete(items.map((item) => item.id));
    }

    return items.length;
  },

  async enqueuePedidoEmail({ rows, warehouse, operator, reason = 'offline' }) {
    if (!rows.length) return null;

    const createdAt = nowIso();
    const entityId = makePedidoEntityId(rows, warehouse);
    const payload = {
      rows,
      warehouse,
      operator,
      reason,
      pedido_id: entityId,
      created_at: createdAt
    };

    const existing = await db.cola_sincronizacion
      .where('entity_id')
      .equals(entityId)
      .and((item) => item.tipo === 'pedido.email')
      .first();

    if (existing) {
      if (existing.payload?.email_sent_at) return existing.id;
      if (
        ['sending', 'processing'].includes(existing.payload?.email_status)
        && isFreshIso(existing.payload?.email_started_at, EMAIL_SENDING_STALE_MS)
      ) {
        return existing.id;
      }

      return db.cola_sincronizacion.update(existing.id, {
        payload: {
          ...existing.payload,
          ...payload
        },
        attempts: 0,
        created_at: existing.created_at || createdAt,
        last_error: null
      });
    }

    return this.enqueue({
      tipo: 'pedido.email',
      entity_id: entityId,
      created_at: createdAt,
      payload
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

  buildPedidoBatch(pedidoEmailItems) {
    const rowsByBalda = new Map();
    let warehouse = null;
    let operator = null;
    const itemIds = [];

    for (const item of pedidoEmailItems) {
      const payload = item.payload || {};
      if (payload.email_sent_at) continue;
      if (
        ['sending', 'processing'].includes(payload.email_status)
        && isFreshIso(payload.email_started_at, EMAIL_SENDING_STALE_MS)
      ) {
        continue;
      }

      itemIds.push(item.id);
      warehouse = warehouse || payload.warehouse;
      operator = operator || payload.operator;

      for (const row of payload.rows || []) {
        const key = String(row.id_balda || row.sku || row.codigo_articulo || '').trim();
        if (!key || rowsByBalda.has(key)) continue;
        rowsByBalda.set(key, row);
      }
    }

    return {
      itemIds,
      rows: Array.from(rowsByBalda.values()),
      warehouse,
      operator
    };
  },

  async syncPedidoEmailBatch(pedidoEmailItems) {
    const batch = this.buildPedidoBatch(pedidoEmailItems);
    if (!batch.itemIds.length || !batch.rows.length) return { synced: 0 };

    const startedAt = nowIso();
    await db.transaction('rw', db.cola_sincronizacion, async () => {
      for (const itemId of batch.itemIds) {
        const item = await db.cola_sincronizacion.get(itemId);
        if (!item) continue;
        await db.cola_sincronizacion.update(itemId, {
          payload: {
            ...(item.payload || {}),
            email_status: 'sending',
            email_started_at: startedAt
          },
          next_retry_at: addMsIso(EMAIL_SENDING_STALE_MS),
          last_error: null
        });
      }
    });

    const pedidoId = makePedidoEntityId(batch.rows, batch.warehouse);
    const emailResult = await withTimeout(
      sendPedidoEmail({
        rows: batch.rows,
        warehouse: batch.warehouse,
        operator: batch.operator,
        pedidoId
      }),
      'Envio batch de correo de pedido',
      EMAIL_SEND_TIMEOUT_MS
    );

    if (!emailResult?.sent) {
      throw new Error(emailResult?.reason || 'El correo de reposicion no fue confirmado');
    }

    await this.markPedidoRowsSynced(batch.rows);
    await db.cola_sincronizacion.bulkDelete(batch.itemIds);

    return {
      synced: batch.itemIds.length,
      sent: true,
      rows: batch.rows.length,
      pedido_id: pedidoId
    };
  },

  async flushPendingQueue({ limit = SYNC_BATCH_SIZE } = {}) {
    if (pendingQueueFlushPromise) return pendingQueueFlushPromise;

    pendingQueueFlushPromise = this.flushPendingQueueUnlocked({ limit }).finally(() => {
      pendingQueueFlushPromise = null;
    });

    return pendingQueueFlushPromise;
  },

  async flushPendingQueueUnlocked({ limit = SYNC_BATCH_SIZE } = {}) {
    if (!navigator.onLine) return { synced: 0, skipped: 'offline' };

    const items = (await db.cola_sincronizacion.orderBy('created_at').limit(limit).toArray())
      .filter((item) => isPastIso(item.next_retry_at));
    let synced = 0;
    const pedidoEmailItems = items.filter((item) => item.tipo === 'pedido.email');
    const stateItems = items.filter((item) => item.tipo === 'estado_balda.updated');
    const otherItems = items.filter((item) => item.tipo !== 'estado_balda.updated' && item.tipo !== 'pedido.email');

    if (pedidoEmailItems.length) {
      try {
        const result = await this.syncPedidoEmailBatch(pedidoEmailItems);
        synced += result.synced || 0;
      } catch (error) {
        await db.transaction('rw', db.cola_sincronizacion, async () => {
          await Promise.allSettled(
            pedidoEmailItems.map((item) => db.cola_sincronizacion.update(item.id, {
              attempts: (item.attempts ?? 0) + 1,
              last_error: errorMessage(error),
              next_retry_at: addMsIso(EMAIL_RETRY_DELAY_MS),
              payload: {
                ...(item.payload || {}),
                email_status: 'queued',
                email_started_at: null
              }
            }))
          );
        });
      }
    }

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
        const result = await this.syncQueueItem(item);
        if (result?.keep) {
          continue;
        }
        await db.cola_sincronizacion.delete(item.id);
        synced += 1;
      } catch (error) {
        await db.cola_sincronizacion.update(item.id, {
          attempts: (item.attempts ?? 0) + 1,
          last_error: errorMessage(error),
          next_retry_at: addMsIso(EMAIL_RETRY_DELAY_MS)
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
      const rows = payload.rows || [];
      const pedidoId = payload.pedido_id || item.entity_id;

      if (
        ['sending', 'processing'].includes(payload.email_status)
        && isFreshIso(payload.email_started_at, EMAIL_SENDING_STALE_MS)
      ) {
        return { keep: true, reason: 'email_already_processing' };
      }

      if (!payload.email_sent_at) {
        const startedAt = nowIso();
        await db.cola_sincronizacion.update(item.id, {
          payload: {
            ...payload,
            email_status: 'sending',
            email_started_at: startedAt
          },
          next_retry_at: addMsIso(EMAIL_SENDING_STALE_MS)
        });

        const emailResult = await withTimeout(
          sendPedidoEmail({
            rows,
            warehouse: payload.warehouse,
            operator: payload.operator,
            pedidoId
          }),
          'Envio de correo de pedido',
          EMAIL_SEND_TIMEOUT_MS
        );

        if (emailResult?.processing) {
          await db.cola_sincronizacion.update(item.id, {
            payload: {
              ...payload,
              email_status: 'processing',
              email_started_at: startedAt,
              email_result: emailResult
            },
            last_error: null,
            next_retry_at: addMsIso(EMAIL_RETRY_DELAY_MS)
          });
          return { keep: true, reason: 'email_processing' };
        }

        await db.cola_sincronizacion.update(item.id, {
          payload: {
            ...payload,
            email_status: 'sent',
            email_sent_at: nowIso(),
            email_result: emailResult
          },
          attempts: 0,
          last_error: null,
          next_retry_at: null
        });
      }

      const orderedRows = rows
        .filter((row) => row.id_balda)
        .map((row) => ({
          id_balda: row.id_balda,
          estado: SHELF_STATES.ORDERED,
          updated_at: nowIso()
        }));

      if (orderedRows.length) {
        await this.markPedidoRowsSynced(orderedRows);
      }
      return;
    }

    throw new Error(`Tipo de cola no soportado: ${item.tipo}`);
  }
};
