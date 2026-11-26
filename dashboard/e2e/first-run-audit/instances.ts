/**
 * Instance lifecycle over the app's OWN HTTP surface.
 *
 * Teardown deliberately goes through `DELETE /api/instances/[id]` rather than
 * `qm destroy` on the host: the route tears down the VM, removes the Caddy
 * vhost, releases the VMID claim, cleans DNS, and only then marks the row
 * deleted — and it refuses (502) to mark the row deleted if the hypervisor
 * teardown failed. Reaching around it is how you create the orphan class this
 * harness exists to avoid producing.
 */
import type { APIRequestContext } from '@playwright/test';
import { auditAgentName } from './config';

export interface InstanceSummary {
  id: string;
  name: string;
  status: string;
  lifecycle_state?: string;
  provider?: string;
  host_id?: string | null;
  created_at?: string;
  config?: Record<string, unknown> | null;
}

export interface HivraAgentSummary {
  id: string;
  name: string;
  status: string;
  operation_kind?: string | null;
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
}

export interface HealthProbe {
  isReady: boolean;
  status?: string;
  error?: string;
}

export interface WorkspaceHandoff {
  ready: boolean;
  httpStatus: number;
  /** Present only when ready. Never logged — it is a signed login URL. */
  hasUrl: boolean;
  /**
   * The ORIGIN of the handoff URL (scheme + host, no path, no token). Safe to
   * log and to persist in a verdict, and it is what identifies the workspace
   * iframe's document response among any other iframes on the page.
   */
  origin?: string;
  pendingReason?: string;
  instanceStatus?: string;
}

export async function listInstances(
  request: APIRequestContext,
  baseUrl: string,
  requireVerifiedList = false,
): Promise<InstanceSummary[]> {
  const res = await request.get(`${baseUrl}/api/instances?summary=true`, { timeout: 90_000 });
  if (!res.ok()) {
    if (requireVerifiedList) throw new Error(`Instance inventory failed: HTTP ${res.status()}`);
    return [];
  }
  const body = (await res.json().catch(() => null)) as ApiEnvelope<InstanceSummary[]> | null;
  if (requireVerifiedList && (body?.success !== true || !Array.isArray(body.data) ||
    body.data.some((row) => typeof row?.id !== 'string' || !row.id || typeof row.name !== 'string'))) {
    throw new Error('Instance inventory response was not verified');
  }
  return Array.isArray(body?.data) ? body.data : [];
}

/** Active Hivra computers owned by the authenticated audit account. */
export async function listHivraAgents(
  request: APIRequestContext,
  baseUrl: string,
  requireVerifiedList = false,
): Promise<HivraAgentSummary[]> {
  const res = await request.get(`${baseUrl}/api/hivra/agents`, { timeout: 90_000 }).catch((error: unknown) => {
    if (requireVerifiedList) throw new Error('Agent inventory request failed');
    throw error;
  });
  if (!res.ok()) {
    if (requireVerifiedList) throw new Error(`Agent inventory failed: HTTP ${res.status()}`);
    return [];
  }
  const body = (await res.json().catch(() => null)) as
    | ApiEnvelope<{ agents?: HivraAgentSummary[] }>
    | null;
  const agents = body?.data?.agents;
  if (requireVerifiedList && (
    body?.success !== true || !Array.isArray(agents) ||
    agents.some((agent) => typeof agent?.id !== 'string' || !agent.id || typeof agent.name !== 'string')
  )) throw new Error('Agent inventory response was not verified');
  return Array.isArray(agents) ? agents : [];
}

export async function getInstance(
  request: APIRequestContext,
  baseUrl: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const res = await request.get(`${baseUrl}/api/instances/${id}`, { timeout: 90_000 });
  if (!res.ok()) return null;
  const body = (await res.json().catch(() => null)) as ApiEnvelope<
    Record<string, unknown>
  > | null;
  return body?.data ?? null;
}

/** The app's own readiness probe: 200 from the box's gateway `/health`. */
export async function probeHealth(
  request: APIRequestContext,
  baseUrl: string,
  id: string,
): Promise<HealthProbe> {
  const res = await request.get(`${baseUrl}/api/instances/${id}/health`, {
    headers: { Accept: 'application/json' },
    timeout: 60_000,
  });
  if (!res.ok()) return { isReady: false, error: `health HTTP ${res.status()}` };
  const body = (await res.json().catch(() => null)) as HealthProbe | null;
  return body ?? { isReady: false, error: 'unparseable health response' };
}

