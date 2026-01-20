import { openDB, IDBPDatabase, DBSchema } from 'idb';

export interface PendingRecord {
  id: string;
  user_id: string;
  fecha: string; // YYYY-MM-DD
  tipo_registro: 'entrada' | 'salida';
  timestamp: string; // ISO
  latitud: number | null;
  longitud: number | null;
  precision_gps: number | null;
  fuera_zona: boolean;
  foto_blob: Blob | null;
  foto_url: string | null;
  es_inconsistente: boolean;
  nota_inconsistencia: string | null;
  created_at: string; // ISO

  // ✅ ubicación calculada por geocerca (si estaba online al registrar)
  hac_ste?: string | null;
  suerte_nom?: string | null;
}

const DB_NAME = 'asistencia-agricola';
const DB_VERSION = 2; // ✅ sube versión para upgrade seguro
const STORE_PENDING = 'pending-records';

interface AsistenciaDB extends DBSchema {
  [STORE_PENDING]: {
    key: string;
    value: PendingRecord;
    indexes: {
      'user_id': string;
      'fecha': string;
      'timestamp': string;
      'user_fecha': [string, string]; // ✅ compuesto: user_id + fecha
    };
  };
}

let dbInstance: IDBPDatabase<AsistenciaDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<AsistenciaDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<AsistenciaDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // v1 -> v2: asegurar store e índices
      let store: any;

      if (!db.objectStoreNames.contains(STORE_PENDING)) {
        store = db.createObjectStore(STORE_PENDING, { keyPath: 'id' });
      } else {
        store = db.transaction.objectStore(STORE_PENDING);
      }

      // índices básicos (idempotente)
      if (!store.indexNames.contains('user_id')) store.createIndex('user_id', 'user_id');
      if (!store.indexNames.contains('fecha')) store.createIndex('fecha', 'fecha');
      if (!store.indexNames.contains('timestamp')) store.createIndex('timestamp', 'timestamp');

      // ✅ índice compuesto para consultas rápidas por usuario+fecha
      if (!store.indexNames.contains('user_fecha')) store.createIndex('user_fecha', ['user_id', 'fecha']);

      // oldVersion se deja por claridad (por si luego agregas migraciones)
      void oldVersion;
    },
  });

  return dbInstance;
}

export async function savePendingRecord(record: PendingRecord): Promise<void> {
  const db = await getDB();
  await db.put(STORE_PENDING, record);
}

export async function getPendingRecords(): Promise<PendingRecord[]> {
  const db = await getDB();
  return db.getAll(STORE_PENDING);
}

export async function getPendingRecordsByUser(userId: string): Promise<PendingRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex(STORE_PENDING, 'user_id', userId);
}

/**
 * ✅ NUEVO: trae pendientes por usuario y fecha (mucho más rápido que filtrar a mano).
 */
export async function getPendingRecordsByUserAndDate(userId: string, fecha: string): Promise<PendingRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex(STORE_PENDING, 'user_fecha', [userId, fecha]);
}

export async function deletePendingRecord(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_PENDING, id);
}

export async function getPendingCount(): Promise<number> {
  const db = await getDB();
  return db.count(STORE_PENDING);
}

export async function clearAllPendingRecords(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE_PENDING);
}
