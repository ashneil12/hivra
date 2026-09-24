import {
  createAgent,
  findHivraLaunchReceipt,
  HivraLaunchCorrectableError,
  HivraLaunchInProgressError,
  HivraLaunchRejectedError,
  listAgentsResult,
  type CreateAgentInput,
  type HivraAgent,
} from "@/lib/hivra/agent-api";
import type { AgentDeploymentDestination } from "@/lib/hivra/agent-placement";
import { getAgent as getCatalogAgent } from "@/lib/hivra/agent-catalog";
import { getFingerprintRequestId } from "@/lib/abuse/client-fingerprint";
import { getApiErrorMessage, getCardRequiredMessage, isCardRequiredResponse } from "@/lib/billing/card-required";
import { buildPostDeployDestination } from "@/lib/welcome-deploy";
import {
  DEFAULT_MODEL_ACCESS,
  PROFILE_DETAILS,
  type LaunchDraft,
  type LaunchErrorAction,
  type LaunchModelAccess,
  type LaunchProfileId,
} from "./contracts";
import {
  creditsWallet,
  effectiveModel,
  effectiveProvider,
  providerName,
  requiresSavedKey,
  type CreditsBalance,
  type SavedModelKey,
} from "./model-access";
import {
  codexModelRequest,
  dashboardAgentRequest,
  hermesInstanceRequest,
  nativeCliAgentRequest,
  type HermesModelChoice,
} from "./runtime-requests";

type ReceiptBearingCreateInput = CreateAgentInput & { launchRequestId: string };

/** What a launch returns: the new computer's id, name and status. */
export type LaunchResult = { id: string; name: string; status: string };

// The launch route has a 180-second execution budget. Keep observing the
// owner-bound receipt through that whole admission window, plus a small final
// propagation margin, without ever resubmitting the POST.
const RECEIPT_RECONCILIATION_MS = 195_000;
const RECEIPT_POLL_MS = 750;
/** A computer counts as this launch's only when it was created after the
 * request was sent, allowing for a server clock slightly behind the browser. */
const CLOCK_SKEW_MS = 120_000;

/** The last thing Hivra reported about a launch in flight. Only observed
 * facts: the moment the request was sent, then any receipt phase read back. */
export type LaunchObservation =
  | { kind: "sent"; at: number }
  | { kind: "receipt"; phase: string; at: number };

export type LaunchSubmitOptions = {
  /** A key typed into this page for this launch. Never stored. */
  apiKey?: string | null;
  /** Saved Vault keys (never the keys themselves), for Hermes' memory key. */
  savedKeys?: readonly SavedModelKey[];
  /** The credit balance Hivra last read, so credits bill the funded wallet. */
  balance?: CreditsBalance;
  /** A pasted key the owner asked to save was saved: the draft can refer to
   * it from now on instead of needing the key again. */
  onKeySaved?: (vaultKeyId: string, saved: SavedModelKey) => void;
  onObserved?: (observation: LaunchObservation) => void;
};

/** A correctable rejection that also offers a next step. */
export class LaunchCorrectableError extends HivraLaunchCorrectableError {
  constructor(message: string, status: number, code: string | null, readonly action: LaunchErrorAction | null) {
    super(message, status, code);
    this.name = "LaunchCorrectableError";
  }
}

/** What resuming a launch whose answer was lost does. "resend": the request
 * carries a stable ID the server records (or claims one prepared computer),
 * so sending it again can never start a second computer. "observe": its lane
 * takes no such ID, so Hivra only looks for the computer the first request
 * created and never sends it again. */
export function launchResumeMode(profileId: LaunchProfileId): "resend" | "observe" {
  return profileId === "claude-code" || profileId === "hermes" || profileId === "openclaw"
    || profileId === "agent-zero" || profileId === "aeon"
    ? "observe"
    : "resend";
}

type SubmissionOutcome =
  | { state: "accepted"; agent: HivraAgent }
  | { state: "failed"; error: unknown };

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

