import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../lib/db';
import { supabase } from '../lib/supabaseClient';
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

  useEffect(() => {
    if (!almacenId || !online) return undefined;

    const applyRealtimePayload = async (table, payload) => {
      setIsRealtimeSyncing(true);
      setLastError(null);
      try {
        if (table === 'almacen_articulos') {
          await syncService.applyArticleRealtimeChange(almacenId, payload);
        } else if (table === 'almacen_modulos') {
          await syncService.applyModuleRealtimeChange(almacenId, payload);
        } else if (table === 'almacen_estantes') {
          const moduleId = payload.new?.modulo_id || payload.old?.modulo_id;
          const module = moduleId ? await db.almacen_modulos.get(moduleId) : null;

          if (payload.eventType !== 'DELETE' && (!module || module.almacen_id !== almacenId)) {
            await syncService.downloadRemoteConfig(almacenId, { fullRefresh: true });
          } else {
            await syncService.applyShelfRealtimeChange(almacenId, payload);
          }
        }
        setLastSyncedAt(new Date());
      } catch (error) {
        setLastError(error?.message || 'Error aplicando cambio realtime');
      } finally {
        setIsRealtimeSyncing(false);
      }
    };

    const channel = supabase
      .channel('public:cambios')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'almacen_articulos',
          filter: `almacen_id=eq.${almacenId}`
        },
        (payload) => applyRealtimePayload('almacen_articulos', payload)
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'almacen_modulos',
          filter: `almacen_id=eq.${almacenId}`
        },
        (payload) => applyRealtimePayload('almacen_modulos', payload)
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'almacen_estantes'
        },
        (payload) => applyRealtimePayload('almacen_estantes', payload)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [almacenId, online]);

  return useMemo(() => ({
    isInitializing,
    isRealtimeSyncing,
    lastError,
    lastSyncedAt,
    forceFullRefresh
  }), [forceFullRefresh, isInitializing, isRealtimeSyncing, lastError, lastSyncedAt]);
}
