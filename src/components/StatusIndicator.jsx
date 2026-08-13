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
  const label = online && lastSyncTime ? `Sync ${lastSyncTime}` : online ? 'Sync' : 'Offline';

  return (
    <button
      className={`status-indicator ${state}`}
      type="button"
      onClick={onSyncClick}
      disabled={!online || isSyncing}
      title={lastSyncError || 'Sincronizar ahora'}
    >
      <span>{isSyncing ? 'Sync...' : pendingCount > 0 ? `${label} (${pendingCount})` : label}</span>
    </button>
  );
}
