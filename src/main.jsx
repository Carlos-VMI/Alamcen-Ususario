import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StatusIndicator } from './components/StatusIndicator';
import { WarehouseView } from './components/WarehouseView';
import { useLiveQuery } from './hooks/useLiveQuery';
import { useSyncManager } from './hooks/useSyncManager';
import { db } from './lib/db';
import { supabase } from './lib/supabaseClient';
import './styles/app.css';

const ACTIVE_WAREHOUSE_KEY = 'almacen_id_activo';

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

function AlmacenSelector({ onSelected }) {
  const [selectedId, setSelectedId] = useState('');
  const [saveError, setSaveError] = useState('');

  const almacenesQuery = useQuery({
    queryKey: ['almacenes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('almacenes')
        .select('id, nombre')
        .order('nombre', { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
    staleTime: 60000,
    refetchOnWindowFocus: false
  });

  const almacenes = almacenesQuery.data ?? [];
  const selectedWarehouse = useMemo(
    () => almacenes.find((almacen) => almacen.id === selectedId),
    [almacenes, selectedId]
  );

  const handleConfirm = () => {
    setSaveError('');

    if (!selectedWarehouse) {
      setSaveError('Selecciona un almacen para continuar.');
      return;
    }

    window.localStorage.setItem(ACTIVE_WAREHOUSE_KEY, selectedWarehouse.id);
    onSelected(selectedWarehouse.id);
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
            No se pudieron cargar los almacenes. Revisa la conexion y la tabla almacenes.
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
                  {almacen.nombre}
                </option>
              ))}
            </select>
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

function App() {
  const [almacenId, setAlmacenId] = useState(() => getStoredAlmacenId());
  const config = useLiveQuery(() => db.estanterias_config.toArray(), [], []);
  const estados = useLiveQuery(() => db.estados_baldas.toArray(), [], []);
  const sync = useSyncManager(almacenId);

  const handleSelected = (nextAlmacenId) => {
    setAlmacenId(nextAlmacenId);
    window.location.reload();
  };

  const handleChangeWarehouse = async () => {
    window.localStorage.removeItem(ACTIVE_WAREHOUSE_KEY);
    await db.transaction('rw', db.estanterias_config, db.estados_baldas, db.cola_sincronizacion, async () => {
      await db.estanterias_config.clear();
      await db.estados_baldas.clear();
      await db.cola_sincronizacion.clear();
    });
    setAlmacenId(null);
  };

  if (!almacenId) {
    return <AlmacenSelector onSelected={handleSelected} />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Almacen Operario</h1>
          <p>Estados de baldas offline-first</p>
        </div>
        <div className="app-header-actions">
          <StatusIndicator {...sync} />
          <button className="change-warehouse-button" type="button" onClick={handleChangeWarehouse}>
            Cambiar almacen
          </button>
        </div>
      </header>

      <main>
        <WarehouseView config={config} estados={estados} />
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