/** The provisioning POST can keep doing exact host-side confirmation after its
 * durable receipt already names the new computer. Reconcile that receipt in
 * parallel so the launch screen advances as soon as acceptance is known. */
async function submitWithReceipt(
  input: ReceiptBearingCreateInput,
  onObserved?: LaunchSubmitOptions["onObserved"],
): Promise<HivraAgent> {
  const state: { settled: SubmissionOutcome | null } = { settled: null };
  onObserved?.({ kind: "sent", at: Date.now() });
  const submission = createAgent(input).then<SubmissionOutcome, SubmissionOutcome>(
    agent => ({ state: "accepted", agent }),
    error => ({ state: "failed", error }),
  );
  void submission.then(outcome => { state.settled = outcome; });
  const currentSubmission = (): SubmissionOutcome | null => state.settled;

  const deadline = Date.now() + RECEIPT_RECONCILIATION_MS;
  while (Date.now() < deadline) {
    const current = currentSubmission();
    if (current?.state === "accepted") return current.agent;
    if (
      current?.state === "failed"
      && (current.error instanceof HivraLaunchRejectedError
        || current.error instanceof HivraLaunchCorrectableError)
    ) throw current.error;

    try {
      const receipt = await findHivraLaunchReceipt(input.launchRequestId);
      if (receipt?.state === "accepted") return receipt.agent;
      if (receipt?.state === "reconciling") onObserved?.({ kind: "receipt", phase: receipt.phase, at: Date.now() });
    } catch (error) {
      if (error instanceof HivraLaunchRejectedError) throw error;
      // A temporarily unreadable/missing receipt is uncertainty, not proof
      // that the original request failed. The original POST remains in flight.
    }
    const afterReceipt = currentSubmission();
    if (afterReceipt?.state === "accepted") return afterReceipt.agent;
    if (currentSubmission() === null) {
      await Promise.race([submission, pause(RECEIPT_POLL_MS)]);
    } else {
      await pause(RECEIPT_POLL_MS);
    }
  }

  const outcome = currentSubmission();
  if (!outcome) {
    throw new HivraLaunchInProgressError(
      input.launchRequestId,
      "The launch is still being confirmed. Resume this same saved request instead of starting another computer.",
    );
  }
  if (outcome.state === "accepted") return outcome.agent;
  throw outcome.error;
}

/** A draft's model choice; drafts from before it existed sign in natively. */
function accessOf(draft: LaunchDraft): LaunchModelAccess {
  return draft.modelAccess ?? DEFAULT_MODEL_ACCESS;
}

function createdSince(createdAt: unknown, submittedAt: string | null): boolean {
  if (!submittedAt) return false;
  const created = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  const sent = Date.parse(submittedAt);
  return Number.isFinite(created) && Number.isFinite(sent) && created >= sent - CLOCK_SKEW_MS;
}

/** The agent a receipt-free launch created, found by its exact name and
 * runtime among agents created since the request was sent. Null when there
 * is none; an unreadable list throws, because it proves nothing either way. */
async function findObservedAgent(draft: LaunchDraft): Promise<LaunchResult | null> {
  if (!draft.profileId) return null;
  const { agents, error } = await listAgentsResult();
  if (error) throw new Error(error);
  const runtime = PROFILE_DETAILS[draft.profileId].runtimeId;
  const wanted = draft.name.trim();
  const found = agents
    .filter(agent => agent.type === runtime && agent.name.trim() === wanted && agent.status !== "deleted"
      && createdSince(agent.created_at, draft.submittedAt))
    .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))[0];
  if (!found) return null;
  if (found.status === "error") {
    throw new HivraLaunchCorrectableError(found.error || "The computer was created but its setup stopped.", 409, "launch_partial", found.id);
  }
  return { id: found.id, name: found.name, status: found.status };
}

/** The Hermes agent this launch created: exact name, created since the
 * request was sent, and still coming up or running (never a failed one). */
