/**
 * Server-side signals the browser cannot see, plus the one environment fixup the
 * harness is allowed to perform.
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
  if (!cronSecret) {
    return { collected: false, reason: 'FIRST_RUN_AUDIT_CRON_SECRET not set', events: [] };
  }

  try {
    const url = `${baseUrl}/api/ops/events/feed?since=${encodeURIComponent(sinceIso)}&limit=500`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cronSecret}` } });
    if (!res.ok) {
      return { collected: false, reason: `feed HTTP ${res.status}`, events: [] };
    }
    const body = (await res.json()) as { data?: { events?: Array<Record<string, unknown>> } };
    const all = body.data?.events ?? [];

    // Narrow to this run: rows tagged with our instance, plus anything fatal that
    // fired in the window (a fatal during our run is worth seeing even if the
    // row isn't tagged with our instance id).
    const relevant = all.filter((event) => {
      if (instanceId && event.instance_id === instanceId) return true;
      return event.severity === 'fatal';
    });

    return { collected: true, events: relevant };
  } catch (err) {
    return {
      collected: false,
      reason: err instanceof Error ? err.message : String(err),
      events: [],
    };
  }
}

/**
 * Pre-clear the free-tier abuse gate for a synthetic user.
 *
 * WHY THIS EXISTS, precisely: risk-scorer.ts scores `IS_DATACENTER` at +30, which
 * buckets to tier "medium" → decision "require_card". Every hosted CI runner
 * egresses from a datacenter ASN. Without this, an audit run from CI measures the
 * runner's network reputation, not whether Hivra's first run works — it would
 * fail 20/20 at the same place, for a reason no real user on a home connection
 * ever hits.
 *
 * It writes exactly one row (decision=allow, score=0) for one throwaway user that
 * is deleted minutes later. It does not disable the gate, touch any real user, or
 * persist beyond the run.
 *
 * When NOT set, the real gate runs and a card_required response is recorded as a
 * `harness_environment` failure — visible, not silently passed.
 */
export async function preclearAbuseGate(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<void> {
  const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/signup_risk_assessments`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      user_id: userId,
      risk_score: 0,
      risk_tier: 'low',
      decision: 'allow',
      raw_signals: { source: 'first-run-audit', note: 'synthetic audit account' },
    }),
  });

  if (!res.ok) {
    throw new Error(
      `[first-run-audit] risk pre-clear failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }
}

/** Best-effort: remove the synthetic risk row in teardown. */
export async function removeRiskPreclear(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<void> {
  await fetch(
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/signup_risk_assessments?user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    },
  ).catch(() => undefined);
}

/**
 * Give one throwaway Canary audit identity the ordinary Pro compute envelope.
 * This is not a purchase and never targets production: the caller already
 * passes through the canary-only audit guard, and teardown deletes this exact
 * user-scoped row. The 2 CPU / 4 GB envelope is the smallest profile on which
 * the contained desktop recipe can be evaluated honestly.
 */
export async function grantRemoteDesktopAuditPlan(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const res = await fetch(
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/hermes_subscriptions?on_conflict=user_id`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id: userId,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        plan: 'operator',
        status: 'active',
        instance_limit: 3,
        total_cpu_budget: 2,
        total_ram_budget: 4096,
        current_period_start: now,
        current_period_end: null,
        grace_period_ends_at: null,
        updated_at: now,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `[remote-desktop-audit] plan setup failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }
}

export async function removeRemoteDesktopAuditPlan(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, '')}/rest/v1/hermes_subscriptions?user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      },
    );
    return res.ok;
  } catch {
    return false;
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
