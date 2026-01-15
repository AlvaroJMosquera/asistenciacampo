import { openDB, IDBPDatabase } from 'idb';

export interface PendingRecord {
  id: string;
  user_id: string;
  fecha: string;
  tipo_registro: 'entrada' | 'salida';
  timestamp: string;
  latitud: number | null;
  longitud: number | null;
  precision_gps: number | null;
  fuera_zona: boolean;
  foto_blob: Blob | null;
  foto_url: string | null;
  es_inconsistente: boolean;
  nota_inconsistencia: string | null;
  created_at: string;
}

const DB_NAME = 'asistencia-agricola';
const DB_VERSION = 1;
const STORE_PENDING = 'pending-records';

let dbInstance: IDBPDatabase | null = null;

export async function getDB(): Promise<IDBPDatabase> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_PENDING)) {
        const store = db.createObjectStore(STORE_PENDING, { keyPath: 'id' });
        store.createIndex('user_id', 'user_id');
        store.createIndex('fecha', 'fecha');
        store.createIndex('timestamp', 'timestamp');
      }
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
