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
  const label = online && lastSyncTime ? `Sincronizado ${lastSyncTime}` : online ? 'Sincronizar' : 'Sin conexión';

  return (
    <button
      className={`status-indicator ${state}`}
      type="button"
      onClick={onSyncClick}
      disabled={!online || isSyncing}
      title={lastSyncError || 'Sincronizar ahora'}
      aria-label={label}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 17.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.35 7.6 4.6 4.6 0 0 0 7 17.5Z" />
        <path d="M9 13.5 12 10l3 3.5M12 10v8" />
      </svg>
      {pendingCount > 0 ? <span>{pendingCount}</span> : null}
    </button>
  );
}
