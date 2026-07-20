import { useCallback, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '../lib/db';
import { SYNC_INTERVAL_MS, syncService } from '../lib/syncService';
import { useLiveQuery } from './useLiveQuery';
import { useOnlineStatus } from './useOnlineStatus';

export function useSyncManager(almacenId) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const queue = useLiveQuery(() => db.cola_sincronizacion.orderBy('created_at').toArray(), [], []);

  const pendingCount = queue.length;

  const configQuery = useQuery({
    queryKey: ['remote-config', almacenId],
    enabled: Boolean(almacenId) && online,
    queryFn: () => syncService.downloadRemoteConfig(almacenId),
    staleTime: 60000,
    refetchOnWindowFocus: false
  });

  const roleQuery = useQuery({
    queryKey: ['operator-role', almacenId],
    enabled: Boolean(almacenId) && online,
    queryFn: () => syncService.getCurrentOperatorRole(almacenId),
    staleTime: 300000,
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
      isSyncing: syncMutation.isPending,
      lastSyncError: syncMutation.error?.message ?? null,
      configLoading: configQuery.isLoading,
      operatorRole: roleQuery.data ?? 'operario',
      syncNow
    }),
    [online, pendingCount, syncMutation.isPending, syncMutation.error, configQuery.isLoading, roleQuery.data, syncNow]
  );
}
