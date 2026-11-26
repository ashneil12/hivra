/**
 * Server-side signals the browser cannot see.
 */

/**
 * Pull the ops events this run produced.
 *
 * `/api/ops/events/feed` is bearer-CRON_SECRET and filters by `since`/`severity`
 * only — it exposes no instance filter — so we pull a window and narrow locally.
 */
export async function collectOpsEvents(
  baseUrl: string,
  cronSecret: string | undefined,
  sinceIso: string,
  instanceId: string | null,
): Promise<{ collected: boolean; reason?: string; events: Array<Record<string, unknown>> }> {
  if (!instanceId) return { collected: false, reason: 'No run instance yet', events: [] };
  if (!cronSecret) {
    return { collected: false, reason: 'FIRST_RUN_AUDIT_CRON_SECRET not set', events: [] };
  }

  try {
    const url = `${baseUrl}/api/ops/events/feed?since=${encodeURIComponent(sinceIso)}&limit=500`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cronSecret}` }, redirect: 'error' });
    if (!res.ok) {
      return { collected: false, reason: `feed HTTP ${res.status}`, events: [] };
    }
    const body = (await res.json()) as { data?: { events?: Array<Record<string, unknown>> } };
    const all = body.data?.events ?? [];

    const relevant = all.filter((event) => event.instance_id === instanceId)
      .map(({ severity, route, first_seen_at, last_seen_at, occurrence_count }) =>
        ({ severity, route, first_seen_at, last_seen_at, occurrence_count }));

    return { collected: true, events: relevant };
  } catch (err) {
    return {
      collected: false,
      reason: err instanceof Error ? err.message : String(err),
      events: [],
    };
  }
}

export async function remoteDesktopAuditRows(
  supabaseUrl: string,
  serviceRoleKey: string,
  computerId: string,
): Promise<{ capabilities: Array<Record<string, unknown>>; sessions: Array<Record<string, unknown>> }> {
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
  const root = supabaseUrl.replace(/\/$/, '');
  const id = encodeURIComponent(computerId);
  const [capabilities, sessions] = await Promise.all([
    fetch(`${root}/rest/v1/hivra_remote_desktop_capabilities?computer_id=eq.${id}&select=computer_id,generation,revoked_at,expires_at`, { headers }),
    fetch(`${root}/rest/v1/hivra_remote_desktop_sessions?computer_id=eq.${id}&select=id,input_state,revoked_at,expires_at`, { headers }),
  ]);
  if (!capabilities.ok || !sessions.ok) {
    throw new Error(`[remote-desktop-audit] evidence query failed: HTTP ${capabilities.status}/${sessions.status}`);
  }
  const capabilityRows = await capabilities.json() as unknown;
  const sessionRows = await sessions.json() as unknown;
  if (!Array.isArray(capabilityRows) || !Array.isArray(sessionRows)) {
    throw new Error('[remote-desktop-audit] evidence query returned an invalid shape');
  }
  return {
    capabilities: capabilityRows as Array<Record<string, unknown>>,
    sessions: sessionRows as Array<Record<string, unknown>>,
  };
}