/**
 * The gate the real chat workspace uses. 202 = still pending (with a machine
 * readable reason), 200 = a signed handoff URL the iframe can load.
 */
export async function probeWorkspaceHandoff(
  request: APIRequestContext,
  baseUrl: string,
  id: string,
): Promise<WorkspaceHandoff> {
  const res = await request.get(`${baseUrl}/api/instances/${id}/webui-login-url`, {
    timeout: 60_000,
  });
  const status = res.status();
  const body = (await res.json().catch(() => null)) as {
    url?: string;
    kind?: string;
    reason?: string;
    instanceStatus?: string;
  } | null;

  let origin: string | undefined;
  if (body?.url) {
    try {
      origin = new URL(body.url).origin;
    } catch {
      origin = undefined;
    }
  }

  return {
    ready: status === 200 && Boolean(body?.url),
    httpStatus: status,
    hasUrl: Boolean(body?.url),
    ...(origin ? { origin } : {}),
    pendingReason: body?.reason,
    instanceStatus: body?.instanceStatus,
  };
}

/**
 * The instance's status as the PRODUCT's own readiness poll observes it.
 *
 * This is `GET /api/instances/[id]` — the exact route the welcome flow polls
 * while a user watches their agent come up. Using it (rather than the cheaper
 * `/health`) matters for more than fidelity: that route is one of the sites
 * that fires the post-ready SOUL.md reconcile on the `provisioning → running`
 * transition (soul-seed-reconcile.ts). `/health` ALSO promotes the row, but
 * schedules no reconcile — so an audit that polls `/health` wins the race,
 * flips the row first, and silently robs the box of its persona seed. The
 * harness must observe the product, not perturb it.
 */
export async function probeInstanceStatus(
  request: APIRequestContext,
  baseUrl: string,
  id: string,
): Promise<{ status: string | null; httpStatus: number }> {
  const res = await request.get(`${baseUrl}/api/instances/${id}`, { timeout: 90_000 });
  if (!res.ok()) return { status: null, httpStatus: res.status() };
  const body = (await res.json().catch(() => null)) as ApiEnvelope<{ status?: string }> | null;
  const status = typeof body?.data?.status === 'string' ? body.data.status : null;
  return { status, httpStatus: res.status() };
}

export interface DestroyResult {
  id: string;
  deleted: boolean;
  httpStatus: number;
  error?: string;
}

/**
 * Destroy one instance through the product's confirm-gated delete.
 *
 * The route requires `confirmation === <instance id>` verbatim, mirroring what a
 * user types in the delete modal.
 */
