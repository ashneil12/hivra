export type InstanceSurfacePreference = "chat" | "tui";

const INSTANCE_SURFACE_PREFIX = "hermes_surface_";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
type InstanceSurfaceBackend = "gateway" | "webui" | string | null | undefined;
type SurfacePreferenceStorage = Pick<Storage, "getItem"> | { getItem: (key: string) => string | null };

function isInstanceSurfacePreference(value: unknown): value is InstanceSurfacePreference {
  return value === "chat" || value === "tui";
}

export function getInstanceSurfaceCookieName(instanceId: string): string {
  return `${INSTANCE_SURFACE_PREFIX}${instanceId}`;
}

export function getInstanceSurfaceHref(
  instanceId: string,
  surface: InstanceSurfacePreference,
  options?: { forceSurface?: boolean }
): string {
  if (surface === "tui") {
    return `/dashboard/instances/${instanceId}/tui`;
  }

  const baseHref = `/dashboard/instances/${instanceId}`;
  return options?.forceSurface ? `${baseHref}?surface=chat` : baseHref;
}

export function getDefaultInstanceSurfacePreference(
  backend?: InstanceSurfaceBackend
): InstanceSurfacePreference {
  void backend;
  return "chat";
}

export function getStoredInstanceSurfacePreference(
  instanceId: string,
  storage: SurfacePreferenceStorage = localStorage,
  defaultSurface: InstanceSurfacePreference = "chat"
): InstanceSurfacePreference {
  try {
    const storedValue = storage.getItem(getInstanceSurfaceCookieName(instanceId));
    return isInstanceSurfacePreference(storedValue) ? storedValue : defaultSurface;
  } catch {
    return defaultSurface;
  }
}

export function setStoredInstanceSurfacePreference(
  instanceId: string,
  surface: InstanceSurfacePreference,
  options?: {
    storage?: Pick<Storage, "setItem"> | { setItem: (key: string, value: string) => void };
    cookieWriter?: (cookieValue: string) => void;
  }
) {
  const key = getInstanceSurfaceCookieName(instanceId);
  const storage = options?.storage;
  const cookieWriter =
    options?.cookieWriter ??
    ((cookieValue: string) => {
      if (typeof document !== "undefined") {
        document.cookie = cookieValue;
      }
    });

  storage?.setItem(key, surface);
  cookieWriter(`${key}=${surface}; path=/; max-age=${ONE_YEAR_SECONDS}`);
}

export function readInstanceSurfacePreferenceCookie(
  cookieStore: { get: (name: string) => { value?: string } | undefined },
  instanceId: string,
  defaultSurface: InstanceSurfacePreference = "chat"
): InstanceSurfacePreference {
  const storedValue = cookieStore.get(getInstanceSurfaceCookieName(instanceId))?.value;
  return isInstanceSurfacePreference(storedValue) ? storedValue : defaultSurface;
}
