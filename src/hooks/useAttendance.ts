import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useGeolocation } from './useGeolocation';
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

type GeoResult = { nom: string; hac_ste: string } | null;

type MarkAttendanceResult = {
  success: boolean;
  hoursWorked?: number | null;
  coords?: { lat: number | null; lon: number | null; accuracy: number | null };
  geo?: GeoResult;
  error?: string | null;
};

export function useAttendance() {
  const { user } = useAuth();
  const { getCurrentPosition } = useGeolocation();
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

      if (tipo === 'entrada' && lastRecord?.tipo_registro === 'entrada') {
        return { isInconsistent: true, note: 'Entrada marcada sin salida previa' };
      }

      if (tipo === 'salida' && (!lastRecord || lastRecord.tipo_registro === 'salida')) {
        return { isInconsistent: true, note: 'Salida marcada sin entrada previa' };
      }

      return { isInconsistent: false, note: null };
    },
    [user]
  );

  const calculateHoursWorked = useCallback((): number | null => {
    const { todayRecords } = state;
    if (todayRecords.length < 2) return null;

    const entradas = todayRecords.filter((r) => r.tipo_registro === 'entrada');
    const salidas = todayRecords.filter((r) => r.tipo_registro === 'salida');

    if (entradas.length === 0 || salidas.length === 0) return null;

    const firstEntrada = entradas[entradas.length - 1];
    const lastSalida = salidas[0];

    const start = new Date(firstEntrada.timestamp);
    const end = new Date(lastSalida.timestamp);

    const diffMs = end.getTime() - start.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    return Math.round(diffHours * 10) / 10;
  }, [state]);

  // Subir una imagen a Storage y devolver publicUrl
  const uploadPhoto = useCallback(async (path: string, blob: Blob): Promise<string | null> => {
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('attendance-photos')
      .upload(path, blob, { contentType: 'image/jpeg', upsert: true });

    if (uploadError) {
      console.error('Error uploading photo:', uploadError);
      return null;
    }

    const { data: urlData } = supabase.storage.from('attendance-photos').getPublicUrl(uploadData.path);
    return urlData.publicUrl ?? null;
  }, []);

  // ✅ Resolver Hacienda/Suerte con el MISMO GPS capturado en markAttendance
  const resolveGeo = useCallback(async (lat: number, lon: number): Promise<GeoResult> => {
    const { data, error } = await supabase.rpc('get_hacienda_by_point', { lat, lon });

    if (error) {
      console.warn('Geo RPC error:', error);
      return null;
    }

    if (!data || data.length === 0) return null;

    return { nom: data[0].nom, hac_ste: data[0].hac_ste };
  }, []);

  /**
   * ✅ Marca Entrada o Salida (solo 1 foto por registro)
   * - Entrada: foto obligatoria
   * - Salida: foto obligatoria
   *
   * ✅ Mejor UX:
   * - Captura GPS una sola vez
   * - En Entrada, consulta PostGIS con ese GPS y retorna geo (nom/hac_ste)
   */
  const markAttendance = useCallback(
    async (tipo: 'entrada' | 'salida', photoBlob: Blob): Promise<MarkAttendanceResult> => {
      if (!user) {
        const msg = 'Usuario no autenticado';
        setState((prev) => ({ ...prev, error: msg }));
        return { success: false, error: msg };
      }

      setState((prev) => ({ ...prev, isSubmitting: true, error: null }));

      try {
        // 1) GPS
        let location: { latitude: number; longitude: number; accuracy: number } | null = null;
        try {
          location = await getCurrentPosition();
        } catch (err) {
          console.warn('Could not get GPS:', err);
          // seguimos sin GPS
        }

        // 2) Inconsistencias
        const { isInconsistent, note } = await checkForInconsistency(tipo);

        // 3) Record base
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
          fuera_zona: false,
          foto_blob: photoBlob,
          foto_url: null,
          es_inconsistente: isInconsistent,
          nota_inconsistencia: note,
          created_at: now.toISOString(),
        };

        let geo: GeoResult = null;

        if (isOnline) {
          // Subir foto principal
          const mainPath = `${user.id}/${recordId}.jpg`;
          const fotoUrl = await uploadPhoto(mainPath, photoBlob);

          // Insert registro
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

          if (insertError) throw new Error('Error guardando registro');

          // ✅ Solo en ENTRADA: resolver geo si hay GPS
          if (tipo === 'entrada' && location?.latitude != null && location?.longitude != null) {
            geo = await resolveGeo(location.latitude, location.longitude);
          }
        } else {
          // OFFLINE
          await savePendingRecord(record);
          // sin internet no resolvemos geo
        }

        await getTodayRecords();

        let hoursWorked: number | null = null;
        if (tipo === 'salida') hoursWorked = calculateHoursWorked();

        setState((prev) => ({ ...prev, isSubmitting: false, error: null }));

        return {
          success: true,
          hoursWorked,
          coords: {
            lat: location?.latitude ?? null,
            lon: location?.longitude ?? null,
            accuracy: location?.accuracy ?? null,
          },
          geo,
          error: null,
        };
      } catch (err) {
        console.error('Error marking attendance:', err);
        const msg = 'Error al registrar. Intenta de nuevo.';
        setState((prev) => ({
          ...prev,
          isSubmitting: false,
          error: msg,
        }));
        return { success: false, error: msg };
      }
    },
    [user, isOnline, getCurrentPosition, checkForInconsistency, getTodayRecords, calculateHoursWorked, uploadPhoto, resolveGeo]
  );

  /**
   * ✅ Seguimiento fotográfico:
   * - evidencia_n = 1 (obligatorio, controlado por UI con 3h)
   * - evidencia_n = 2 (opcional, habilitado luego de completar el 1)
   */
  const markFollowUp = useCallback(
    async (evidenciaN: 1 | 2, photoBlob: Blob, entradaId: string): Promise<{ success: boolean }> => {
      if (!user) {
        setState((prev) => ({ ...prev, error: 'Usuario no autenticado' }));
        return { success: false };
      }

      setState((prev) => ({ ...prev, isSubmitting: true, error: null }));

      try {
        const followupId = crypto.randomUUID();

        // Subir foto de seguimiento
        const path = `${user.id}/${entradaId}_seg_${evidenciaN}.jpg`;
        const fotoUrl = await uploadPhoto(path, photoBlob);

        if (!fotoUrl) throw new Error('No se pudo subir la foto de seguimiento');

        // Insertar seguimiento
        const { error: insertError } = await supabase.from('seguimiento_fotos').insert({
          id: followupId,
          entrada_id: entradaId,
          user_id: user.id,
          evidencia_n: evidenciaN,
          foto_url: fotoUrl,
        });

        if (insertError) throw insertError;

        setState((prev) => ({ ...prev, isSubmitting: false, error: null }));
        return { success: true };
      } catch (err) {
        console.error('Error saving followup:', err);
        setState((prev) => ({
          ...prev,
          isSubmitting: false,
          error: 'Error al registrar seguimiento. Intenta de nuevo.',
        }));
        return { success: false };
      }
    },
    [user, uploadPhoto]
  );

  return {
    ...state,
    markAttendance,
    markFollowUp,
    getTodayRecords,
    calculateHoursWorked,
  };
}
