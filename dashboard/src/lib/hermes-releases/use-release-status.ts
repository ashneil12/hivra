'use client';

// Client hook behind the "Update available" notice: reads
// GET /api/instances/[id]/release-status. Best effort — a failed, non-JSON or
// non-2xx answer leaves `status` null instead of throwing, so the agent page
// never breaks over a missing notice.
import { useCallback, useEffect, useRef, useState } from 'react';

export type ReleaseDirection = 'none' | 'upgrade' | 'rollback' | 'unknown_current';
export type ReleaseUpdateHealth = 'ok' | 'paused' | 'failed' | 'rolled_back';

export interface ReleaseStatus {
  channel: string | null;
  currentVersion: string | null;
  currentDigest: string | null;
  reportedAt: string | null;
  updateAvailable: boolean;
  direction: ReleaseDirection;
  target: { version: string; digest: string } | null;
  updateHealth: ReleaseUpdateHealth | null;
  updateHealthDetail: string | null;
  updateHealthAt: string | null;
  updateStackVersion: number | null;
}

async function fetchReleaseStatus(instanceId: string): Promise<ReleaseStatus | null> {
  const res = await fetch(`/api/instances/${instanceId}/release-status`, { cache: 'no-store' });
  if (!res || !res.ok) return null;
  const body = await res.json().catch(() => null);
  if (!body?.success || !body.data || typeof body.data !== 'object') return null;
  return body.data as ReleaseStatus;
}

export function useReleaseStatus(instanceId: string) {
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every request and on unmount, so a slow answer for an older id
  // (or a closed page) never overwrites newer state.
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const next = await fetchReleaseStatus(instanceId);
      if (requestId !== requestRef.current) return;
      setStatus(next);
      setError(next ? null : 'Release status unavailable');
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setStatus(null);
      setError(err instanceof Error ? err.message : 'Release status unavailable');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    setStatus(null);
    setLoading(true);
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      requestRef.current += 1;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { status, loading, error, refresh };
}
