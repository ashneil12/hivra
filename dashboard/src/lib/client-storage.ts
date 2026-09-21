const HERMES_LOCAL_STORAGE_PREFIXES = ["hermes_", "dashboard_", "telemetry_"] as const;

export function clearHermesStorage(
  storage: Storage = localStorage,
  prefixes: readonly string[] = HERMES_LOCAL_STORAGE_PREFIXES
): void {
  const keysToRemove: string[] = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach((key) => storage.removeItem(key));
}

export function readStoredJson<T>(
  storage: Pick<Storage, "getItem"> = localStorage,
  key: string
): T | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return undefined;
  }

  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function writeStoredJsonIfChanged(
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  key: string,
  value: unknown
): boolean {
  const serialized = JSON.stringify(value);
  try {
    if (storage.getItem(key) === serialized) {
      return false;
    }
  } catch {
    // Storage can be denied by browser privacy settings; still try the write.
  }

  try {
    storage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}
