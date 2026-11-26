function headers(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * The agent's own lifecycle events, with their stored detail, read before
 * teardown deletes the agent (and its host log with it). Kept in the local
 * result file only; failure details can carry host names.
 */
export async function agentEvidence(
  supabaseUrl: string,
  serviceRoleKey: string,
  agentId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, '')}/rest/v1/hivra_agent_events?agent_id=eq.${encodeURIComponent(agentId)}&select=event,detail,created_at&order=created_at.desc&limit=15`,
      { headers: headers(serviceRoleKey) },
    );
    if (!res.ok) return [{ error: `events HTTP ${res.status}` }];
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
  } catch (err) {
    return [{ error: err instanceof Error ? err.message : String(err) }];
  }
}

/**
 * What Canary's own records still hold for this account, read with the
 * service role. The app's list can come back empty for reasons that have
 * nothing to do with deletion, so certify teardown against the records.
 */
export async function agentsStillOnRecord(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  name?: string,
): Promise<Array<{ id: string; status: string; vmid: number | null }> | null> {
  try {
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, '')}/rest/v1/hivra_agents?user_id=eq.${encodeURIComponent(userId)}&status=neq.deleted&select=id,status,vmid${name ? `&name=eq.${encodeURIComponent(name)}` : ''}`,
      { headers: headers(serviceRoleKey) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? (rows as Array<{ id: string; status: string; vmid: number | null }>) : null;
  } catch {
    return null;
  }
}
