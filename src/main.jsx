import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { LedControlPanel } from './components/LedControlPanel';
import { PickToLightControls } from './components/PickToLightControls';
import { StatusIndicator } from './components/StatusIndicator';
import { WarehouseView } from './components/WarehouseView';
import { useSupabaseSync } from './hooks/useSupabaseSync';
import { useSyncManager } from './hooks/useSyncManager';
import { db } from './lib/db';
import { ledService } from './lib/ledService';
import { buildPedidoRows } from './lib/orderService';
import { syncService } from './lib/syncService';
import { supabase } from './lib/supabaseClient';
import './styles/app.css';

console.log('[main.jsx] bundle cargado', {
  hasRoot: Boolean(document.getElementById('root')),
  supabaseReady: Boolean(supabase),
  syncServiceReady: Boolean(syncService)
});

const ACTIVE_WAREHOUSE_KEY = 'almacen_id_activo';
const ACTIVE_WAREHOUSE_META_KEY = 'almacen_activo_meta';
const ACTIVE_OPERATOR_KEY = 'almacen_operario_activo';

function isNetworkFailure(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('load failed')
    || message.includes('network request failed');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2
    },
    mutations: {
      retry: 3
    }
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(console.error);
  });
}

function readJsonStorage(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function getStoredAlmacenId() {
  return window.localStorage.getItem(ACTIVE_WAREHOUSE_KEY);
}

function getStoredWarehouseMeta() {
  return readJsonStorage(ACTIVE_WAREHOUSE_META_KEY);
}

function getStoredOperator() {
  return readJsonStorage(ACTIVE_OPERATOR_KEY);
}

function normalizeRole(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'admin' || value === 'administrador') return 'administrador';
  if (value === 'repositor') return 'repositor';
  return 'operario';
}

function roleLabel(role) {
  const normalized = normalizeRole(role);
  if (normalized === 'administrador') return 'Administrador';
  if (normalized === 'repositor') return 'Repositor';
  return 'Operario';
}

function formatWarehouseLabel(almacen) {
  const nombre = almacen.nombre || 'Almacen sin nombre';
  const ubicacion = almacen.ubicacion || almacen.location || '';
  return ubicacion ? `${nombre} (${ubicacion})` : nombre;
}

function makeWarehouseMeta(warehouse) {
  return {
    id: warehouse.id,
    nombre: warehouse.nombre || 'Almacen',
    ubicacion: warehouse.ubicacion || warehouse.location || ''
  };
}

async function clearLocalWarehouseData() {
  await db.transaction(
    'rw',
    db.estanterias_config,
    db.estados_baldas,
    db.cola_sincronizacion,
    db.almacen_modulos,
    db.almacen_estantes,
    db.almacen_articulos,
    db.almacen_configuracion,
    db.almacen_notificacion_emails,
    db.sync_metadata,
    db.led_mappings,
    async () => {
      await db.estanterias_config.clear();
      await db.estados_baldas.clear();
      await db.cola_sincronizacion.clear();
      await db.almacen_modulos.clear();
      await db.almacen_estantes.clear();
      await db.almacen_articulos.clear();
      await db.almacen_configuracion.clear();
      await db.almacen_notificacion_emails.clear();
      await db.sync_metadata.clear();
      await db.led_mappings.clear();
    }
  );
}

async function persistSession({ operator, warehouse }) {
  const currentWarehouseId = getStoredAlmacenId();
  const meta = makeWarehouseMeta(warehouse);

  if (currentWarehouseId && currentWarehouseId !== meta.id) {
    await clearLocalWarehouseData();
  }

  window.localStorage.setItem(ACTIVE_WAREHOUSE_KEY, meta.id);
  window.localStorage.setItem(ACTIVE_WAREHOUSE_META_KEY, JSON.stringify(meta));
  window.localStorage.setItem(ACTIVE_OPERATOR_KEY, JSON.stringify({
    id: operator.id,
    almacen_id: operator.almacen_id,
    nombre: operator.nombre,
    rol: normalizeRole(operator.rol)
  }));

  return meta;
}

