import { Cloud, CloudOff, RefreshCw } from 'lucide-react';

function formatSyncTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function StatusIndicator({
  online,
  pendingCount,
  isSyncing,
  lastSyncError,
  lastSuccessfulSyncAt,
  onSyncClick
}) {
  const state = !online ? 'offline' : isSyncing ? 'syncing' : pendingCount > 0 ? 'pending' : 'synced';
  const lastSyncTime = formatSyncTime(lastSuccessfulSyncAt);

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
        {online && !isSyncing && pendingCount === 0 && (lastSyncTime ? `Ultima sincronizacion: ${lastSyncTime}` : 'Sincronizado')}
      </span>
    </button>
  );
}
