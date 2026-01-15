import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { LogIn, LogOut, User, Leaf, Settings } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useAttendance } from '@/hooks/useAttendance';
import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { AttendanceButton } from '@/components/AttendanceButton';
import { LastRecordCard } from '@/components/LastRecordCard';
import { HoursWorkedCard } from '@/components/HoursWorkedCard';
import { ConfirmationModal } from '@/components/ConfirmationModal';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';

export default function OperarioHome() {
  const { profile, isSupervisor, signOut } = useAuth();
  const { isSubmitting, error, lastRecord, todayRecords, markAttendance, getTodayRecords, calculateHoursWorked } = useAttendance();

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    type: 'entrada' | 'salida';
    success: boolean;
    hoursWorked?: number | null;
    error?: string | null;
  }>({
    isOpen: false,
    type: 'entrada',
    success: false,
  });

  useEffect(() => {
    getTodayRecords();
  }, [getTodayRecords]);

  const today = format(new Date(), "EEEE, d 'de' MMMM", { locale: es });
  const hoursWorked = calculateHoursWorked();

  const handleMarkAttendance = async (tipo: 'entrada' | 'salida') => {
    const result = await markAttendance(tipo);
    setModalState({
      isOpen: true,
      type: tipo,
      success: result.success,
      hoursWorked: result.hoursWorked,
      error: result.success ? null : error,
    });
  };

  const closeModal = () => {
    setModalState((prev) => ({ ...prev, isOpen: false }));
  };

  // Determine last action to suggest next
  const lastAction = lastRecord?.tipo_registro;
  const suggestSalida = lastAction === 'entrada';

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
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

      {/* Main content */}
      <main className="flex-1 p-4 space-y-4 max-w-lg mx-auto w-full">
        {/* Sync status */}
        <div className="flex justify-center">
          <SyncStatusBadge />
        </div>

        {/* Hours worked today */}
        <HoursWorkedCard hours={hoursWorked} />

        {/* Last record */}
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-2">Último registro hoy</h2>
          <LastRecordCard record={lastRecord} />
        </div>

        {/* Action buttons */}
        <div className="space-y-4 pt-4">
          <AttendanceButton
            type="entrada"
            onClick={() => handleMarkAttendance('entrada')}
            disabled={isSubmitting}
            isLoading={isSubmitting && !suggestSalida}
          >
            <LogIn className="h-7 w-7" />
            <span>Marcar Entrada</span>
          </AttendanceButton>

          <AttendanceButton
            type="salida"
            onClick={() => handleMarkAttendance('salida')}
            disabled={isSubmitting}
            isLoading={isSubmitting && suggestSalida}
          >
            <LogOut className="h-7 w-7" />
            <span>Marcar Salida</span>
          </AttendanceButton>
        </div>

        {/* Today's records summary */}
        {todayRecords.length > 0 && (
          <div className="pt-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Registros de hoy ({todayRecords.length})
            </h3>
            <div className="space-y-2">
              {todayRecords.slice(0, 4).map((record) => (
                <div
                  key={record.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                >
                  <span
                    className={`text-sm font-medium ${
                      record.tipo_registro === 'entrada' ? 'text-success' : 'text-destructive'
                    }`}
                  >
                    {record.tipo_registro === 'entrada' ? '🟢' : '🔴'} {record.tipo_registro.toUpperCase()}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {format(new Date(record.timestamp), 'HH:mm')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Confirmation Modal */}
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
