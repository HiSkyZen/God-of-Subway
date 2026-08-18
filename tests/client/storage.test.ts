import { describe, expect, test } from "bun:test";
import { isRecord, readStorage, STORAGE_KEYS, writeStorage } from "../../src/client/storage";

describe("client storage adapter", () => {
  test("preserves compatibility keys and validates parsed schemas", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    writeStorage(storage, STORAGE_KEYS.favorites, [{ id: "fav-1" }]);
    const favorites = readStorage(storage, STORAGE_KEYS.favorites, [], (value): value is Array<{ id: string }> => Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.id === "string"));
    expect(favorites).toEqual([{ id: "fav-1" }]);
    values.set(STORAGE_KEYS.favorites, "{broken");
    expect(readStorage(storage, STORAGE_KEYS.favorites, [], Array.isArray)).toEqual([]);
    expect(STORAGE_KEYS.liveTrip).toBe("jigeumta_live_trip_v2");
  });
});
