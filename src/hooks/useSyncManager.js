import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '../lib/db';
import { SYNC_INTERVAL_MS, syncService } from '../lib/syncService';
import { useLiveQuery } from './useLiveQuery';
import { useOnlineStatus } from './useOnlineStatus';

export function useSyncManager(almacenId) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const syncLockRef = useRef(false);
  const onlineRef = useRef(online);
  const pendingCountRef = useRef(0);
  const almacenIdRef = useRef(almacenId);
  const [autoSyncing, setAutoSyncing] = useState(false);
  const [autoSyncError, setAutoSyncError] = useState(null);
  const [manualSyncing, setManualSyncing] = useState(false);
  const [manualSyncError, setManualSyncError] = useState(null);
  const queue = useLiveQuery(() => db.cola_sincronizacion.orderBy('created_at').toArray(), [], []);

  const pendingCount = queue.length;

  useEffect(() => {
    onlineRef.current = online;
    pendingCountRef.current = pendingCount;
    almacenIdRef.current = almacenId;
  }, [almacenId, online, pendingCount]);

  const configQuery = useQuery({
    queryKey: ['remote-config', almacenId],
    enabled: Boolean(almacenId) && online,
    queryFn: () => syncService.downloadRemoteConfig(almacenId),
    staleTime: 60000,
    refetchOnWindowFocus: false
  });

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

  return useMemo(
    () => ({
      online,
      pendingCount,
      isSyncing: autoSyncing || manualSyncing || configQuery.isFetching,
      lastSyncError: manualSyncError || autoSyncError || configQuery.error?.message || null,
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
      configQuery.isFetching,
      configQuery.isLoading,
      configQuery.error,
      syncNow,
      forceSync
    ]
  );
}
