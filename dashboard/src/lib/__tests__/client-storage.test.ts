import {
  clearHermesStorage,
  readStoredJson,
  writeStoredJsonIfChanged,
} from "@/lib/client-storage";

type MemoryStorage = Storage & {
  dump(): Record<string, string>;
};

function createMemoryStorage(initialEntries: Record<string, string> = {}): MemoryStorage {
  const map = new Map(Object.entries(initialEntries));

  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    dump() {
      return Object.fromEntries(map.entries());
    },
  } as MemoryStorage;
}

describe("client-storage helpers", () => {
  it("writes JSON when a key is missing", () => {
    const storage = createMemoryStorage();

    expect(writeStoredJsonIfChanged(storage, "dashboard_usage_user", { usedCpu: 2 })).toBe(true);
    expect(storage.getItem("dashboard_usage_user")).toBe('{"usedCpu":2}');
  });

  it("skips redundant writes when the serialized payload is unchanged", () => {
    const storage = createMemoryStorage({
      dashboard_usage_user: '{"usedCpu":2}',
    });
    const setItemSpy = jest.spyOn(storage, "setItem");

    expect(writeStoredJsonIfChanged(storage, "dashboard_usage_user", { usedCpu: 2 })).toBe(false);
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("treats denied JSON writes as a skipped write instead of crashing", () => {
    const storage = {
      getItem: jest.fn(() => {
        throw new DOMException("storage denied", "SecurityError");
      }),
      setItem: jest.fn(() => {
        throw new DOMException("storage denied", "SecurityError");
      }),
    };

    expect(writeStoredJsonIfChanged(storage, "dashboard_usage_user", { usedCpu: 2 })).toBe(false);
    expect(storage.setItem).toHaveBeenCalledWith("dashboard_usage_user", '{"usedCpu":2}');
  });

  it("parses stored JSON and safely returns undefined for invalid payloads", () => {
    const storage = createMemoryStorage({
      valid: '{"ok":true}',
      broken: "{",
    });

    expect(readStoredJson<{ ok: boolean }>(storage, "valid")).toEqual({ ok: true });
    expect(readStoredJson(storage, "broken")).toBeUndefined();
  });

  it("clears Hermes-owned keys without touching unrelated local storage", () => {
    const storage = createMemoryStorage({
      hermes_os_settings: "{}",
      dashboard_instances_user: "[]",
      telemetry_instance_user: "{}",
      unrelated_app_key: "keep-me",
    });

    clearHermesStorage(storage);

    expect(storage.dump()).toEqual({
      unrelated_app_key: "keep-me",
    });
  });
});
