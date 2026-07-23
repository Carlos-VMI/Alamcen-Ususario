import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StatusIndicator } from './components/StatusIndicator';
import { WarehouseView } from './components/WarehouseView';
import { useLiveQuery } from './hooks/useLiveQuery';
import { useSyncManager } from './hooks/useSyncManager';
import { db } from './lib/db';
import { buildPedidoRows, sendPedidoEmail } from './lib/orderService';
import { syncService } from './lib/syncService';
import { supabase } from './lib/supabaseClient';
import './styles/app.css';

const ACTIVE_WAREHOUSE_KEY = 'almacen_id_activo';
const ACTIVE_WAREHOUSE_META_KEY = 'almacen_activo_meta';
const ACTIVE_OPERATOR_KEY = 'almacen_operario_activo';

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
  return null;
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
  await db.transaction('rw', db.estanterias_config, db.estados_baldas, db.cola_sincronizacion, async () => {
    await db.estanterias_config.clear();
    await db.estados_baldas.clear();
    await db.cola_sincronizacion.clear();
  });
}

async function persistSession({ operator, warehouse }) {
  const currentWarehouseId = getStoredAlmacenId();
  const meta = makeWarehouseMeta(warehouse);

  if (currentWarehouseId && currentWarehouseId !== meta.id) {
    await clearLocalWarehouseData();
  }

  window.localStorage.setItem(ACTIVE_WAREHOUSE_KEY, meta.id);
  window.localStorage.setItem(ACTIVE_WAREHOUSE_META_KEY, JSON.stringify(meta));

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
  const [pedidoSending, setPedidoSending] = useState(false);
  const [pedidoError, setPedidoError] = useState('');
  const config = useLiveQuery(() => db.estanterias_config.toArray(), [], []);
  const estados = useLiveQuery(() => db.estados_baldas.toArray(), [], []);
  const sync = useSyncManager(almacenId);
  const estadosById = useMemo(() => new Map(estados.map((estado) => [estado.id_balda, estado.estado])), [estados]);
  const pendingOrderCount = useMemo(() => (
    config
      .flatMap((shelf) => shelf.cubetas?.length ? shelf.cubetas : [shelf])
      .filter((cubeta) => cubeta.sku && estadosById.get(cubeta.id) === 'vacio')
      .length
  ), [config, estadosById]);

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
    if (viewMode !== 'estado' || pedidoSending) return;

    setPedidoError('');
    setPedidoSending(true);
    try {
      const rows = buildPedidoRows(config, estadosById);
      await sendPedidoEmail({ rows, warehouse: warehouseMeta, operator });
      await syncService.markEmptyShelvesAsOrdered(config, estadosById);
    } catch (error) {
      setPedidoError(error?.message || 'Error enviando pedido');
    } finally {
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
        <div>
          <h1>{warehouseMeta?.nombre || 'Almacen Operario'}</h1>
          <p>
            {warehouseMeta?.ubicacion ? `${warehouseMeta.ubicacion} - ` : ''}
            {operator.nombre} - {roleLabel(operator.rol)}
          </p>
        </div>
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
          <StatusIndicator {...sync} />
          <button className="logout-button" type="button" onClick={() => setLogoutOpen(true)}>
            Salir
          </button>
        </div>
      </header>

      <main>
        {pedidoError ? <div className="top-error">{pedidoError}</div> : null}
        <WarehouseView config={config} estados={estados} operatorRole={operator.rol} viewMode={viewMode} />
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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