export async function destroyInstance(
  request: APIRequestContext,
  baseUrl: string,
  id: string,
  note: string,
): Promise<DestroyResult> {
  try {
    const res = await request.delete(`${baseUrl}/api/instances/${id}`, {
      data: {
        confirmation: id,
        deleteReason: 'just_testing',
        deleteReasonNote: note.slice(0, 2000),
      },
      // Hypervisor teardown + Caddy reload + DNS cleanup runs inline.
      timeout: 5 * 60_000,
    });
    return { id, deleted: res.ok(), httpStatus: res.status(), error: res.ok() ? undefined : await safeText(res) };
  } catch (err) {
    return {
      id,
      deleted: false,
      httpStatus: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return 'unreadable body';
  }
}

export async function runInventory(request: APIRequestContext, baseUrl: string, runId: string) {
  const name = auditAgentName(runId);
  const [agents, instances] = await Promise.all([
    listHivraAgents(request, baseUrl, true),
    listInstances(request, baseUrl, true),
  ]);
  const owned = { agents: agents.filter((row) => row.name === name), instances: instances.filter((row) => row.name === name) };
  if (owned.agents.length + owned.instances.length > 1) {
    throw new Error('More than one resource matched the audit run ID; refusing ambiguous cleanup.');
  }
  return owned;
}

export async function assertUnusedRunId(request: APIRequestContext, baseUrl: string, runId: string): Promise<void> {
  const { agents, instances } = await runInventory(request, baseUrl, runId);
  if (agents.length || instances.length) throw new Error('The audit run ID already has a resource; refusing to launch.');
}

export async function destroyRunResources(
  request: APIRequestContext,
  baseUrl: string,
  runId: string,
  attempts = 30,
  retryDelayMs = 15_000,
): Promise<{ destroyed: string[]; survived: DestroyResult[] }> {
  const destroyed = new Set<string>();
  let last: DestroyResult | undefined;
  let ownedId: string | undefined;

  for (let attempt = 0; attempt <= attempts; attempt++) {
    const { agents: [agent], instances: [instance] } = await runInventory(request, baseUrl, runId);
    const id = agent?.id ?? instance?.id;
    if (!id) return { destroyed: [...destroyed], survived: [] };
    if (ownedId && ownedId !== id) throw new Error('Audit resource identity changed during cleanup.');
    ownedId = id;
    if (attempt === attempts) {
      return { destroyed: [...destroyed], survived: [{
        id, deleted: false, httpStatus: last?.httpStatus ?? 0, error: 'Still listed after cleanup',
      }] };
    }

    if (agent) {
      const res = await request.delete(`${baseUrl}/api/hivra/agents/${encodeURIComponent(id)}`, {
        headers: { Origin: baseUrl }, timeout: 2 * 60_000,
      });
      last = { id, deleted: res.ok(), httpStatus: res.status() };
    } else {
      last = await destroyInstance(request, baseUrl, id, `audit run ${runId}`);
    }
    if (last.deleted) destroyed.add(id);
    if (retryDelayMs > 0) await sleep(retryDelayMs);
  }
  throw new Error('Audit cleanup budget exhausted.');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Did the box boot with inference actually configured?
 *
 * This is the difference between "the workspace loads" and "the agent can
 * answer". A clean-slate deploy boots with no model and no key.
 *
 * ── READ THE ROW, NOT THE FORM ─────────────────────────────────────────────
 * The first version of this predicate tested `config.providerId`. That field is
 * a CLIENT-SIDE concept: `buildWelcomeAgentSettings` (src/lib/welcome-deploy.ts)
 * consumes a `providerId` prop, but what reaches the database is the top-level
 * `provider` COLUMN — `config.providerId` is never written. 0 of 27 canary
 * instances have the key. The predicate was therefore false for EVERY instance
 * that has ever existed, which meant `agent_replied` early-returned
 * `unconfigured_provider` and could never pass, on any box, ever. A gate that
 * cannot go green is not a strict gate; it is a disabled one that looks strict.
 *
 * Neither the `provider` COLUMN nor `config.model` will do on its own. A
 * clean-slate deploy POSTs `{unconfigured: true}`, and the server still stores
 * the benign defaults `provider='openrouter'` and `config.model='openai/
 * gpt-5.4-pro'` so redeploy/PROVIDER_ID_MAP lookups don't throw.
 * Measured on canary: all five clean-slate audit boxes carry exactly those two
 * values. A box that cannot answer looks fully configured in both fields.
 *
 * What the agent actually configures inference from is
 * `config.agentSettings.fallbackModels` — `buildWelcomeAgentSettings` writes
 * `[{provider:"",model:"",apiKey:""}]` for clean slate and
 * `[{provider:"venice",model:"deepseek-v4-flash",...}]` for managed. That is the
 * honest signal, and it separates the canary population cleanly.
 *
 * Older rows predate `fallbackModels` and have no such key; for those we fall
 * back to the column + `config.model`, which is correct for them (they were all
 * deployed with a real provider).
 */
export function isInferenceConfigured(instance: Record<string, unknown> | null): boolean {
  if (!instance) return false;
  const config = instance.config;
  if (!config || typeof config !== 'object') return false;
  const cfg = config as Record<string, unknown>;

  const fallback = readFallbackModel(cfg);
  if (fallback) {
    return fallback.provider.trim().length > 0 && fallback.model.trim().length > 0;
  }

  // Legacy rows only. `provider` is a top-level column, spread into the API's
  // `data` by `apiSuccess({...instance})`.
  const provider = typeof instance.provider === 'string' ? instance.provider : '';
  const model = typeof cfg.model === 'string' ? cfg.model : '';
  return provider.trim().length > 0 && model.trim().length > 0;
}

/** `agentSettings.fallbackModels` is stored as a JSON *string*. */
function readFallbackModel(
  cfg: Record<string, unknown>,
): { provider: string; model: string } | null {
  const agentSettings = cfg.agentSettings;
  if (!agentSettings || typeof agentSettings !== 'object') return null;
  const raw = (agentSettings as Record<string, unknown>).fallbackModels;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first = parsed[0] as Record<string, unknown>;
    return {
      provider: typeof first.provider === 'string' ? first.provider : '',
      model: typeof first.model === 'string' ? first.model : '',
    };
  } catch {
    return null;
  }
}
