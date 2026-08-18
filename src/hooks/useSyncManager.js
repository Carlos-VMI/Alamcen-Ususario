import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { SYNC_INTERVAL_MS, syncService } from '../lib/syncService';
import { useOnlineStatus } from './useOnlineStatus';

const CONFIG_POLL_INTERVAL_MS = 10000;
const CONFIG_POLL_HIDDEN_INTERVAL_MS = 60000;

export function useSyncManager(almacenId) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const syncLockRef = useRef(false);
  const configPollLockRef = useRef(false);
  const onlineRef = useRef(online);
  const pendingCountRef = useRef(0);
  const almacenIdRef = useRef(almacenId);
  const [autoSyncing, setAutoSyncing] = useState(false);
  const [autoSyncError, setAutoSyncError] = useState(null);
  const [manualSyncing, setManualSyncing] = useState(false);
  const [manualSyncError, setManualSyncError] = useState(null);
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState(null);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden');
  const queue = useLiveQuery(() => db.cola_sincronizacion.orderBy('created_at').toArray(), [], []);

  const pendingCount = queue.length;

  useEffect(() => {
    onlineRef.current = online;
    pendingCountRef.current = pendingCount;
    almacenIdRef.current = almacenId;
  }, [almacenId, online, pendingCount]);

  const configQuery = useQuery({
    queryKey: ['remote-config', almacenId],
    enabled: false,
    queryFn: () => syncService.downloadRemoteConfig(almacenId),
    staleTime: 60000,
    refetchOnWindowFocus: false
  });

  useEffect(() => {
    if (configQuery.dataUpdatedAt) {
      setLastSuccessfulSyncAt(new Date(configQuery.dataUpdatedAt));
    }
  }, [configQuery.dataUpdatedAt]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setPageVisible(document.visibilityState !== 'hidden');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!almacenId) return;
    syncService.purgeLegacyStateQueueOnce().catch((error) => {
      setAutoSyncError(error?.message || 'Error limpiando cola local');
    });
  }, [almacenId]);

  const syncNow = useCallback(async () => {
    if (syncLockRef.current) return;
    if (!onlineRef.current || pendingCountRef.current === 0) return;

    syncLockRef.current = true;
    setAutoSyncing(true);
    setAutoSyncError(null);
    try {
      await syncService.flushPendingQueue();
    } catch (error) {
      setAutoSyncError(error?.message || 'Error enviando pendientes');
    } finally {
      syncLockRef.current = false;
      setAutoSyncing(false);
    }
  }, []);

  const pollRemoteConfig = useCallback(async () => {
    const activeAlmacenId = almacenIdRef.current;
    if (!onlineRef.current || !activeAlmacenId || configPollLockRef.current) return;

    configPollLockRef.current = true;
    try {
      const rows = await syncService.downloadRemoteConfig(activeAlmacenId, { fullRefresh: true });
      queryClient.setQueryData(['remote-config', activeAlmacenId], rows);
      setLastSuccessfulSyncAt(new Date());
      setAutoSyncError(null);
    } catch (error) {
      setAutoSyncError(error?.message || 'Error actualizando configuracion');
    } finally {
      configPollLockRef.current = false;
    }
  }, [queryClient]);

  const forceSync = useCallback(async () => {
    if (syncLockRef.current) return;
    if (!onlineRef.current || !almacenIdRef.current) return;

    syncLockRef.current = true;
    setManualSyncing(true);
    setManualSyncError(null);
    try {
      const errors = [];
      try {
        await syncService.flushPendingQueue();
      } catch (error) {
        errors.push(error?.message || 'Error enviando pendientes');
      }

      try {
        const rows = await syncService.forceRefreshRemoteConfig(almacenIdRef.current);
        queryClient.setQueryData(['remote-config', almacenIdRef.current], rows);
        setLastSuccessfulSyncAt(new Date());
      } catch (error) {
        errors.push(error?.message || 'Error descargando configuracion');
      }

      if (errors.length) throw new Error(errors.join(' / '));
    } catch (error) {
      setManualSyncError(error?.message || 'Error sincronizando');
    } finally {
      syncLockRef.current = false;
      setManualSyncing(false);
    }
  }, [queryClient]);

  useEffect(() => {
    if (online && pendingCount > 0) {
      syncNow();
    }
  }, [online, pendingCount, syncNow]);

  useEffect(() => {
    const interval = window.setInterval(syncNow, SYNC_INTERVAL_MS);
    window.addEventListener('online', syncNow);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', syncNow);
    };
  }, [syncNow]);

  useEffect(() => {
    if (!almacenId || !online) return undefined;

    const delay = pageVisible ? CONFIG_POLL_INTERVAL_MS : CONFIG_POLL_HIDDEN_INTERVAL_MS;
    const interval = window.setInterval(pollRemoteConfig, delay);

    if (pageVisible) {
      pollRemoteConfig();
    }

    return () => {
      window.clearInterval(interval);
    };
  }, [almacenId, online, pageVisible, pollRemoteConfig]);

  return useMemo(
    () => ({
      online,
      pendingCount,
      isSyncing: autoSyncing || manualSyncing,
      lastSyncError: manualSyncError || autoSyncError || configQuery.error?.message || null,
      lastSuccessfulSyncAt,
      configLoading: configQuery.isLoading,
      syncNow,
      forceSync
    }),
    [
      online,
      pendingCount,
      autoSyncing,
      autoSyncError,
      manualSyncing,
      manualSyncError,
      lastSuccessfulSyncAt,
      configQuery.isLoading,
      configQuery.error,
      syncNow,
      forceSync
    ]
  );
}
