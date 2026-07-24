import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '../lib/db';
import { SYNC_INTERVAL_MS, syncService } from '../lib/syncService';
import { useLiveQuery } from './useLiveQuery';
import { useOnlineStatus } from './useOnlineStatus';

export function useSyncManager(almacenId) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const [manualSyncing, setManualSyncing] = useState(false);
  const [manualSyncError, setManualSyncError] = useState(null);
  const queue = useLiveQuery(() => db.cola_sincronizacion.orderBy('created_at').toArray(), [], []);

  const pendingCount = queue.length;

  const configQuery = useQuery({
    queryKey: ['remote-config', almacenId],
    enabled: Boolean(almacenId) && online,
    queryFn: () => syncService.downloadRemoteConfig(almacenId),
    staleTime: 60000,
    refetchInterval: online ? SYNC_INTERVAL_MS : false,
    refetchOnWindowFocus: false
  });

  const syncMutation = useMutation({
    mutationFn: () => syncService.flushPendingQueue(),
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-config', almacenId] });
    }
  });

  const syncNow = useCallback(() => {
    if (online && pendingCount > 0 && !syncMutation.isPending) {
      syncMutation.mutate();
    }
  }, [online, pendingCount, syncMutation]);

  const forceSync = useCallback(async () => {
    if (!online || !almacenId || manualSyncing) return;

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
        await syncService.forceRefreshRemoteConfig(almacenId);
      } catch (error) {
        errors.push(error?.message || 'Error descargando configuracion');
      }

      await queryClient.invalidateQueries({ queryKey: ['remote-config', almacenId] });
      if (errors.length) throw new Error(errors.join(' / '));
    } catch (error) {
      setManualSyncError(error?.message || 'Error sincronizando');
    } finally {
      setManualSyncing(false);
    }
  }, [almacenId, manualSyncing, online, queryClient]);

  useEffect(() => {
    syncNow();
  }, [syncNow]);

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
      isSyncing: manualSyncing || syncMutation.isPending || configQuery.isFetching,
      lastSyncError: manualSyncError || syncMutation.error?.message || configQuery.error?.message || null,
      configLoading: configQuery.isLoading,
      syncNow,
      forceSync
    }),
    [
      online,
      pendingCount,
      manualSyncing,
      manualSyncError,
      syncMutation.isPending,
      syncMutation.error,
      configQuery.isFetching,
      configQuery.isLoading,
      configQuery.error,
      syncNow,
      forceSync
    ]
  );
}
