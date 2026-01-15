import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  getPendingRecords,
  deletePendingRecord,
  getPendingCount,
  PendingRecord,
} from '@/lib/offline-db';
import { useOnlineStatus } from './useOnlineStatus';
import { useAuth } from './useAuth';

interface SyncState {
  pendingCount: number;
  isSyncing: boolean;
  lastSyncTime: Date | null;
  error: string | null;
}

export function useSyncService() {
  const { isOnline } = useOnlineStatus();
  const { user } = useAuth();
  const [state, setState] = useState<SyncState>({
    pendingCount: 0,
    isSyncing: false,
    lastSyncTime: null,
    error: null,
  });

  const updatePendingCount = useCallback(async () => {
    const count = await getPendingCount();
    setState((prev) => ({ ...prev, pendingCount: count }));
  }, []);

  const uploadPhoto = async (record: PendingRecord): Promise<string | null> => {
    if (!record.foto_blob || !user) return record.foto_url;

    const fileName = `${user.id}/${record.id}.jpg`;
    const { data, error } = await supabase.storage
      .from('attendance-photos')
      .upload(fileName, record.foto_blob, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (error) {
      console.error('Error uploading photo:', error);
      return null;
    }

    const { data: urlData } = supabase.storage
      .from('attendance-photos')
      .getPublicUrl(data.path);

    return urlData.publicUrl;
  };

  const syncRecord = async (record: PendingRecord): Promise<boolean> => {
    try {
      // Upload photo first if exists
      const fotoUrl = await uploadPhoto(record);

      // Insert record to database
      const { error } = await supabase.from('registros_asistencia').insert({
        id: record.id,
        user_id: record.user_id,
        fecha: record.fecha,
        tipo_registro: record.tipo_registro,
        timestamp: record.timestamp,
        latitud: record.latitud,
        longitud: record.longitud,
        precision_gps: record.precision_gps,
        fuera_zona: record.fuera_zona,
        foto_url: fotoUrl,
        estado_sync: 'sincronizado',
        es_inconsistente: record.es_inconsistente,
        nota_inconsistencia: record.nota_inconsistencia,
      });

      if (error) {
        // Check if it's a duplicate error (already synced)
        if (error.code === '23505') {
          // Delete from pending since it already exists
          await deletePendingRecord(record.id);
          return true;
        }
        console.error('Error syncing record:', error);
        return false;
      }

      // Remove from pending records
      await deletePendingRecord(record.id);
      return true;
    } catch (error) {
      console.error('Error in syncRecord:', error);
      return false;
    }
  };

  const syncAll = useCallback(async () => {
    if (!isOnline || !user) return;

    setState((prev) => ({ ...prev, isSyncing: true, error: null }));

    try {
      const pendingRecords = await getPendingRecords();
      let successCount = 0;
      let failCount = 0;

      for (const record of pendingRecords) {
        const success = await syncRecord(record);
        if (success) {
          successCount++;
        } else {
          failCount++;
        }
      }

      await updatePendingCount();

      setState((prev) => ({
        ...prev,
        isSyncing: false,
        lastSyncTime: new Date(),
        error: failCount > 0 ? `${failCount} registros no se pudieron sincronizar` : null,
      }));

      console.log(`Sync complete: ${successCount} success, ${failCount} failed`);
    } catch (error) {
      console.error('Error in syncAll:', error);
      setState((prev) => ({
        ...prev,
        isSyncing: false,
        error: 'Error durante la sincronización',
      }));
    }
  }, [isOnline, user, updatePendingCount]);

  // Auto-sync when coming back online
  useEffect(() => {
    if (isOnline && user) {
      syncAll();
    }
  }, [isOnline, user, syncAll]);

  // Update pending count on mount and when user changes
  useEffect(() => {
    updatePendingCount();
  }, [user, updatePendingCount]);

  // Periodic sync every 30 seconds when online
  useEffect(() => {
    if (!isOnline || !user) return;

    const interval = setInterval(() => {
      syncAll();
    }, 30000);

    return () => clearInterval(interval);
  }, [isOnline, user, syncAll]);

  return {
    ...state,
    syncAll,
    updatePendingCount,
  };
}