function useActiveOperatorsQuery() {
  return useQuery({
    queryKey: ['active-local-operators'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('almacen_operadores')
        .select('*')
        .eq('activo', true)
        .order('nombre', { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
    staleTime: 30000,
    refetchOnWindowFocus: true
  });
}

function useWarehousesQuery(enabled = true) {
  return useQuery({
    queryKey: ['almacen_bases'],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('almacen_bases')
        .select('*')
        .order('nombre', { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true
  });
}

function LoginScreen({ onLoggedIn }) {
  const [selectedId, setSelectedId] = useState('');
  const [pin, setPin] = useState('');
  const [loginError, setLoginError] = useState('');
  const operatorsQuery = useActiveOperatorsQuery();
  const operators = operatorsQuery.data ?? [];
  const selectedOperator = operators.find((operator) => operator.id === selectedId);

  const handleLogin = async () => {
    setLoginError('');

    if (!selectedOperator) {
      setLoginError('Selecciona un usuario.');
      return;
    }

    if (String(selectedOperator.pin ?? '') !== pin.trim()) {
      setLoginError('PIN incorrecto.');
      return;
    }

    const operator = {
      id: selectedOperator.id,
      almacen_id: selectedOperator.almacen_id,
      nombre: selectedOperator.nombre,
      rol: normalizeRole(selectedOperator.rol)
    };

    if (operator.rol === 'administrador') {
      onLoggedIn({ operator, needsWarehouseSelection: true });
      return;
    }

    if (!operator.almacen_id) {
      setLoginError('Este usuario no tiene almacen asignado.');
      return;
    }

    const { data: warehouse, error } = await supabase
      .from('almacen_bases')
      .select('*')
      .eq('id', operator.almacen_id)
      .maybeSingle();

    if (error || !warehouse) {
      setLoginError(error?.message || 'No se pudo cargar el almacen asignado.');
      return;
    }

    const warehouseMeta = await persistSession({ operator, warehouse });
    onLoggedIn({ operator, warehouseMeta, needsWarehouseSelection: false });
  };

  return (
    <main className="setup-screen">
      <section className="setup-card" aria-labelledby="login-title">
        <div className="setup-logo" aria-hidden="true">
          <span />
        </div>
        <h1 id="login-title">Bienvenido</h1>
        <p>Identificate con tu usuario local y PIN.</p>

        {operatorsQuery.isLoading ? <div className="setup-message">Cargando usuarios...</div> : null}
        {operatorsQuery.isError ? <div className="setup-error">No se pudieron cargar los usuarios locales.</div> : null}
        {!operatorsQuery.isLoading && !operatorsQuery.isError && operators.length === 0 ? (
          <div className="setup-message">No hay usuarios activos configurados.</div>
        ) : null}

        {operators.length ? (
          <>
            <label className="setup-label" htmlFor="operator-selector">
              Usuario
            </label>
            <select
              id="operator-selector"
              className="setup-select"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">Seleccionar...</option>
              {operators.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.nombre} - {roleLabel(operator.rol)}
                </option>
              ))}
            </select>
            <label className="setup-label" htmlFor="operator-pin">
              PIN
            </label>
            <input
              id="operator-pin"
              className="setup-input"
              inputMode="numeric"
              type="password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              placeholder="PIN"
            />
            <button className="setup-button" type="button" onClick={handleLogin}>
              Ingresar
            </button>
          </>
        ) : null}

        {loginError ? <div className="setup-error">{loginError}</div> : null}
      </section>
    </main>
  );
}

function AdminWarehouseSelector({ operator, onSelected }) {
  const [selectedId, setSelectedId] = useState('');
  const [selectError, setSelectError] = useState('');
  const warehousesQuery = useWarehousesQuery(true);
  const warehouses = warehousesQuery.data ?? [];
  const selectedWarehouse = useMemo(
    () => warehouses.find((warehouse) => warehouse.id === selectedId),
    [warehouses, selectedId]
  );

  const handleConfirm = async () => {
    setSelectError('');

    if (!selectedWarehouse) {
      setSelectError('Selecciona un almacen para continuar.');
      return;
    }

    const warehouseMeta = await persistSession({ operator, warehouse: selectedWarehouse });
    onSelected({ operator, warehouseMeta });
  };

  return (
    <main className="setup-screen">
      <section className="setup-card" aria-labelledby="warehouse-title">
        <div className="setup-logo" aria-hidden="true">
          <span />
        </div>
        <h1 id="warehouse-title">Seleccionar almacen</h1>
        <p>{operator.nombre} - Administrador</p>

        {warehousesQuery.isLoading ? <div className="setup-message">Cargando almacenes...</div> : null}
        {warehousesQuery.isError ? (
          <div className="setup-error">No se pudieron cargar los almacenes desde almacen_bases.</div>
        ) : null}
        {!warehousesQuery.isLoading && !warehousesQuery.isError && warehouses.length === 0 ? (
          <div className="setup-message">No hay almacenes creados en Supabase.</div>
        ) : null}

        {warehouses.length ? (
          <>
            <label className="setup-label" htmlFor="warehouse-selector">
              Almacen
            </label>
            <select
              id="warehouse-selector"
              className="setup-select"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">Seleccionar...</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {formatWarehouseLabel(warehouse)}
                </option>
              ))}
            </select>
            <button className="setup-button" type="button" onClick={handleConfirm}>
              Entrar
            </button>
          </>
        ) : null}

        {selectError ? <div className="setup-error">{selectError}</div> : null}
      </section>
    </main>
  );
}

