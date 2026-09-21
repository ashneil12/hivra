import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import { parseJsonResponse } from '@/lib/http-json';
import { readStoredJson, writeStoredJsonIfChanged } from '@/lib/client-storage';

export interface Profile {
  id: string;
  name: string;
  display_name: string | null;
  avatar_url: string | null;
  model: string | null;
  provider: string | null;
  status: 'stopped' | 'running' | 'creating' | 'error';
  gateway_port: number | null;
  created_at: string;
}

interface UseProfilesOptions {
  summary?: boolean;
}

interface CachedProfiles {
  profiles: Profile[];
  savedAt: string;
}

const PROFILE_CACHE_PREFIX = 'hermes_profile_summary_cache';
const VALID_PROFILE_STATUSES = new Set(['stopped', 'running', 'creating', 'error']);

// 15s upper bound on the profiles list fetch. The dashboard route proxies
// to WebUI on the box; a force-recreate (provider/key save) can leave that
// path hanging for the full Vercel function timeout (~60s) while the
// container restarts, which keeps SWR's `isLoading` true and locks
// every spinner that depends on this hook (sidebar, profile picker,
// settings panel) until the user manually refreshes. Failing fast here
// lets SWR's errorRetry kick in instead.
const PROFILES_FETCH_TIMEOUT_MS = 15_000;

const fetcher = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(PROFILES_FETCH_TIMEOUT_MS) })
    .then((res) => parseJsonResponse<{ data?: Profile[] }>(res))
    .then((data) => data.data ?? []);

function profileCacheKey(instanceId: string): string {
  return `${PROFILE_CACHE_PREFIX}:${instanceId}`;
}

function getStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined'
      ? null
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

function sanitizeProfileSummary(profile: Partial<Profile>): Profile | null {
  if (
    typeof profile.id !== 'string' ||
    typeof profile.name !== 'string' ||
    !profile.id.trim() ||
    !profile.name.trim()
  ) {
    return null;
  }

  const status = typeof profile.status === 'string' && VALID_PROFILE_STATUSES.has(profile.status)
    ? profile.status as Profile['status']
    : 'stopped';

  return {
    id: profile.id,
    name: profile.name,
    display_name: typeof profile.display_name === 'string' ? profile.display_name : null,
    avatar_url: typeof profile.avatar_url === 'string' ? profile.avatar_url : null,
    model: typeof profile.model === 'string' ? profile.model : null,
    provider: typeof profile.provider === 'string' ? profile.provider : null,
    status,
    gateway_port: typeof profile.gateway_port === 'number' ? profile.gateway_port : null,
    created_at: typeof profile.created_at === 'string' ? profile.created_at : '',
  };
}

function sanitizeProfileSummaries(profiles: Profile[]): Profile[] {
  return profiles
    .map((profile) => sanitizeProfileSummary(profile))
    .filter((profile): profile is Profile => Boolean(profile));
}

export function readCachedProfileSummaries(instanceId: string | undefined): Profile[] | undefined {
  if (!instanceId) return undefined;
  const storage = getStorage();
  if (!storage) return undefined;

  const cached = readStoredJson<CachedProfiles>(storage, profileCacheKey(instanceId));
  if (!cached || !Array.isArray(cached.profiles)) {
    return undefined;
  }

  const profiles = sanitizeProfileSummaries(cached.profiles);
  return profiles.length > 0 ? profiles : undefined;
}

function writeCachedProfileSummaries(instanceId: string, profiles: Profile[]): void {
  const storage = getStorage();
  if (!storage) return;

  const sanitized = sanitizeProfileSummaries(profiles);
  if (sanitized.length === 0) return;

  try {
    writeStoredJsonIfChanged(storage, profileCacheKey(instanceId), {
      profiles: sanitized,
      savedAt: new Date().toISOString(),
    });
  } catch {
    // Profile summaries only speed up the rail; the server response remains authoritative.
  }
}

function buildProfilesPath(instanceId: string, options?: UseProfilesOptions): string {
  return `/api/instances/${instanceId}/profiles${options?.summary ? '?summary=true' : ''}`;
}

function buildProfilesSyncPath(instanceId: string, options?: UseProfilesOptions): string {
  return `/api/instances/${instanceId}/profiles?sync=true${options?.summary ? '&summary=true' : ''}`;
}

export function useProfiles(instanceId: string | undefined, options?: UseProfilesOptions) {
  const summary = options?.summary === true;
  const hasRequestedLiveSyncRef = useRef<string | null>(null);
  const profilesPath = instanceId ? buildProfilesPath(instanceId, { summary }) : null;
  const { data, error, isLoading, mutate } = useSWR<Profile[]>(
    profilesPath,
    fetcher,
    {
      fallbackData: summary ? readCachedProfileSummaries(instanceId) : undefined,
      refreshInterval: 30000,
      revalidateOnFocus: true,
      onSuccess: (profiles) => {
        if (instanceId && summary) {
          writeCachedProfileSummaries(instanceId, profiles);
        }
      },
    }
  );

  useEffect(() => {
    if (!instanceId || hasRequestedLiveSyncRef.current === instanceId) {
      return;
    }

    hasRequestedLiveSyncRef.current = instanceId;
    void mutate(
      (currentProfiles) =>
        fetcher(buildProfilesSyncPath(instanceId, { summary })).catch(() => currentProfiles ?? []),
      {
        populateCache: true,
        revalidate: false,
        rollbackOnError: false,
      }
    );
  }, [instanceId, mutate, summary]);

  return {
    profiles: data || [],
    isLoading,
    isError: error,
    mutate
  };
}

