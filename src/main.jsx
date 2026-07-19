import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusIndicator } from './components/StatusIndicator';
import { WarehouseView } from './components/WarehouseView';
import { useLiveQuery } from './hooks/useLiveQuery';
import { useSyncManager } from './hooks/useSyncManager';
import { db } from './lib/db';
import './styles/app.css';

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

function App() {
  const almacenId = import.meta.env.VITE_ALMACEN_ID;
  const config = useLiveQuery(() => db.estanterias_config.toArray(), [], []);
  const estados = useLiveQuery(() => db.estados_baldas.toArray(), [], []);
  const sync = useSyncManager(almacenId);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Almacen Operario</h1>
          <p>Estados de baldas offline-first</p>
        </div>
        <StatusIndicator {...sync} />
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
