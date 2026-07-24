import { Cloud, CloudOff, RefreshCw } from 'lucide-react';

export function StatusIndicator({ online, pendingCount, isSyncing, lastSyncError }) {
  const state = !online ? 'offline' : isSyncing ? 'syncing' : pendingCount > 0 ? 'pending' : 'synced';

  return (
    <div className={`status-indicator ${state}`} title={lastSyncError || ''}>
      {!online ? <CloudOff size={18} /> : isSyncing ? <RefreshCw size={18} /> : <Cloud size={18} />}
      <span>
        {!online && 'Offline'}
        {online && isSyncing && 'Sincronizando'}
        {online && !isSyncing && pendingCount > 0 && `${pendingCount} pendiente${pendingCount === 1 ? '' : 's'}`}
        {online && !isSyncing && pendingCount === 0 && 'Sincronizado'}
      </span>
    </div>
  );
}
