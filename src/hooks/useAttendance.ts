import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useGeolocation } from './useGeolocation';
import { useOnlineStatus } from './useOnlineStatus';
import { savePendingRecord, PendingRecord, getPendingRecords } from '@/lib/offline-db';

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
  estado_sync?: string;
  es_inconsistente: boolean;
  nota_inconsistencia: string | null;

  // ✅ NUEVO: para supervisor/CSV
  hac_ste?: string | null;     // Hacienda-Suerte
  suerte_nom?: string | null;  // Nombre de la suerte
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

type PendingFollowUp = {
  id: string;
  entrada_id: string;
  user_id: string;
  evidencia_n: 1 | 2;
  timestamp: string;
  foto_base64: string;
};

const PENDING_FOLLOWUPS_KEY = 'pending_followups_v2';

function toIsoDate(d = new Date()) {
  return d.toISOString().split('T')[0];
}

/**
 * ✅ UUID seguro para iPhone/Android (evita fallos de crypto.randomUUID en móviles viejos)
 */
function safeUUID() {
  try {
    // @ts-ignore
    if (typeof crypto !== 'undefined' && crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function readPendingFollowups(): PendingFollowUp[] {
  try {
    const raw = localStorage.getItem(PENDING_FOLLOWUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingFollowUp[]) : [];
  } catch {
    return [];
  }
}

function writePendingFollowups(items: PendingFollowUp[]) {
  localStorage.setItem(PENDING_FOLLOWUPS_KEY, JSON.stringify(items));
}

function base64ToBlob(b64: string): Blob {
  const byteChars = atob(b64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: 'image/jpeg' });
}

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

  /**
   * ✅ Trae registros de HOY combinando:
   * - Online: Supabase + Pending (IndexedDB)
   * - Offline: solo Pending
   *
   * ✅ Retorna merged para evitar "stale state" en validaciones.
   */
  const getTodayRecords = useCallback(async (): Promise<AttendanceRecord[]> => {
    if (!user) return [];

    const today = toIsoDate();

    // 1) Pending offline (IndexedDB)
    const pendingAll = await getPendingRecords();
    const pendingToday = pendingAll
      .filter((r) => r.user_id === user.id && r.fecha === today)
      .map<AttendanceRecord>((r) => ({
        id: r.id,
        user_id: r.user_id,
        fecha: r.fecha,
        tipo_registro: r.tipo_registro,
        timestamp: r.timestamp,
        latitud: r.latitud ?? null,
        longitud: r.longitud ?? null,
        precision_gps: r.precision_gps ?? null,
        fuera_zona: r.fuera_zona ?? false,
        foto_url: r.foto_url ?? null,
        estado_sync: 'pendiente',
        es_inconsistente: r.es_inconsistente ?? false,
        nota_inconsistencia: r.nota_inconsistencia ?? null,

        // ✅ si en tu IndexedDB aún no guardas esto, quedará null
        hac_ste: (r as any).hac_ste ?? null,
        suerte_nom: (r as any).suerte_nom ?? null,
      }));

    // 2) Supabase (solo si online)
    let remote: AttendanceRecord[] = [];
    if (isOnline) {
      // ✅ trae campos nuevos si existen
      const { data, error } = await supabase
        .from('registros_asistencia')
        .select('*')
        .eq('user_id', user.id)
        .eq('fecha', today)
        .order('timestamp', { ascending: false });

      if (error) {
        console.error('Error fetching today records:', error);
      } else {
        remote = ((data as AttendanceRecord[]) || []).map((r) => ({
          ...r,
          estado_sync: r.estado_sync ?? 'sincronizado',
        }));
      }
    }

    // 3) Merge sin duplicar por id (si un pending ya se sincronizó)
    const map = new Map<string, AttendanceRecord>();
    for (const r of remote) map.set(r.id, r);
    for (const r of pendingToday) if (!map.has(r.id)) map.set(r.id, r);

    const merged = Array.from(map.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    setState((prev) => ({
      ...prev,
      todayRecords: merged,
      lastRecord: merged[0] || null,
    }));

    return merged;
  }, [user, isOnline]);

  /**
   * ✅ Inconsistencias usando records (NO state)
   */
  const checkForInconsistency = useCallback(
    async (
      tipo: 'entrada' | 'salida',
      records: AttendanceRecord[]
    ): Promise<{ isInconsistent: boolean; note: string | null }> => {
      const last = records[0];

      if (tipo === 'entrada' && last?.tipo_registro === 'entrada') {
        return { isInconsistent: true, note: 'Entrada marcada sin salida previa' };
      }

      if (tipo === 'salida' && (!last || last.tipo_registro === 'salida')) {
        return { isInconsistent: true, note: 'Salida marcada sin entrada previa' };
      }

      return { isInconsistent: false, note: null };
    },
    []
  );

  /**
   * ✅ Horas trabajadas (mejor precisión): 2 decimales
   * - 3 minutos = 0.05h (antes podía redondear a 0.0)
   */
  const calculateHoursWorked = useCallback((): number | null => {
    const { todayRecords } = state;
    if (todayRecords.length < 2) return null;

    const entradas = todayRecords.filter((r) => r.tipo_registro === 'entrada');
    const salidas = todayRecords.filter((r) => r.tipo_registro === 'salida');

    if (entradas.length === 0 || salidas.length === 0) return null;

    // entrada más vieja (inicio) y salida más reciente
    const firstEntrada = entradas[entradas.length - 1];
    const lastSalida = salidas[0];

    const start = new Date(firstEntrada.timestamp).getTime();
    const end = new Date(lastSalida.timestamp).getTime();

    const diffMs = end - start;
    if (diffMs <= 0) return null;

    const diffHours = diffMs / (1000 * 60 * 60);
    return Math.round(diffHours * 100) / 100; // ✅ 2 decimales
  }, [state]);

  /**
   * ✅ Subir foto a Storage
   */
  const uploadPhoto = useCallback(async (path: string, blob: Blob): Promise<string> => {
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('attendance-photos')
      .upload(path, blob, { contentType: 'image/jpeg', upsert: true });

    if (uploadError) {
      console.error('Error uploading photo:', uploadError);
      throw new Error(`No se pudo subir la foto (Storage): ${uploadError.message}`);
    }

    const { data: urlData } = supabase.storage.from('attendance-photos').getPublicUrl(uploadData.path);
    if (!urlData?.publicUrl) throw new Error('No se pudo obtener URL pública de la foto');

    return urlData.publicUrl;
  }, []);

  const resolveGeo = useCallback(async (lat: number, lon: number): Promise<GeoResult> => {
    const { data, error } = await supabase.rpc('get_hacienda_by_point', { lat, lon });
    if (error) return null;
    if (!data || data.length === 0) return null;
    return { nom: data[0].nom, hac_ste: data[0].hac_ste };
  }, []);

  /**
   * ✅ Marca entrada/salida (offline ok)
   * ✅ NUEVO: cuando sea entrada y tengas geo, lo guarda en registros_asistencia:
   *   - hac_ste
   *   - suerte_nom
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
        // GPS (best-effort)
        let location: { latitude: number; longitude: number; accuracy: number } | null = null;
        try {
          location = await getCurrentPosition();
        } catch {
          // ok
        }

        // refresca registros y úsalo para inconsistencias
        const records = await getTodayRecords();
        const { isInconsistent, note } = await checkForInconsistency(tipo, records);

        const now = new Date();
        const recordId = safeUUID();

        // ✅ Geo: resuélvelo ANTES del insert, para poder guardarlo
        let geo: GeoResult = null;
        if (tipo === 'entrada' && isOnline && location?.latitude != null && location?.longitude != null) {
          geo = await resolveGeo(location.latitude, location.longitude);
        }

        const record: PendingRecord = {
          id: recordId,
          user_id: user.id,
          fecha: toIsoDate(now),
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

          // ✅ si tu PendingRecord/IndexedDB aún no tiene estos campos, no pasa nada;
          // pero ideal que los agregues para offline completo.
          ...(tipo === 'entrada'
            ? ({
                hac_ste: geo?.hac_ste ?? null,
                suerte_nom: geo?.nom ?? null,
              } as any)
            : {}),
        };

        if (isOnline) {
          const mainPath = `${user.id}/${recordId}.jpg`;
          const fotoUrl = await uploadPhoto(mainPath, photoBlob);

          const payload: any = {
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
          };

          // ✅ guarda ubicación en BD (solo para entrada)
          if (tipo === 'entrada') {
            payload.hac_ste = geo?.hac_ste ?? null;
            payload.suerte_nom = geo?.nom ?? null;
          }

          const { error: insertError } = await supabase.from('registros_asistencia').insert(payload);
          if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);
        } else {
          await savePendingRecord(record);
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
        };
      } catch (err: any) {
        console.error('Error marking attendance:', err);
        const msg = err?.message ? String(err.message) : 'Error al registrar. Intenta de nuevo.';
        setState((prev) => ({ ...prev, isSubmitting: false, error: msg }));
        return { success: false, error: msg };
      }
    },
    [
      user,
      isOnline,
      getCurrentPosition,
      uploadPhoto,
      resolveGeo,
      getTodayRecords,
      checkForInconsistency,
      calculateHoursWorked,
    ]
  );

  /**
   * ✅ Seguimiento fotográfico (OFFLINE OK)
   */
  const markFollowUp = useCallback(
    async (evidenciaN: 1 | 2, photoBlob: Blob, entradaId: string): Promise<{ success: boolean }> => {
      if (!user) {
        setState((prev) => ({ ...prev, error: 'Usuario no autenticado' }));
        return { success: false };
      }

      setState((prev) => ({ ...prev, isSubmitting: true, error: null }));

      try {
        const followupId = safeUUID();
        const ts = new Date().toISOString();

        // OFFLINE: guardo base64 + metadata
        if (!isOnline) {
          const b64 = await blobToBase64(photoBlob);
          const pending = readPendingFollowups();

          // evita duplicados por (user, entrada, evidencia_n)
          const filtered = pending.filter(
            (p) => !(p.user_id === user.id && p.entrada_id === entradaId && p.evidencia_n === evidenciaN)
          );

          filtered.push({
            id: followupId,
            entrada_id: entradaId,
            user_id: user.id,
            evidencia_n: evidenciaN,
            timestamp: ts,
            foto_base64: b64,
          });

          writePendingFollowups(filtered);

          setState((prev) => ({ ...prev, isSubmitting: false, error: null }));
          return { success: true };
        }

        // ONLINE
        const path = `${user.id}/${entradaId}_seg_${evidenciaN}.jpg`;
        const fotoUrl = await uploadPhoto(path, photoBlob);

        const { error: insertError } = await supabase.from('seguimiento_fotos').insert({
          id: followupId,
          entrada_id: entradaId,
          user_id: user.id,
          evidencia_n: evidenciaN,
          foto_url: fotoUrl,
          timestamp: ts,
        });

        if (insertError) throw new Error(`DB insert followup failed: ${insertError.message}`);

        setState((prev) => ({ ...prev, isSubmitting: false, error: null }));
        return { success: true };
      } catch (err: any) {
        console.error('Error saving followup:', err);
        const msg = err?.message ? String(err.message) : 'Error al registrar seguimiento. Intenta de nuevo.';
        setState((prev) => ({ ...prev, isSubmitting: false, error: msg }));
        return { success: false };
      }
    },
    [user, isOnline, uploadPhoto]
  );

  /**
   * ✅ Sincroniza evidencias pendientes cuando vuelve internet.
   */
  const syncPendingFollowups = useCallback(async (): Promise<{ synced: number; failed: number }> => {
    if (!user || !isOnline) return { synced: 0, failed: 0 };

    const pendingAll = readPendingFollowups();
    const mine = pendingAll.filter((p) => p.user_id === user.id);
    if (mine.length === 0) return { synced: 0, failed: 0 };

    let synced = 0;
    let failed = 0;

    const keepMine: PendingFollowUp[] = [];
    const keepOthers = pendingAll.filter((p) => p.user_id !== user.id);

    for (const item of mine) {
      try {
        const blob = base64ToBlob(item.foto_base64);

        const path = `${user.id}/${item.entrada_id}_seg_${item.evidencia_n}.jpg`;
        const fotoUrl = await uploadPhoto(path, blob);

        const { error } = await supabase.from('seguimiento_fotos').insert({
          id: item.id,
          entrada_id: item.entrada_id,
          user_id: item.user_id,
          evidencia_n: item.evidencia_n,
          foto_url: fotoUrl,
          timestamp: item.timestamp,
        });

        if (error) {
          // @ts-ignore
          if (error.code === '23505') {
            synced++;
            continue;
          }
          throw error;
        }

        synced++;
      } catch (e) {
        console.error('sync followup failed', item, e);
        failed++;
        keepMine.push(item);
      }
    }

    writePendingFollowups([...keepOthers, ...keepMine]);
    return { synced, failed };
  }, [user, isOnline, uploadPhoto]);

  return {
    ...state,
    markAttendance,
    markFollowUp,
    getTodayRecords,
    calculateHoursWorked,
    syncPendingFollowups,
  };
}
