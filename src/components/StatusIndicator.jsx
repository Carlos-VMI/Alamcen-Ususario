import { Cloud, CloudOff, RefreshCw } from 'lucide-react';

export function StatusIndicator({ online, pendingCount, isSyncing, lastSyncError, onSyncClick }) {
  const state = !online ? 'offline' : isSyncing ? 'syncing' : pendingCount > 0 ? 'pending' : 'synced';

  return (
    <button
      className={`status-indicator ${state}`}
      type="button"
      onClick={onSyncClick}
      disabled={!online || isSyncing}
      title={lastSyncError || 'Sincronizar ahora'}
    >
      {!online ? <CloudOff size={18} /> : isSyncing ? <RefreshCw size={18} /> : <Cloud size={18} />}
      <span>
        {!online && 'Offline'}
        {online && isSyncing && 'Sincronizando'}
        {online && !isSyncing && pendingCount > 0 && `${pendingCount} pendiente${pendingCount === 1 ? '' : 's'}`}
        {online && !isSyncing && pendingCount === 0 && 'Sincronizado'}
      </span>
    </button>
  );
}
