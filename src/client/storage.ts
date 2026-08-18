export const STORAGE_KEYS = {
  favorites: "jigeumta_favorites_v1",
  liveTrip: "jigeumta_live_trip_v2",
  experiments: "jigeumta_experiments_v1",
  activeExperiment: "jigeumta_active_experiment_v1",
  pushEndpoint: "jigeumta_push_endpoint_v1",
  pushManagement: "jigeumta_push_management_v1",
  pushAlert: "jigeumta_push_alert_v1",
} as const;

export interface StorageReader {
  getItem(key: string): string | null;
}

export interface StorageWriter {
  setItem(key: string, value: string): void;
}

export type StorageGuard<T> = (value: unknown) => value is T;

export function readStorage<T>(storage: StorageReader, key: string, fallback: T, guard: StorageGuard<T>): T {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : fallback;
  } catch { return fallback; }
}

export function writeStorage<T>(storage: StorageWriter, key: string, value: T): void {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* private browsing or quota */ }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