async function findObservedHermes(draft: LaunchDraft): Promise<LaunchResult | null> {
  const response = await fetch("/api/instances", { cache: "no-store", credentials: "same-origin" });
  const body = await response.json().catch(() => null) as { success?: boolean; data?: Array<Record<string, unknown>> } | null;
  if (!response.ok || !Array.isArray(body?.data)) throw new Error("Your agents couldn't be checked right now.");
  const wanted = draft.name.trim();
  const found = body.data
    .filter(instance => {
      const status = String(instance.status ?? "");
      const lifecycle = String(instance.lifecycle_state ?? "");
      const live = status === "provisioning" || status === "running" || lifecycle === "provisioning" || lifecycle === "active";
      return live && String(instance.name ?? "").trim() === wanted && typeof instance.id === "string"
        && createdSince(instance.created_at, draft.submittedAt);
    })
    .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))[0];
  return found ? { id: String(found.id), name: String(found.name ?? wanted), status: String(found.status ?? "provisioning") } : null;
}

/** Posts a request that carries no receipt. A lost or failed response is
 * followed by one look for the computer it created; the request is never
 * sent again. */
async function submitObserved(input: CreateAgentInput, draft: LaunchDraft, options: LaunchSubmitOptions): Promise<LaunchResult> {
  options.onObserved?.({ kind: "sent", at: Date.now() });
  try {
    return await createAgent(input);
  } catch (error) {
    if (error instanceof HivraLaunchCorrectableError || error instanceof HivraLaunchRejectedError) throw error;
    const found = await findObservedAgent(draft).catch(() => null);
    if (found) return found;
    throw new HivraLaunchInProgressError(
      draft.launchRequestId,
      error instanceof Error && error.message
        ? `${error.message}. Hivra couldn't confirm whether the computer was created.`
        : "Hivra couldn't confirm whether the computer was created.",
    );
  }
}

async function saveKeyToVault(provider: string, key: string): Promise<string | null> {
  try {
    const response = await fetch("/api/vault", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name: providerName(provider), provider, key: key.trim() }),
    });
    const body = await response.json().catch(() => null) as { success?: boolean; data?: { id?: unknown } } | null;
    return body?.success && typeof body.data?.id === "string" ? body.data.id : null;
  } catch {
    // Saving is a convenience; the launch goes ahead with the pasted key.
    return null;
  }
}

/** The key this launch uses: the saved Vault key the owner confirmed, or the
 * pasted one (saved to the Vault first when the owner asked). */
async function launchKey(draft: LaunchDraft, options: LaunchSubmitOptions): Promise<{ vaultKeyId: string } | { apiKey: string }> {
  const profileId = draft.profileId!;
  const access = accessOf(draft);
  if (access.keySource === "saved" || requiresSavedKey(profileId, access)) {
    if (!access.vaultKeyId || !access.sendSavedKey) {
      throw new HivraLaunchCorrectableError("Confirm that your saved key can be sent to this agent's computer.", 400, "model_key_consent");
    }
    return { vaultKeyId: access.vaultKeyId };
  }
  const pasted = options.apiKey?.trim() ?? "";
  if (!pasted) throw new HivraLaunchCorrectableError("Paste your API key again to launch. It isn't kept in this browser.", 400, "model_key_missing");
  if (access.saveKey) {
    const provider = effectiveProvider(profileId, access);
    const saved = await saveKeyToVault(provider, pasted);
    if (saved) {
      // The same short preview the Vault keeps, so the saved key can be told
      // apart later without the key itself.
      const preview = pasted.length <= 8 ? `${pasted.slice(0, 4)}...` : `${pasted.slice(0, 6)}...${pasted.slice(-4)}`;
      options.onKeySaved?.(saved, { id: saved, provider, name: providerName(provider), key_preview: preview });
      return { vaultKeyId: saved };
    }
  }
  return { apiKey: pasted };
}

/** The owner's saved Honcho key, which gives Hermes long-term memory. */
export function savedMemoryKey(savedKeys: readonly SavedModelKey[] | undefined): SavedModelKey | null {
  return savedKeys?.find(key => key.provider.toLowerCase() === "honcho") ?? null;
}

