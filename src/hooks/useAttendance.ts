import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useGeolocation } from './useGeolocation';
import { useCamera } from './useCamera';
import { useOnlineStatus } from './useOnlineStatus';
import { savePendingRecord, PendingRecord } from '@/lib/offline-db';

interface AttendanceRecord {
  id: string;
  user_id: string;
  fecha: string;
  tipo_registro: 'entrada' | 'salida';
  timestamp: string;
  latitud: number | null;
  longitud: number | null;
  precision_gps: number | null;
  fuera_zona: boolean;
  foto_url: string | null;
  estado_sync: string;
  es_inconsistente: boolean;
  nota_inconsistencia: string | null;
}

interface AttendanceState {
  isSubmitting: boolean;
  error: string | null;
  lastRecord: AttendanceRecord | null;
  todayRecords: AttendanceRecord[];
}

export function useAttendance() {
  const { user } = useAuth();
  const { getCurrentPosition } = useGeolocation();
  const { capturePhoto } = useCamera();
  const { isOnline } = useOnlineStatus();
  const [state, setState] = useState<AttendanceState>({
    isSubmitting: false,
    error: null,
    lastRecord: null,
    todayRecords: [],
  });

  const getTodayRecords = useCallback(async () => {
    if (!user) return;

    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('registros_asistencia')
      .select('*')
      .eq('user_id', user.id)
      .eq('fecha', today)
      .order('timestamp', { ascending: false });

    if (error) {
      console.error('Error fetching today records:', error);
      return;
    }

    const records = (data as AttendanceRecord[]) || [];
    setState((prev) => ({
      ...prev,
      todayRecords: records,
      lastRecord: records[0] || null,
    }));
  }, [user]);

  const checkForInconsistency = useCallback(
    async (tipo: 'entrada' | 'salida'): Promise<{ isInconsistent: boolean; note: string | null }> => {
      if (!user) return { isInconsistent: false, note: null };

      const today = new Date().toISOString().split('T')[0];

      const { data: todayRecords } = await supabase
        .from('registros_asistencia')
        .select('tipo_registro, timestamp')
        .eq('user_id', user.id)
        .eq('fecha', today)
        .order('timestamp', { ascending: false });

      const records = todayRecords || [];
      const lastRecord = records[0];

      // Check for inconsistencies
      if (tipo === 'entrada' && lastRecord?.tipo_registro === 'entrada') {
        return {
          isInconsistent: true,
          note: 'Entrada marcada sin salida previa',
        };
      }

      if (tipo === 'salida' && (!lastRecord || lastRecord.tipo_registro === 'salida')) {
        return {
          isInconsistent: true,
          note: 'Salida marcada sin entrada previa',
        };
      }

      return { isInconsistent: false, note: null };
    },
    [user]
  );

  const calculateHoursWorked = useCallback((): number | null => {
    const { todayRecords } = state;
    if (todayRecords.length < 2) return null;

    // Find first entrada and last salida
    const entradas = todayRecords.filter((r) => r.tipo_registro === 'entrada');
    const salidas = todayRecords.filter((r) => r.tipo_registro === 'salida');

    if (entradas.length === 0 || salidas.length === 0) return null;

    const firstEntrada = entradas[entradas.length - 1]; // Oldest entrada
    const lastSalida = salidas[0]; // Most recent salida

    const start = new Date(firstEntrada.timestamp);
    const end = new Date(lastSalida.timestamp);

    const diffMs = end.getTime() - start.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    return Math.round(diffHours * 10) / 10; // Round to 1 decimal
  }, [state]);

  const markAttendance = useCallback(
    async (tipo: 'entrada' | 'salida'): Promise<{ success: boolean; hoursWorked?: number | null }> => {
      if (!user) {
        setState((prev) => ({ ...prev, error: 'Usuario no autenticado' }));
        return { success: false };
      }

      setState((prev) => ({ ...prev, isSubmitting: true, error: null }));

      try {
        // Step 1: Get GPS location
        let location: { latitude: number; longitude: number; accuracy: number } | null = null;
        try {
          location = await getCurrentPosition();
        } catch (error) {
          console.warn('Could not get GPS:', error);
          // Continue without GPS - not blocking
        }

        // Step 2: Capture photo (mandatory)
        let photoBlob: Blob | null = null;
        try {
          photoBlob = await capturePhoto();
        } catch (error) {
          setState((prev) => ({
            ...prev,
            isSubmitting: false,
            error: 'La foto es obligatoria. Por favor, toma una foto.',
          }));
          return { success: false };
        }

        // Step 3: Check for inconsistencies
        const { isInconsistent, note } = await checkForInconsistency(tipo);

        // Step 4: Create record
        const now = new Date();
        const recordId = crypto.randomUUID();
        const record: PendingRecord = {
          id: recordId,
          user_id: user.id,
          fecha: now.toISOString().split('T')[0],
          tipo_registro: tipo,
          timestamp: now.toISOString(),
          latitud: location?.latitude ?? null,
          longitud: location?.longitude ?? null,
          precision_gps: location?.accuracy ?? null,
          fuera_zona: false, // TODO: Implement geocerca validation
          foto_blob: photoBlob,
          foto_url: null,
          es_inconsistente: isInconsistent,
          nota_inconsistencia: note,
          created_at: now.toISOString(),
        };

        if (isOnline) {
          // Online: Upload photo and save directly
          let fotoUrl: string | null = null;

          if (photoBlob) {
            const fileName = `${user.id}/${recordId}.jpg`;
            const { data: uploadData, error: uploadError } = await supabase.storage
              .from('attendance-photos')
              .upload(fileName, photoBlob, {
                contentType: 'image/jpeg',
              });

            if (uploadError) {
              console.error('Error uploading photo:', uploadError);
            } else {
              const { data: urlData } = supabase.storage
                .from('attendance-photos')
                .getPublicUrl(uploadData.path);
              fotoUrl = urlData.publicUrl;
            }
          }

          const { error: insertError } = await supabase.from('registros_asistencia').insert({
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

          if (insertError) {
            throw new Error('Error guardando registro');
          }
        } else {
          // Offline: Save to IndexedDB
          await savePendingRecord(record);
        }

        // Refresh today's records
        await getTodayRecords();

        // Calculate hours if this was a salida
        let hoursWorked: number | null = null;
        if (tipo === 'salida') {
          hoursWorked = calculateHoursWorked();
        }

        setState((prev) => ({ ...prev, isSubmitting: false, error: null }));
        return { success: true, hoursWorked };
      } catch (error) {
        console.error('Error marking attendance:', error);
        setState((prev) => ({
          ...prev,
          isSubmitting: false,
          error: 'Error al registrar. Intenta de nuevo.',
        }));
        return { success: false };
      }
    },
    [user, isOnline, getCurrentPosition, capturePhoto, checkForInconsistency, getTodayRecords, calculateHoursWorked]
  );

  return {
    ...state,
    markAttendance,
    getTodayRecords,
    calculateHoursWorked,
  };
}
