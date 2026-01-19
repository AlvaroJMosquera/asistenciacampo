import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { LogIn, LogOut, User, Leaf, Settings, Camera, MapPin } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useAttendance } from '@/hooks/useAttendance';
import { supabase } from '@/integrations/supabase/client';
import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { AttendanceButton } from '@/components/AttendanceButton';
import { LastRecordCard } from '@/components/LastRecordCard';
import { HoursWorkedCard } from '@/components/HoursWorkedCard';
import { ConfirmationModal } from '@/components/ConfirmationModal';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { useCamera } from '@/hooks/useCamera';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

type FollowUpRow = { evidencia_n: 1 | 2; foto_url: string; timestamp: string };

export default function OperarioHome() {
  const { profile, isSupervisor, signOut } = useAuth();
  const { isSubmitting, error, lastRecord, todayRecords, markAttendance, getTodayRecords, calculateHoursWorked, markFollowUp } =
    useAttendance();

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    type: 'entrada' | 'salida';
    success: boolean;
    hoursWorked?: number | null;
    error?: string | null;
  }>({ isOpen: false, type: 'entrada', success: false });

  const { capturePhoto } = useCamera();

  // Seguimiento: estado
  const [followups, setFollowups] = useState<FollowUpRow[]>([]);
  const [isLoadingFollowups, setIsLoadingFollowups] = useState(false);

  // ✅ Geo modal (mejor UX)
  const [geoOpen, setGeoOpen] = useState(false);
  const [geoInfo, setGeoInfo] = useState<{ nom: string; hac_ste: string } | null>(null);
  const [geoCoords, setGeoCoords] = useState<{ lat: number | null; lon: number | null; accuracy: number | null } | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  useEffect(() => {
    getTodayRecords();
  }, [getTodayRecords]);

  const today = format(new Date(), "EEEE, d 'de' MMMM", { locale: es });
  const hoursWorked = calculateHoursWorked();

  const closeModal = () => setModalState((prev) => ({ ...prev, isOpen: false }));

  // ✅ Determinar “entrada activa”
  const activeEntrada = useMemo(() => {
    const sorted = [...todayRecords].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    let currentEntrada: any = null;
    for (const r of sorted) {
      if (r.tipo_registro === 'entrada') currentEntrada = r;
      if (r.tipo_registro === 'salida') currentEntrada = null;
    }
    return currentEntrada;
  }, [todayRecords]);

  // Traer seguimientos desde Supabase para la entrada activa
  const loadFollowups = async () => {
    if (!activeEntrada?.id) {
      setFollowups([]);
      return;
    }
    setIsLoadingFollowups(true);
    const { data, error } = await supabase
      .from('seguimiento_fotos')
      .select('evidencia_n, foto_url, timestamp')
      .eq('entrada_id', activeEntrada.id)
      .order('evidencia_n', { ascending: true });

    if (!error) setFollowups((data || []) as FollowUpRow[]);
    setIsLoadingFollowups(false);
  };

  useEffect(() => {
    loadFollowups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntrada?.id]);

  const hasFollow1 = followups.some((f) => f.evidencia_n === 1);
  const hasFollow2 = followups.some((f) => f.evidencia_n === 2);

  // ✅ Regla de 3 horas para Registro 1
  const follow1EnabledInfo = useMemo(() => {
    if (!activeEntrada) return { enabled: false, remainingText: 'Primero marca entrada' };

    const start = new Date(activeEntrada.timestamp).getTime();
    const now = Date.now();
    const diffMs = now - start;
    const requiredMs = 0.01 * 60 * 60 * 1000;

    if (diffMs >= requiredMs) return { enabled: true, remainingText: '' };

    const remaining = requiredMs - diffMs;
    const hrs = Math.floor(remaining / (60 * 60 * 1000));
    const mins = Math.ceil((remaining % (60 * 60 * 1000)) / (60 * 1000));
    return { enabled: false, remainingText: `Disponible en ${hrs}h ${mins}m` };
  }, [activeEntrada]);

  const handleMarkAttendance = async (tipo: 'entrada' | 'salida') => {
    try {
      // 🔒 No permitir salida si no existe Registro 1
      if (tipo === 'salida' && !hasFollow1) {
        setModalState({
          isOpen: true,
          type: 'salida',
          success: false,
          hoursWorked: null,
          error: 'Debes completar el Registro 1 de seguimiento antes de marcar la salida.',
        });
        return;
      }

      const photoBlob = await capturePhoto();
      const result = await markAttendance(tipo, photoBlob);

      setModalState({
        isOpen: true,
        type: tipo,
        success: result.success,
        hoursWorked: result.hoursWorked,
        error: result.success ? null : (result.error ?? error),
      });

      if (result.success) {
        await getTodayRecords();
        await loadFollowups();
      }

      // ✅ Mejor UX: mostrar geo modal SOLO en entrada exitosa usando la info ya calculada
      if (tipo === 'entrada' && result.success) {
        setGeoCoords(result.coords ?? null);
        setGeoInfo(result.geo ?? null);

        if (!result.coords?.lat || !result.coords?.lon) {
          setGeoMsg('No se pudo obtener ubicación. Debes permitir GPS para identificar la hacienda/suerte.');
        } else if (!result.geo) {
          setGeoMsg('Ubicación obtenida, pero no estás dentro de ninguna suerte/hacienda (según el mapa).');
        } else {
          setGeoMsg(null);
        }

        setGeoOpen(true);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleFollowUp = async (n: 1 | 2) => {
    try {
      if (!activeEntrada?.id) return;

      if (n === 1 && !follow1EnabledInfo.enabled) return;
      if (n === 2 && !hasFollow1) return;

      const blob = await capturePhoto();
      await markFollowUp(n, blob, activeEntrada.id);
      await loadFollowups();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-card border-b px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary">
              <Leaf className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-semibold text-foreground flex items-center gap-2">
                <User className="h-4 w-4" />
                {profile?.nombre || 'Usuario'}
              </h1>
              <p className="text-sm text-muted-foreground capitalize">{today}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isSupervisor && (
              <Link to="/supervisor">
                <Button variant="outline" size="icon">
                  <Settings className="h-4 w-4" />
                </Button>
              </Link>
            )}
            <Button variant="ghost" size="sm" onClick={signOut}>
              Salir
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 p-4 space-y-4 max-w-lg mx-auto w-full">
        <div className="flex justify-center">
          <SyncStatusBadge />
        </div>

        <HoursWorkedCard hours={hoursWorked} />

        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-2">Último registro hoy</h2>
          <LastRecordCard record={lastRecord} />
        </div>

        {/* Seguimiento fotográfico */}
        <div className="pt-2 space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Seguimiento fotográfico</h2>

          <Button
            className="w-full"
            onClick={() => handleFollowUp(1)}
            disabled={isSubmitting || hasFollow1 || !follow1EnabledInfo.enabled || !activeEntrada}
          >
            <Camera className="h-4 w-4 mr-2" />
            {hasFollow1 ? 'Registro 1 completado' : `Registro 1 (obligatorio) ${follow1EnabledInfo.remainingText}`}
          </Button>

          <Button
            className="w-full"
            variant="outline"
            onClick={() => handleFollowUp(2)}
            disabled={isSubmitting || hasFollow2 || !hasFollow1 || !activeEntrada}
          >
            <Camera className="h-4 w-4 mr-2" />
            {hasFollow2 ? 'Registro 2 completado' : 'Registro 2 (opcional)'}
          </Button>

          {isLoadingFollowups ? (
            <p className="text-xs text-muted-foreground">Cargando seguimientos...</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Registros: {hasFollow1 ? '✅ 1' : '❌ 1'} / {hasFollow2 ? '✅ 2' : '— 2'}
            </p>
          )}
        </div>

        {/* Botones principales */}
        <div className="space-y-4 pt-4">
          <AttendanceButton type="entrada" onClick={() => handleMarkAttendance('entrada')} disabled={isSubmitting || !!activeEntrada}>
            <LogIn className="h-7 w-7" />
            <span>{activeEntrada ? 'Entrada ya registrada' : 'Marcar Entrada'}</span>
          </AttendanceButton>

          <AttendanceButton type="salida" onClick={() => handleMarkAttendance('salida')} disabled={isSubmitting || !hasFollow1}>
            <LogOut className="h-7 w-7" />
            <span>{hasFollow1 ? 'Marcar Salida' : 'Marcar Salida (requiere Registro 1)'}</span>
          </AttendanceButton>
        </div>

        {/* Resumen */}
        {todayRecords.length > 0 && (
          <div className="pt-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Registros de hoy ({todayRecords.length})</h3>
            <div className="space-y-2">
              {todayRecords.slice(0, 4).map((record) => (
                <div key={record.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                  <span
                    className={`text-sm font-medium ${
                      record.tipo_registro === 'entrada' ? 'text-success' : 'text-destructive'
                    }`}
                  >
                    {record.tipo_registro === 'entrada' ? '🟢' : '🔴'} {record.tipo_registro.toUpperCase()}
                  </span>
                  <span className="text-sm text-muted-foreground">{format(new Date(record.timestamp), 'HH:mm')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* ✅ Modal Georreferenciación */}
      <Dialog open={geoOpen} onOpenChange={setGeoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              Ubicación al iniciar turno
            </DialogTitle>
            <DialogDescription>
              Usamos tu ubicación capturada al registrar la entrada (sin pedir GPS dos veces).
            </DialogDescription>
          </DialogHeader>

          {geoInfo ? (
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-muted">
                <p className="text-xs text-muted-foreground">Suerte</p>
                <p className="text-base font-semibold">{geoInfo.nom}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted">
                <p className="text-xs text-muted-foreground">Hacienda/Suerte</p>
                <p className="text-base font-semibold">{geoInfo.hac_ste}</p>
              </div>
              {geoCoords?.accuracy != null && (
                <p className="text-xs text-muted-foreground">Precisión GPS: ±{Math.round(geoCoords.accuracy)} m</p>
              )}
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-muted text-sm">{geoMsg ?? 'Consultando...'}</div>
          )}

          <DialogFooter>
            <Button onClick={() => setGeoOpen(false)}>Aceptar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmationModal
        isOpen={modalState.isOpen}
        onClose={closeModal}
        type={modalState.type}
        success={modalState.success}
        hoursWorked={modalState.hoursWorked}
        error={modalState.error}
      />
    </div>
  );
}
