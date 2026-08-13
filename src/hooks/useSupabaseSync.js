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
    if (!almacenId || syncLockRef.current) return;

    syncLockRef.current = true;
    setIsInitializing(true);
    setLastError(null);
    try {
      if (online) {
        await syncService.downloadRemoteConfig(almacenId, { fullRefresh: true });
      } else {
        await syncService.rebuildShelfConfigFromLocalCache(almacenId);
      }
      setLastSyncedAt(new Date());
    } catch (error) {
      setLastError(error?.message || 'Error sincronizando datos');
    } finally {
      setIsInitializing(false);
      syncLockRef.current = false;
    }
  }, [almacenId, online]);

  const forceFullRefresh = useCallback(async () => {
    if (!almacenId) return;

    setIsRealtimeSyncing(true);
    setLastError(null);
    try {
      if (navigator.onLine) {
        await syncService.downloadRemoteConfig(almacenId, { fullRefresh: true });
      } else {
        await syncService.rebuildShelfConfigFromLocalCache(almacenId);
      }
      setLastSyncedAt(new Date());
    } catch (error) {
      try {
        await syncService.rebuildShelfConfigFromLocalCache(almacenId);
      } catch (innerError) {
        setLastError(innerError?.message || error?.message || 'Error refrescando datos');
      }
    } finally {
      setIsRealtimeSyncing(false);
    }
  }, [almacenId]);

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
