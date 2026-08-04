import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { syncService } from '../lib/syncService';
import { useOnlineStatus } from './useOnlineStatus';

export function useSupabaseSync(almacenId) {
  const online = useOnlineStatus();
  const syncLockRef = useRef(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isRealtimeSyncing, setIsRealtimeSyncing] = useState(false);
  const [lastError, setLastError] = useState(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  const runInitialSync = useCallback(async () => {
    if (!almacenId || !online || syncLockRef.current) return;

    syncLockRef.current = true;
    setIsInitializing(true);
    setLastError(null);
    try {
      await syncService.downloadRemoteConfig(almacenId, { fullRefresh: true });
      setLastSyncedAt(new Date());
    } catch (error) {
      setLastError(error?.message || 'Error sincronizando datos de Supabase');
    } finally {
      setIsInitializing(false);
      syncLockRef.current = false;
    }
  }, [almacenId, online]);

  const forceFullRefresh = useCallback(async () => {
    if (!almacenId || !online) return;

    setIsRealtimeSyncing(true);
    setLastError(null);
    try {
      await syncService.downloadRemoteConfig(almacenId, { fullRefresh: true });
      setLastSyncedAt(new Date());
    } catch (error) {
      setLastError(error?.message || 'Error refrescando datos de Supabase');
    } finally {
      setIsRealtimeSyncing(false);
    }
  }, [almacenId, online]);

  useEffect(() => {
    runInitialSync();
  }, [runInitialSync]);

  return useMemo(() => ({
    isInitializing,
    isRealtimeSyncing,
    lastError,
    lastSyncedAt,
    forceFullRefresh
  }), [forceFullRefresh, isInitializing, isRealtimeSyncing, lastError, lastSyncedAt]);
}