async function submitHermes(draft: LaunchDraft, options: LaunchSubmitOptions): Promise<LaunchResult> {
  const access = accessOf(draft);
  const balance = options.balance ?? { state: "unknown" };
  let model: HermesModelChoice;
  if (access.mode === "native") model = { kind: "unconfigured" };
  else if (access.mode === "credits") {
    model = { kind: "managed", model: effectiveModel("hermes", access), walletType: creditsWallet(access, balance) };
  } else {
    const key = await launchKey(draft, options);
    model = {
      kind: "key",
      provider: effectiveProvider("hermes", access),
      model: effectiveModel("hermes", access),
      ...("vaultKeyId" in key ? { vaultKeyId: key.vaultKeyId } : { apiKey: key.apiKey }),
      baseUrl: access.baseUrl,
    };
  }
  const body = hermesInstanceRequest({
    name: draft.name,
    model,
    // Sent only when the owner confirmed it for this launch.
    honcho: { vaultKeyId: draft.sendMemoryKey ? savedMemoryKey(options.savedKeys)?.id ?? null : null },
    fingerprintRequestId: await getFingerprintRequestId(),
    cpu: draft.resources.cpu,
    ramGb: draft.resources.ram,
  });
  options.onObserved?.({ kind: "sent", at: Date.now() });
  let response: Response;
  let payload: Record<string, unknown> | null;
  try {
    response = await fetch("/api/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  } catch {
    // The Hermes launch is synchronous and can outlive the connection. Look
    // for what it created instead of reporting a failure it may not be.
    const found = await findObservedHermes(draft).catch(() => null);
    if (found) return found;
    throw new HivraLaunchInProgressError(draft.launchRequestId, "The connection closed before Hivra answered.");
  }
  const data = payload?.data as { id?: unknown; name?: unknown; status?: unknown } | undefined;
  if (payload?.success === true && typeof data?.id === "string") {
    return { id: data.id, name: typeof data.name === "string" ? data.name : draft.name.trim(), status: typeof data.status === "string" ? data.status : "provisioning" };
  }
  if (isCardRequiredResponse(payload)) {
    throw new LaunchCorrectableError(getCardRequiredMessage(payload), response.status, "card_required", { kind: "verify-card" });
  }
  const message = getApiErrorMessage(payload, `Launch failed (${response.status})`);
  if (response.status >= 400 && response.status < 500) {
    const existing = typeof payload?.existingInstanceId === "string" ? payload.existingInstanceId : null;
    throw new LaunchCorrectableError(
      message,
      response.status,
      typeof payload?.code === "string" ? payload.code : null,
      existing ? { kind: "open", label: "Open your agent", href: `/dashboard/instances/${encodeURIComponent(existing)}` } : null,
    );
  }
  // A failure reported after the computer was already created (a slow host,
  // or a step after creation) still leaves the agent booting.
  const found = await findObservedHermes(draft).catch(() => null);
  if (found) return found;
  throw new HivraLaunchRejectedError(message, response.status, typeof payload?.failureType === "string" ? payload.failureType : null);
}

async function submitCodex(draft: LaunchDraft, deployment: AgentDeploymentDestination, options: LaunchSubmitOptions): Promise<LaunchResult> {
  const access = accessOf(draft);
  const shared = {
    name: draft.name.trim(),
    cpu: draft.resources.cpu,
    ram: draft.resources.ram,
    maximumCpu: draft.resources.maximumCpu,
    maximumRam: draft.resources.maximumRam,
    // Same flag the legacy welcome launch sends; false keeps Codex at its base floor.
    browser: draft.browser,
    deployment,
    launchRequestId: draft.launchRequestId,
  };
  if (access.mode === "native") {
    return submitWithReceipt({ type: "codex", ...shared }, options.onObserved);
  }
  const model = effectiveModel("codex", access);
  const llm = access.mode === "credits"
    ? { mode: "managed" as const, model, walletType: creditsWallet(access, options.balance ?? { state: "unknown" }) }
    : { mode: "byok" as const, model, ...(await launchKey(draft, options)) };
  return submitWithReceipt(codexModelRequest({ ...shared, llm }), options.onObserved);
}

export async function submitLaunchDraft(
  draft: LaunchDraft,
  deployment: AgentDeploymentDestination,
  options: LaunchSubmitOptions = {},
): Promise<LaunchResult> {
  if (!draft.profileId || !draft.name.trim()) throw new Error("Launch draft is incomplete.");
  const profileId = draft.profileId;
  if (profileId === "omarchy") {
    if (deployment.mode !== "hivra-managed") {
      throw new HivraLaunchCorrectableError("This prepared Canary computer currently runs on Hivra Cloud.", 409, "prepared_managed_only");
    }
    const response = await fetch("/api/hivra/prepared-computers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ profile: profileId, name: draft.name.trim() }),
    });
    let payload: { success?: boolean; error?: string; data?: { agent?: HivraAgent } } | null = null;
    try { payload = await response.json(); } catch { /* handled below */ }
    if (!response.ok || payload?.success !== true || !payload.data?.agent) {
      const message = payload?.error || `Computer launch failed (${response.status})`;
      if (response.status >= 400 && response.status < 500) throw new HivraLaunchCorrectableError(message, response.status);
      throw new Error(message);
    }
    return payload.data.agent;
  }
  if (profileId === "windows" && deployment.mode === "hivra-managed") {
    throw new HivraLaunchCorrectableError(
      "Hivra Cloud is unavailable for Windows without a real managed entitlement.",
      409,
      "managed_windows_entitlement_required",
    );
  }
  if (profileId === "windows") {
    if (deployment.mode !== "self-managed" || !draft.windowsIsoVolume || !draft.windowsIsoEvidence || !draft.windowsRightsAttested) {
      throw new HivraLaunchCorrectableError("Choose a customer-owned ISO and confirm your Windows installation rights.", 400, "windows_setup_incomplete");
    }
    const response = await fetch("/api/hivra/windows/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        ...deployment,
        launchRequestId: draft.launchRequestId,
        name: draft.name.trim(),
        isoVolume: draft.windowsIsoVolume,
        mediaEvidence: draft.windowsIsoEvidence,
        mediaSource: draft.windowsIsoSource,
        cpu: draft.resources.cpu,
        ram: draft.resources.ram,
        diskGb: 64,
        rightsAttested: true,
        termsVersion: "windows-byo-iso-v1",
      }),
    });
    let payload: { success?: boolean; error?: string; code?: string; data?: { agent?: HivraAgent } } | null = null;
    try { payload = await response.json(); } catch { /* handled below */ }
    if (!response.ok || payload?.success !== true || !payload.data?.agent) {
      const message = payload?.error || `Windows setup failed (${response.status})`;
      if (payload?.code === "provision_uncertain" || response.status >= 500) {
        throw new HivraLaunchInProgressError(draft.launchRequestId, message);
      }
      throw new HivraLaunchCorrectableError(message, response.status, payload?.code);
    }
    return payload.data.agent;
  }
  if (profileId === "linux-terminal") {
    if (deployment.mode !== "self-managed") {
      throw new HivraLaunchCorrectableError("Linux Sandbox requires a compatible gVisor host you connected.", 409, "gvisor_self_managed_only");
    }
    return submitWithReceipt({
      type: "linux-terminal",
      computerProfile: "linux-terminal",
      name: draft.name.trim(),
      cpu: draft.resources.cpu,
      ram: draft.resources.ram,
      maximumCpu: draft.resources.maximumCpu ?? draft.resources.cpu,
      maximumRam: draft.resources.maximumRam ?? draft.resources.ram,
      browser: false,
      deployment,
      launchRequestId: draft.launchRequestId,
    }, options.onObserved);
  }
  if (profileId === "ubuntu-desktop") {
    return submitWithReceipt({
      type: "linux-desktop",
      computerProfile: profileId,
      name: draft.name.trim(),
      cpu: draft.resources.cpu,
      ram: draft.resources.ram,
      maximumCpu: draft.resources.maximumCpu,
      maximumRam: draft.resources.maximumRam,
      browser: false,
      deployment,
      launchRequestId: draft.launchRequestId,
    }, options.onObserved);
  }
  if (profileId === "codex") return submitCodex(draft, deployment, options);
  if (profileId === "hermes") {
    if (deployment.mode !== "hivra-managed") {
      throw new HivraLaunchCorrectableError("Hermes runs on Hivra Cloud only.", 409, "hermes_managed_only");
    }
    return submitHermes(draft, options);
  }
  if (profileId === "claude-code") {
    return submitObserved(nativeCliAgentRequest({
      type: "claude-code",
      name: draft.name.trim(),
      cpu: draft.resources.cpu,
      ram: draft.resources.ram,
      browser: draft.browser,
      deployment,
    }), draft, options);
  }
  // OpenClaw, Agent Zero and Aeon, as their setup form launched them.
  const access = accessOf(draft);
  const credits = access.mode === "credits"
    ? { walletType: creditsWallet(access, options.balance ?? { state: "unknown" }) }
    : null;
  return submitObserved(dashboardAgentRequest({
    type: profileId,
    name: draft.name.trim(),
    cpu: draft.resources.cpu,
    ram: draft.resources.ram,
    browser: profileId === "openclaw" && draft.browser,
    credits,
    deployment,
  }), draft, options);
}