function ProtectedLogout({ onClose, onLogout }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const adminsQuery = useActiveOperatorsQuery();
  const admins = (adminsQuery.data ?? []).filter((operator) => normalizeRole(operator.rol) === 'administrador');

  const handleConfirm = async () => {
    setError('');

    const validAdmin = admins.find((operator) => String(operator.pin ?? '') === pin.trim());
    if (!validAdmin) {
      setError('PIN de administrador incorrecto.');
      return;
    }

    window.localStorage.removeItem(ACTIVE_OPERATOR_KEY);
    await onLogout();
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="logout-dialog" role="dialog" aria-modal="true" aria-labelledby="logout-title">
        <h2 id="logout-title">Cerrar sesion</h2>
        <p>Ingresa un PIN de administrador para salir de esta vista.</p>

        {adminsQuery.isLoading ? <div className="setup-message">Validando administradores...</div> : null}
        {adminsQuery.isError ? <div className="setup-error">No se pudieron cargar administradores.</div> : null}

        <label className="setup-label" htmlFor="logout-pin">
          PIN administrador
        </label>
        <input
          id="logout-pin"
          className="setup-input"
          inputMode="numeric"
          type="password"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          placeholder="PIN"
        />

        {error ? <div className="setup-error">{error}</div> : null}

        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="danger-button" type="button" onClick={handleConfirm}>
            Salir
          </button>
        </div>
      </section>
    </div>
  );
}

