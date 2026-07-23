import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StatusIndicator } from './components/StatusIndicator';
import { WarehouseView } from './components/WarehouseView';
import { useLiveQuery } from './hooks/useLiveQuery';
import { useSyncManager } from './hooks/useSyncManager';
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

function getStoredAlmacenId() {
  return window.localStorage.getItem(ACTIVE_WAREHOUSE_KEY);
}

function getStoredWarehouseMeta() {
  try {
    return JSON.parse(window.localStorage.getItem(ACTIVE_WAREHOUSE_META_KEY) || 'null');
  } catch {
    return null;
  }
}

function getStoredOperator() {
  try {
    return JSON.parse(window.localStorage.getItem(ACTIVE_OPERATOR_KEY) || 'null');
  } catch {
    return null;
  }
}

function normalizeRole(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'admin' || value === 'administrador') return 'administrador';
  if (value === 'repositor') return 'repositor';
  return 'operario';
}

function formatWarehouseLabel(almacen) {
  const nombre = almacen.nombre || 'Almacen sin nombre';
  const ubicacion = almacen.ubicacion || almacen.location || '';
  return ubicacion ? `${nombre} (${ubicacion})` : nombre;
}

function AlmacenSelector({ onSelected }) {
  const [selectedId, setSelectedId] = useState('');
  const [adminPin, setAdminPin] = useState('');
  const [saveError, setSaveError] = useState('');

  const almacenesQuery = useQuery({
    queryKey: ['almacen_bases'],
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

  const almacenes = almacenesQuery.data ?? [];
  const selectedWarehouse = useMemo(
    () => almacenes.find((almacen) => almacen.id === selectedId),
    [almacenes, selectedId]
  );

  const handleConfirm = async () => {
    setSaveError('');

    if (!selectedWarehouse) {
      setSaveError('Selecciona un almacen para continuar.');
      return;
    }

    if (!adminPin.trim()) {
      setSaveError('Ingresa el PIN de administrador.');
      return;
    }

    const { data: admins, error } = await supabase
      .from('almacen_operadores')
      .select('*')
      .eq('activo', true);

    if (error) {
      setSaveError(`No se pudo validar el administrador: ${error.message}`);
      return;
    }

    const admin = (admins ?? []).find((operator) => (
      normalizeRole(operator.rol) === 'administrador' && String(operator.pin ?? '') === adminPin.trim()
    ));

    if (!admin) {
      setSaveError('PIN de administrador incorrecto.');
      return;
    }

    const meta = {
      id: selectedWarehouse.id,
      nombre: selectedWarehouse.nombre || 'Almacen',
      ubicacion: selectedWarehouse.ubicacion || selectedWarehouse.location || ''
    };

    window.localStorage.setItem(ACTIVE_WAREHOUSE_KEY, selectedWarehouse.id);
    window.localStorage.setItem(ACTIVE_WAREHOUSE_META_KEY, JSON.stringify(meta));
    window.localStorage.removeItem(ACTIVE_OPERATOR_KEY);
    onSelected(meta);
  };

  return (
    <main className="setup-screen">
      <section className="setup-card" aria-labelledby="setup-title">
        <div className="setup-logo" aria-hidden="true">
          <span />
        </div>
        <h1 id="setup-title">Seleccionar almacen</h1>
        <p>Elige el almacen que quedara asociado a esta tablet o PC.</p>

        {almacenesQuery.isLoading ? (
          <div className="setup-message">Cargando almacenes...</div>
        ) : null}

        {almacenesQuery.isError ? (
          <div className="setup-error">
            No se pudieron cargar los almacenes. Revisa la conexion y la tabla almacen_bases.
          </div>
        ) : null}

        {!almacenesQuery.isLoading && !almacenesQuery.isError && almacenes.length === 0 ? (
          <div className="setup-message">No hay almacenes creados en Supabase.</div>
        ) : null}

        {almacenes.length > 0 ? (
          <>
            <label className="setup-label" htmlFor="almacen-selector">
              Almacen
            </label>
            <select
              id="almacen-selector"
              className="setup-select"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">Seleccionar...</option>
              {almacenes.map((almacen) => (
                <option key={almacen.id} value={almacen.id}>
                  {formatWarehouseLabel(almacen)}
                </option>
              ))}
            </select>
            <label className="setup-label" htmlFor="admin-pin">
              PIN administrador
            </label>
            <input
              id="admin-pin"
              className="setup-input"
              inputMode="numeric"
              type="password"
              value={adminPin}
              onChange={(event) => setAdminPin(event.target.value)}
              placeholder="PIN"
            />
            <button className="setup-button" type="button" onClick={handleConfirm}>
              Confirmar
            </button>
          </>
        ) : null}

        {saveError ? <div className="setup-error">{saveError}</div> : null}
      </section>
    </main>
  );
}

function OperatorLogin({ almacenId, warehouseMeta, onLoggedIn }) {
  const [selectedId, setSelectedId] = useState('');
  const [pin, setPin] = useState('');
  const [loginError, setLoginError] = useState('');

  const operatorsQuery = useQuery({
    queryKey: ['almacen-operadores', almacenId],
    enabled: Boolean(almacenId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('almacen_operadores')
        .select('*')
        .eq('almacen_id', almacenId)
        .eq('activo', true)
        .order('nombre', { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
    staleTime: 30000,
    refetchOnWindowFocus: true
  });

  const operators = operatorsQuery.data ?? [];
  const selectedOperator = operators.find((operator) => operator.id === selectedId);

  const handleLogin = () => {
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
      nombre: selectedOperator.nombre,
      rol: normalizeRole(selectedOperator.rol)
    };

    window.localStorage.setItem(ACTIVE_OPERATOR_KEY, JSON.stringify(operator));
    onLoggedIn(operator);
  };

  return (
    <main className="setup-screen">
      <section className="setup-card" aria-labelledby="operator-title">
        <div className="setup-logo" aria-hidden="true">
          <span />
        </div>
        <h1 id="operator-title">{warehouseMeta?.nombre || 'Almacen'}</h1>
        {warehouseMeta?.ubicacion ? <p>{warehouseMeta.ubicacion}</p> : null}

        {operatorsQuery.isLoading ? <div className="setup-message">Cargando usuarios...</div> : null}
        {operatorsQuery.isError ? (
          <div className="setup-error">No se pudieron cargar los usuarios locales.</div>
        ) : null}
        {!operatorsQuery.isLoading && !operators.length ? (
          <div className="setup-message">No hay usuarios activos para este almacen.</div>
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
                  {operator.nombre} - {normalizeRole(operator.rol)}
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

function App() {
  const [almacenId, setAlmacenId] = useState(() => getStoredAlmacenId());
  const [warehouseMeta, setWarehouseMeta] = useState(() => getStoredWarehouseMeta());
  const [operator, setOperator] = useState(() => getStoredOperator());
  const config = useLiveQuery(() => db.estanterias_config.toArray(), [], []);
  const estados = useLiveQuery(() => db.estados_baldas.toArray(), [], []);
  const sync = useSyncManager(almacenId);

  const handleSelected = (nextWarehouseMeta) => {
    setWarehouseMeta(nextWarehouseMeta);
    setAlmacenId(nextWarehouseMeta.id);
    window.location.reload();
  };

  if (!almacenId) {
    return <AlmacenSelector onSelected={handleSelected} />;
  }

  if (!operator) {
    return (
      <OperatorLogin
        almacenId={almacenId}
        warehouseMeta={warehouseMeta}
        onLoggedIn={setOperator}
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
            {operator.nombre} - {operator.rol}
          </p>
        </div>
        <div className="app-header-actions">
          <StatusIndicator {...sync} />
        </div>
      </header>

      <main>
        <WarehouseView config={config} estados={estados} operatorRole={operator.rol} warehouseMeta={warehouseMeta} />
      </main>
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