/** Looks, without sending anything, for the computer a launch whose answer
 * was lost created. Null means it isn't visible (yet). */
export async function reconcileLaunchDraft(draft: LaunchDraft): Promise<LaunchResult | null> {
  if (!draft.profileId) return null;
  if (launchResumeMode(draft.profileId) === "resend") {
    const receipt = await findHivraLaunchReceipt(draft.launchRequestId);
    return receipt?.state === "accepted" ? receipt.agent : null;
  }
  return draft.profileId === "hermes" ? findObservedHermes(draft) : findObservedAgent(draft);
}

/** Where a launched agent or computer opens: each runtime's own surface. */
export function launchResultHref(draft: LaunchDraft, agentId: string): string {
  const id = encodeURIComponent(agentId);
  if (draft.profileId === "hermes") {
    return buildPostDeployDestination({
      instanceId: agentId,
      providerId: accessOf(draft).mode === "native" ? undefined : effectiveProvider("hermes", accessOf(draft)),
      webUseGateway: false,
      imageGenUseGateway: false,
      ttsUseGateway: false,
      browserUseGateway: false,
      welcome: true,
    });
  }
  if (draft.profileId === "linux-terminal") return `/dashboard/agent/${id}?tab=manage`;
  if (draft.profileId && PROFILE_DETAILS[draft.profileId].resourceKind === "computer") {
    // The launch operation installs the desktop. Opening its result must not
    // request a second installation (or bypass explicit preparation holds).
    return `/dashboard/agent/${id}?tab=desktop`;
  }
  // A Codex model key is delivered after the computer is ready; its Settings
  // show that delivery and anything it needs.
  if (draft.profileId === "codex" && accessOf(draft).mode !== "native") {
    return `/dashboard/agent/${id}?welcome=1&tab=manage#model-settings`;
  }
  // Dashboard agents open their own dashboard; CLI agents their terminal.
  const surface = draft.profileId ? getCatalogAgent(PROFILE_DETAILS[draft.profileId].runtimeId)?.surface : undefined;
  return `/dashboard/agent/${id}?welcome=1&tab=${surface === "dashboard" ? "aeon" : "terminal"}`;
}

/** Hermes shows its outcome in the journey (Start chatting); every other
 * accepted launch opens its own surface straight away. */
export function opensOnAcceptance(profileId: LaunchProfileId | null): boolean {
  return profileId !== "hermes";
}