function App() {
  const [almacenId, setAlmacenId] = useState(() => getStoredAlmacenId());
  const [warehouseMeta, setWarehouseMeta] = useState(() => getStoredWarehouseMeta());
  const [operator, setOperator] = useState(() => getStoredOperator());
  const [pendingAdminOperator, setPendingAdminOperator] = useState(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [viewMode, setViewMode] = useState('estado');
  const [pickLightStates, setPickLightStates] = useState({});
  const [pedidoSending, setPedidoSending] = useState(false);
  const [pedidoError, setPedidoError] = useState('');
  const realtimeAlmacenRef = useRef(null);
  const pedidoActionLockRef = useRef(false);
  const config = useLiveQuery(() => db.estanterias_config.toArray(), [], []);
  const estados = useLiveQuery(() => db.estados_baldas.toArray(), [], []);
  const queuedPedidos = useLiveQuery(
    () => db.cola_sincronizacion.where('tipo').equals('pedido.email').toArray(),
    [],
    []
  );
  const sync = useSyncManager(almacenId);
  const supabaseSync = useSupabaseSync(almacenId);
  const handleManualSync = useCallback(async () => {
    await sync.forceSync();
    await supabaseSync.forceFullRefresh();
  }, [sync.forceSync, supabaseSync.forceFullRefresh]);
  const combinedSync = useMemo(() => ({
    online: sync.online,
    pendingCount: sync.pendingCount,
    syncNow: sync.syncNow,
    isSyncing: sync.isSyncing || supabaseSync.isInitializing || supabaseSync.isRealtimeSyncing,
    lastSyncError: sync.lastSyncError || supabaseSync.lastError,
    lastSuccessfulSyncAt: supabaseSync.lastSyncedAt || sync.lastSuccessfulSyncAt,
    configLoading: sync.configLoading || supabaseSync.isInitializing,
    forceSync: handleManualSync
  }), [
    handleManualSync,
    sync.online,
    sync.pendingCount,
    sync.syncNow,
    sync.isSyncing,
    sync.lastSyncError,
    sync.lastSuccessfulSyncAt,
    sync.configLoading,
    supabaseSync.isInitializing,
    supabaseSync.isRealtimeSyncing,
    supabaseSync.lastError,
    supabaseSync.lastSyncedAt
  ]);
  const estadosById = useMemo(() => new Map(estados.map((estado) => [estado.id_balda, estado.estado])), [estados]);
  const pendingOrderCount = useMemo(() => (
    config
      .flatMap((shelf) => shelf.cubetas?.length ? shelf.cubetas : [shelf])
      .filter((cubeta) => cubeta.sku && estadosById.get(cubeta.id) === 'vacio')
      .length
  ), [config, estadosById]);
  const pendingPedidoCount = queuedPedidos.length;

  useEffect(() => {
    console.log('[Realtime useEffect] disparado', { almacenId });

    if (!almacenId) {
      console.warn('[Realtime useEffect] bloqueado: almacenId vacio o no inicializado');
      realtimeAlmacenRef.current = null;
      return undefined;
    }

    if (realtimeAlmacenRef.current === almacenId) {
      console.log('[Realtime useEffect] suscripcion ya activa para este almacen', { almacenId });
      return undefined;
    }

    realtimeAlmacenRef.current = almacenId;
    console.log('⚡ Conectando sincronización específica con Supabase...');

    const applyArticleChange = async (payload) => {
      try {
        await syncService.applyArticleRealtimeChange(almacenId, payload);
      } catch (error) {
        console.error('Error aplicando cambio realtime de articulos', error);
      }
    };

    const applyModuleChange = async (payload) => {
      try {
        await syncService.applyModuleRealtimeChange(almacenId, payload);
      } catch (error) {
        console.error('Error aplicando cambio realtime de modulos', error);
      }
    };

    const applyShelfChange = async (payload) => {
      try {
        await syncService.applyShelfRealtimeChange(almacenId, payload);
      } catch (error) {
        console.error('Error aplicando cambio realtime de estantes', error);
      }
    };

    const applySettingsChange = async (payload) => {
      try {
        await syncService.applySettingsRealtimeChange(almacenId, payload);
      } catch (error) {
        console.error('Error aplicando cambio realtime de configuracion', error);
      }
    };

    const applyNotificationEmailChange = async (payload) => {
      try {
        await syncService.applyNotificationEmailRealtimeChange(almacenId, payload);
      } catch (error) {
        console.error('Error aplicando cambio realtime de correos', error);
      }
    };

    const channel = supabase
      .channel('sync-almacen-original')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'almacen_articulos' }, applyArticleChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'almacen_modulos' }, applyModuleChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'almacen_estantes' }, applyShelfChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'almacen_configuracion' }, applySettingsChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'almacen_notificacion_emails' }, applyNotificationEmailChange)
      .subscribe((status) => {
        console.log('📡 Estado de Supabase Realtime:', status);
      });

    return () => {
      realtimeAlmacenRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [almacenId]);

  useEffect(() => {
    if (!almacenId || !estados.length) return undefined;

    const timeoutId = window.setTimeout(() => {
      ledService.syncAllFromLocal().catch((error) => {
        console.warn('No se pudieron sincronizar LEDs desde Dexie', error);
      });
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [almacenId, estados]);

  useEffect(() => {
    if (!almacenId) return undefined;

    const timeoutId = window.setTimeout(() => {
      ledService.syncPickLightStates(pickLightStates).catch((error) => {
        console.warn('No se pudieron sincronizar luces de busqueda', error);
      });
    }, 120);

    return () => window.clearTimeout(timeoutId);
  }, [almacenId, pickLightStates]);

  const handleLoggedIn = ({ operator: nextOperator, warehouseMeta: nextWarehouseMeta, needsWarehouseSelection }) => {
    if (needsWarehouseSelection) {
      setPendingAdminOperator(nextOperator);
      return;
    }

    setOperator(nextOperator);
    setWarehouseMeta(nextWarehouseMeta);
    setAlmacenId(nextWarehouseMeta.id);
  };

  const handleAdminWarehouseSelected = ({ operator: nextOperator, warehouseMeta: nextWarehouseMeta }) => {
    setPendingAdminOperator(null);
    setOperator(nextOperator);
    setWarehouseMeta(nextWarehouseMeta);
    setAlmacenId(nextWarehouseMeta.id);
  };

  const handleLogout = async () => {
    setLogoutOpen(false);
    setOperator(null);
    setPendingAdminOperator(null);
  };

  const handlePedido = async () => {
    if (viewMode !== 'estado' || pedidoSending || pedidoActionLockRef.current) return;

    pedidoActionLockRef.current = true;
    setPedidoError('');
    setPedidoSending(true);
    const rows = buildPedidoRows(config, estadosById);

    try {
      if (!rows.length) return;

      if (!combinedSync.online) {
        setPedidoError('Sin conexion. El pedido no se envio.');
        return;
      }

      await syncService.discardPendingPedidoEmails();
      await syncService.sendPedidoNow({
        rows,
        warehouse: warehouseMeta,
        operator
      });
    } catch (error) {
      setPedidoError(
        isNetworkFailure(error)
          ? 'No se pudo conectar con el servicio de correo. Revisa internet y la URL de Apps Script.'
          : error?.message || 'Error enviando pedido'
      );
    } finally {
      pedidoActionLockRef.current = false;
      setPedidoSending(false);
    }
  };

  if (!operator && !pendingAdminOperator) {
    return <LoginScreen onLoggedIn={handleLoggedIn} />;
  }

  if (pendingAdminOperator && !operator) {
    return (
      <AdminWarehouseSelector
        operator={pendingAdminOperator}
        onSelected={handleAdminWarehouseSelected}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>{warehouseMeta?.nombre || 'Almacén Madrid'}</h1>
        <button className="logout-button" type="button" onClick={() => setLogoutOpen(true)}>
          Salir
        </button>
        <StatusIndicator {...combinedSync} onSyncClick={combinedSync.forceSync} />
        <div className="header-spacer" />
        <button
          className="pedido-button"
          type="button"
          onClick={handlePedido}
          disabled={viewMode !== 'estado' || pendingOrderCount === 0 || pedidoSending}
          title={viewMode !== 'estado' ? 'Disponible solo en Estado' : undefined}
        >
          {pedidoSending ? 'Enviando' : 'Pedido'}
          {pendingOrderCount > 0 ? <span>{pendingOrderCount}</span> : null}
        </button>
        <div className="app-header-actions">
          <div className="view-toggle" role="group" aria-label="Vista">
            <button
              className={viewMode === 'estado' ? 'active' : ''}
              type="button"
              onClick={() => setViewMode('estado')}
            >
              Estado
            </button>
            <button
              className={viewMode === 'items' ? 'active' : ''}
              type="button"
              onClick={() => setViewMode('items')}
            >
              Items
            </button>
          </div>
          <LedControlPanel userRole={operator?.rol} />
        </div>
        <div className="header-search-spacer" />
        <PickToLightControls
          config={config}
          onLightStatesChange={setPickLightStates}
        />
      </header>

      <main>
        {pedidoError ? <div className="top-error">{pedidoError}</div> : null}
        {combinedSync.configLoading && config.length === 0 ? (
          <section className="empty-state">
            <h2>Cargando configuracion...</h2>
            <p>Descargando modulos, estantes y articulos desde Supabase.</p>
          </section>
        ) : (
          <WarehouseView
            config={config}
            estados={estados}
            operatorRole={operator.rol}
            viewMode={viewMode}
            pickLightStates={pickLightStates}
          />
        )}
      </main>

      {logoutOpen ? (
        <ProtectedLogout
          onClose={() => setLogoutOpen(false)}
          onLogout={handleLogout}
        />
      ) : null}

    </div>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  console.error('[main.jsx] no se encontro el contenedor #root; React no puede montar la app');
} else {
  console.log('[main.jsx] montando React');
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>
  );
}
