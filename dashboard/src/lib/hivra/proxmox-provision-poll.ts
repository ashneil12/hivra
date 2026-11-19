// The Proxmox provisioning convergence of a Hivra computer: read the host's
// result marker for the launch (or start/restart/resize) operation and, when it
// reports ready, validate it and flip the row to running (or to error when the
// provisioner reports failure). GET /api/hivra/agents/[id] runs it on every
// poll; the Hermes move runs the same function from its orchestrator, so a
// launch finishes without a browser open.

import { reconcileBankrEnvAfterHivraBoot } from "@/lib/agent-wallets/hivra-lane";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { captureHivraAgentComputerReady } from "@/lib/hivra/agent-ready-telemetry";
import { validateHivraHostRunningResult } from "@/lib/hivra/agent-host-result";
import {
  describeHivraAgentExecutionContextError,
  hivraAgentProvisionLogPath,
  hivraAgentProvisionSecretPath,
  hivraAgentStartLogPath,
  resolveHivraAgentTeardownExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import {
  checkpointHivraAgentOperation,
  completeHivraAgentDelete,
  completeHivraAgentRunning,
  releaseHivraAgentOperation,
} from "@/lib/hivra/agent-operation-store";
import { verifiedDestroyHivraVmScript } from "@/lib/hivra/delete-hivra-agent";
import { verifyLinuxServerPublicRuntime } from "@/lib/hivra/linux-server-readiness";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { log } from "@/lib/logger";
import { deleteBoxTunnel } from "@/lib/services/cloudflare-tunnel";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import {
  buildRemoteDesktopCapabilityInspectionScript,
  verifyDesktopReadinessReceipt,
} from "@/lib/remote-computers/capability-inspection";
import {
  parseActivityCollectorMarker,
  recordCollectorInstallResult,
  supportsNativeTracing,
} from "@/lib/activity-observability/collectors";

// The one agent-run reporter install line the launch installer and the start
// helper write into the host log (docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md).
// Closed enum only; anything else is ignored.
const ACTIVITY_COLLECTOR_MARKER_PATTERN = "^HIVRA_ACTIVITY_COLLECTOR status=(installed|failed reason=[a-z_]{1,40})$";

type AgentRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a hivra_agents row

/**
 * agent is the row after the poll; stop is true when the poll must answer with
 * it at once (the caller skips its later seeding steps), as the route always did.
 */
export type ProvisionPollResult =
  | { agent: AgentRow; stop: boolean }
  | { error: { message: string; status: number } };

const fail = (message: string, status: number): ProvisionPollResult => ({ error: { message, status } });

/** One observation of a provisioning Proxmox computer. Safe to call repeatedly. */
export async function advanceProxmoxProvisionPoll(
  userId: string,
  agent: AgentRow,
  getExecutionContext: () => Promise<HivraAgentExecutionContext>,
): Promise<ProvisionPollResult> {
  if (!supabaseAdmin) return fail("Database not configured", 500);
  let current = agent;
    if (current.status === "provisioning" && current.vmid) {
      const convergenceOperationKind =
        ["provision", "start", "restart", "resize"].includes(String(current.operation_kind))
          ? current.operation_kind as "provision" | "start" | "restart" | "resize"
          : null;
      const provisionOperationId =
        convergenceOperationKind && typeof current.operation_id === "string"
          ? current.operation_id
          : null;
      if (!convergenceOperationKind || !provisionOperationId) {
        return fail("Provisioning state is missing its durable operation lease", 409);
      }
      const provisionStillCurrent = await checkpointHivraAgentOperation({
        userId,
        agentId: String(current.id),
        operationId: provisionOperationId,
        expectedDesiredState: "running",
      });
      // Once desired_state changes, never persist a stale host result. The
      // provision lease owner verifies/compensates its allocation; start-like
      // leases release so a retrying DELETE can claim teardown exclusively.
      if (!provisionStillCurrent) {
        if (current.desired_state === "deleted") {
          if (convergenceOperationKind === "provision") {
            const allocationOperationId =
              typeof current.allocation_operation_id === "string"
                ? current.allocation_operation_id
                : null;
            if (allocationOperationId !== provisionOperationId) {
              return fail("Provision cancellation lacks verified VM ownership evidence", 409);
            }
            let cancellationContext: HivraAgentExecutionContext;
            try {
              cancellationContext = await resolveHivraAgentTeardownExecutionContext(
                userId,
                current,
              );
            } catch (contextError) {
              const safeError = describeHivraAgentExecutionContextError(contextError);
              if (safeError) return fail(safeError.message, safeError.status);
              throw contextError;
            }
            const cancellationVmid = Number(current.vmid);
            const cancellationPaths = [
              hivraAgentProvisionLogPath(cancellationContext, cancellationVmid),
              hivraAgentStartLogPath(cancellationContext, cancellationVmid),
              hivraAgentProvisionSecretPath(cancellationContext, cancellationVmid),
            ].filter((path): path is string => Boolean(path));
            const cleanup = await runProxmoxHostScript(
              verifiedDestroyHivraVmScript({
                vmid: cancellationVmid,
                storage: cancellationContext.paths.storage,
                expectedAllocationOperationId: allocationOperationId,
                expectedInfrastructureBindingTag: cancellationContext.infrastructureBindingTag,
                allowManagedLegacyAuthority: false,
                cleanupPaths: cancellationPaths,
              }),
              cancellationContext.env,
            );
            if (!cleanup.ok) {
              return fail(
                "Provision cancellation was requested, but VM cleanup could not be verified.",
                502,
              );
            }
            const deleted = await completeHivraAgentDelete({
              userId,
              agentId: String(current.id),
              operationId: provisionOperationId,
            });
            if (!deleted) {
              return fail("Verified VM cleanup could not be finalized safely.", 409);
            }
          } else {
            // The detached start helper inherits FD8 until its qm mutation is
            // complete. A poll cannot safely clear this lease from DB evidence
            // alone: DELETE could then destroy the VM while the helper is still
            // about to start it. The bounded recovery sweep acquires that same
            // host lock, verifies the stable binding/provider state, and only
            // then releases the exact lease for a retrying delete.
          }
          const { data: superseded } = await supabaseAdmin
            .from("hivra_agents")
            .select("*")
            .eq("id", current.id)
            .eq("user_id", userId)
            .maybeSingle();
          return { agent: superseded || current, stop: true };
        }
        return { agent: current, stop: true };
      }
      const vmid = Number(current.vmid);
      // A Linux computer with no desktop is stored as a linux-desktop row with
      // its own profile. Only that exact profile skips the desktop receipt; a
      // missing or unknown profile keeps the desktop requirement.
      const headlessComputer = current.type === "linux-desktop" && current.computer_profile === "ubuntu-server";
      let context: HivraAgentExecutionContext;
      try {
        context = await getExecutionContext();
      } catch (contextError) {
        const safeError = describeHivraAgentExecutionContextError(contextError);
        if (safeError) return fail(safeError.message, safeError.status);
        throw contextError;
      }
      // Grep the FULL log, not a tail window: anything appended after the
      // result marker must never make a converged box look "not ready yet".
      const provisionLog = hivraAgentProvisionLogPath(context, vmid);
      const startLog = hivraAgentStartLogPath(context, vmid);
      const convergenceLog = convergenceOperationKind === "provision"
        ? provisionLog
        : startLog;
      const provisionSecret = hivraAgentProvisionSecretPath(context, vmid);
      const compatibilityPayload =
        current.operation_payload && typeof current.operation_payload === "object"
          ? current.operation_payload as Record<string, unknown>
          : null;
      const nMinusOneCompatibility =
        current.deployment_mode === "hivra-managed" &&
        current.infrastructure_binding_token_enforced === false &&
        compatibilityPayload?.compatibility === "n_minus_one";
      const startReceiptProbe = convergenceOperationKind === "provision"
        ? ""
        : `if grep -Fxq ${shellQuote(`HIVRA_OPERATION_ID ${provisionOperationId}`)} ${shellQuote(startLog)} 2>/dev/null; then
  printf 'HIVRA_OPERATION_RECEIPT %s\\n' ${shellQuote(provisionOperationId)}
fi`;
      const provisionOwnershipProbe =
        convergenceOperationKind === "provision" &&
        context.infrastructureBindingTagEnforced &&
        current.allocation_operation_id === provisionOperationId
          ? `TAGS="$(qm config ${vmid} 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
if printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq ${shellQuote(context.infrastructureBindingTag)} \
  && printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq ${shellQuote(`hivra-op-${provisionOperationId.replace(/-/g, "")}`)}; then
  printf 'HIVRA_PROVIDER_OWNERSHIP %s\\n' ${shellQuote(provisionOperationId)}
fi`
          : "";
      // Claude Code / Codex Proxmox computers: the reporter install outcome the
      // launch installer (provision log) or start helper (start log) wrote for
      // this operation. The log is recreated per operation, so the last line wins.
      const activityCollectorProbe = supportsNativeTracing(current)
        ? `COLLECTOR="$(grep -E ${shellQuote(ACTIVITY_COLLECTOR_MARKER_PATTERN)} ${shellQuote(convergenceLog)} 2>/dev/null | tail -1 || true)"
if [ -n "$COLLECTOR" ]; then printf '%s\\n' "$COLLECTOR"; fi`
        : "";
      const script = `MARKER="$(grep -oE '\\{"vmid":[^{}]*"ready":(true|false)[^{}]*\\}' ${shellQuote(convergenceLog)} 2>/dev/null | tail -1 || true)"
if [ -n "$MARKER" ]; then printf '%s\\n' "$MARKER"; fi
${activityCollectorProbe}
${startReceiptProbe}
${provisionOwnershipProbe}
${provisionSecret ? `if printf '%s' "$MARKER" | grep -q '"ready":true' && [ -f ${shellQuote(provisionSecret)} ]; then
  TOKEN="$(tr -d '[:space:]' < ${shellQuote(provisionSecret)})"
  if [ "\${#TOKEN}" -eq 64 ] && ! printf '%s' "$TOKEN" | grep -q '[^0-9a-f]'; then
    printf 'HIVRA_PROVISION_SECRET %s\\n' "$TOKEN"
  fi
fi` : ""}`;
      const result = await runProxmoxHostScript(script, context.env);
      if (!result.ok) {
        log.warn("hivra agent provision status poll failed", {
          source: "hivra/agents/[id]",
          failureType: "hivra_agent_provision_poll_failed",
          userId,
          agentId: current.id,
          agentType: current.type,
          vmid,
          proxmoxHost: context.host,
          errorMessage: result.error ?? null,
          stdoutBytes: result.stdout?.length ?? 0,
          stderr: result.stderr?.slice(0, 500) ?? null,
        });
      }
      const outputLines = (result.stdout || "").split(/\r?\n/);
      const line = outputLines.find((candidate) => candidate.trim().startsWith("{"))?.trim() || "";
      const secretMatch = outputLines
        .map((candidate) => candidate.trim().match(/^HIVRA_PROVISION_SECRET ([0-9a-f]{64})$/))
        .find((candidate) => candidate);
      const returnedSecret = secretMatch?.[1] || null;
      const operationReceiptObserved = outputLines.some(
        (candidate) => candidate.trim() === `HIVRA_OPERATION_RECEIPT ${provisionOperationId}`,
      );
      const providerOwnershipObserved = outputLines.some(
        (candidate) => candidate.trim() === `HIVRA_PROVIDER_OWNERSHIP ${provisionOperationId}`,
      );
      if (line) {
        try {
          const j = JSON.parse(line) as {
            ready?: boolean;
            vmid?: number;
            agent_kind?: string;
            chat_url?: string;
            ip?: string;
            api_token?: string;
            error?: string;
          };
          if (j.ready === true) {
            if (
              !nMinusOneCompatibility &&
              convergenceOperationKind !== "provision" &&
              !operationReceiptObserved
            ) {
              log.warn("hivra lifecycle result lacks its durable operation receipt", {
                source: "hivra/agents/[id]",
                failureType: "hivra_agent_lifecycle_operation_receipt_missing",
                userId,
                agentId: current.id,
                operationKind: convergenceOperationKind,
                vmid,
              });
              return { agent: current, stop: true };
            }
            if (
              !nMinusOneCompatibility &&
              convergenceOperationKind === "provision" &&
              context.infrastructureBindingTagEnforced &&
              !providerOwnershipObserved
            ) {
              log.warn("hivra provision result lacks provider ownership evidence", {
                source: "hivra/agents/[id]",
                failureType: "hivra_agent_provision_ownership_missing",
                userId,
                agentId: current.id,
                vmid,
              });
              return { agent: current, stop: true };
            }
            // Portable provisioning deliberately omits the bearer from the
            // persistent host log. Do not converge to running until its
            // root-only one-shot result is available and well-formed.
            if (
              convergenceOperationKind === "provision" &&
              context.kind === "self-managed" &&
              !returnedSecret
            ) {
              log.warn("hivra provision result is ready but its secret result is unavailable", {
                source: "hivra/agents/[id]",
                failureType: "hivra_agent_provision_secret_unavailable",
                userId,
                agentId: current.id,
                agentType: current.type,
                vmid,
                proxmoxHost: context.host,
              });
              return { agent: current, stop: true };
            }
            const validatedResult = validateHivraHostRunningResult({
              result: j,
              expectedVmid: vmid,
              expectedIp: typeof current.ip === "string" ? current.ip : "",
              // Fresh provisioning owns the runtime-kind decision and publishes
              // that evidence. Start/restart/resize operate on the already-bound
              // VM and the lifecycle helper intentionally reports only its stable
              // coordinates, so requiring agent_kind there rejects a healthy
              // Ubuntu computer after every reboot.
              expectedAgentKind:
                convergenceOperationKind === "provision" && current.type === "linux-desktop"
                  ? headlessComputer ? "linux-server" : "linux-desktop"
                  : null,
              namedHostname:
                typeof current.cf_hostname === "string" ? current.cf_hostname : null,
              oneShotApiToken: returnedSecret,
              existingApiToken:
                typeof current.api_token === "string" ? current.api_token : null,
            });
            if (!validatedResult.ok) {
              await releaseHivraAgentOperation({
                userId,
                agentId: String(current.id),
                operationId: provisionOperationId,
                error: `Host result validation failed: ${validatedResult.reason}`,
                markError: true,
              });
              log.error("hivra host result failed authority validation", new Error(validatedResult.reason), {
                source: "hivra/agents/[id]",
                failureType: "hivra_agent_host_result_invalid",
                userId,
                agentId: current.id,
                vmid,
                resultVmid: typeof j.vmid === "number" ? j.vmid : null,
                resultIpMatches: j.ip === current.ip,
                verboseErrors: true,
              });
              const { data: failed } = await supabaseAdmin
                .from("hivra_agents")
                .select("*")
                .eq("id", current.id)
                .eq("user_id", userId)
                .maybeSingle();
              return { agent: failed || current, stop: true };
            }
            if (headlessComputer) {
              // No desktop, so no desktop capability receipt: the host reported
              // ready (and, on provision, the linux-server kind), and the
              // gateway must answer as a linux-server computer.
              const readiness = await verifyLinuxServerPublicRuntime(validatedResult.value.chatUrl);
              if (!readiness.ok) {
                if (readiness.retryable) {
                  log.warn("linux computer gateway is not answering as a linux-server yet", {
                    source: "hivra/agents/[id]",
                    failureType: "hivra_linux_server_meta_unavailable",
                    userId,
                    agentId: current.id,
                    vmid,
                    operationKind: convergenceOperationKind,
                  });
                  return { agent: current, stop: true };
                }
                await releaseHivraAgentOperation({
                  userId,
                  agentId: String(current.id),
                  operationId: provisionOperationId,
                  error: readiness.ownerMessage,
                  markError: true,
                });
                log.warn("linux computer gateway answered as the wrong kind of computer", {
                  source: "hivra/agents/[id]",
                  failureType: "hivra_linux_server_wrong_kind",
                  userId,
                  agentId: current.id,
                  vmid,
                  operationKind: convergenceOperationKind,
                });
                const { data: failed } = await supabaseAdmin
                  .from("hivra_agents")
                  .select("*")
                  .eq("id", current.id)
                  .eq("user_id", userId)
                  .maybeSingle();
                return { agent: failed || current, stop: true };
              }
            } else if (current.type === "linux-desktop") {
              const capabilityResult = await runProxmoxHostScript(
                buildRemoteDesktopCapabilityInspectionScript({
                  vmid,
                  guestIp: validatedResult.value.ip,
                  infrastructureBindingTag: context.infrastructureBindingTag,
                }),
                context.env,
                {
                  timeoutMs: 45_000,
                  maxOutputBytes: 16 * 1024,
                  earlyFinishMarker: "HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ",
                },
              );
              const readiness = verifyDesktopReadinessReceipt(capabilityResult, {
                computerId: String(current.id),
                brokerOrigin: validatedResult.value.chatUrl,
                operationKind: convergenceOperationKind,
              });
              if (!readiness.ok) {
                await releaseHivraAgentOperation({
                  userId,
                  agentId: String(current.id),
                  operationId: provisionOperationId,
                  error: readiness.ownerMessage,
                  markError: true,
                });
                log.warn("linux desktop readiness capability is unavailable", {
                  source: "hivra/agents/[id]",
                  failureType: "hivra_linux_desktop_capability_unavailable",
                  userId,
                  agentId: current.id,
                  vmid,
                  operationKind: convergenceOperationKind,
                  capabilityCommandOk: capabilityResult.ok,
                  capabilityFailureCode: readiness.failureCode,
                  observedRevision: readiness.observedRevision,
                });
                const { data: failed } = await supabaseAdmin
                  .from("hivra_agents")
                  .select("*")
                  .eq("id", current.id)
                  .eq("user_id", userId)
                  .maybeSingle();
                return { agent: failed || current, stop: true };
              }
            }
            const isFirstProvision =
              convergenceOperationKind === "provision" &&
              !(typeof current.provisioned_at === "string" && current.provisioned_at);
            const firstProvisionedAt = typeof current.provisioned_at === "string" && current.provisioned_at
              ? current.provisioned_at
              : new Date().toISOString();
            const provisionCompleted = await completeHivraAgentRunning({
              userId,
              agentId: String(current.id),
              operationId: provisionOperationId,
              operationKind: convergenceOperationKind,
              chatUrl: validatedResult.value.chatUrl,
              ip: validatedResult.value.ip,
              apiToken: validatedResult.value.apiToken,
              provisionedAt: firstProvisionedAt,
            });
            if (!provisionCompleted) {
              const { data: superseded } = await supabaseAdmin
                .from("hivra_agents")
                .select("*")
                .eq("id", current.id)
                .eq("user_id", userId)
                .maybeSingle();
              return { agent: superseded || current, stop: true };
            }
            if (provisionSecret && returnedSecret) {
              const cleanupResult = await runProxmoxHostScript(
                `rm -f -- ${shellQuote(provisionSecret)} && [ ! -e ${shellQuote(provisionSecret)} ]`,
                context.env,
              );
              if (!cleanupResult.ok) {
                log.warn("hivra provision secret cleanup failed", {
                  source: "hivra/agents/[id]",
                  failureType: "hivra_agent_provision_secret_cleanup_failed",
                  userId,
                  agentId: current.id,
                  agentType: current.type,
                  vmid,
                  proxmoxHost: context.host,
                  errorMessage: cleanupResult.error ?? cleanupResult.stderr?.slice(0, 300) ?? null,
                });
              }
            }
            // Only the completion winner records the reporter install outcome,
            // separately from issuance (recorded when the credential was
            // staged). Best effort: it never holds up or fails convergence.
            const collectorInstall = supportsNativeTracing(current)
              ? parseActivityCollectorMarker(outputLines)
              : null;
            if (collectorInstall) {
              const recorded = await recordCollectorInstallResult(supabaseAdmin, {
                agentId: String(current.id),
                userId,
                status: collectorInstall.status,
                ...(collectorInstall.reason ? { reason: collectorInstall.reason } : {}),
              });
              if (!recorded) {
                log.warn("hivra agent-run reporter install result could not be recorded", {
                  source: "hivra/agents/[id]",
                  failureType: "hivra_activity_collector_install_record_failed",
                  userId,
                  agentId: current.id,
                  operationKind: convergenceOperationKind,
                });
              }
            }
            await logHivraAgentEvent({ userId, event: "provisioned", agentId: current.id, agentType: current.type, detail: { vmid: current.vmid } });
            // completeHivraAgentRunning is an atomic operation-lease claim. Only
            // its winner may report first activation, and only after the host's
            // ready result, provider ownership, endpoint and bearer have passed
            // validation above. Start/restart/resize transitions never re-fire.
            if (isFirstProvision) {
              await captureHivraAgentComputerReady({
                userId,
                agentId: String(current.id),
                agentType: typeof current.type === "string" ? current.type : null,
                deploymentMode:
                  typeof current.deployment_mode === "string" ? current.deployment_mode : null,
                operationId: provisionOperationId,
                vmid: Number.isInteger(Number(current.vmid)) ? Number(current.vmid) : null,
                evidence: current.type === "linux-desktop" && !headlessComputer
                  ? "remote_desktop_capability_receipt"
                  : "host_ready_result",
              });
            }
            const { data: updated, error: reloadError } = await supabaseAdmin
              .from("hivra_agents")
              .select("*")
              .eq("id", current.id)
              .eq("user_id", userId)
              .single();
            if (reloadError || !updated) {
              throw new Error("Could not reload the completed provision result");
            }
            current = updated;
            // A wallet connected or disconnected while the box was stopped, or
            // a restored snapshot's old bankr.env, is applied before the poll
            // reports running. Best effort: it never fails convergence.
            if (current.status === "running") {
              try {
                await reconcileBankrEnvAfterHivraBoot({ userId, agent: current as unknown as Parameters<typeof reconcileBankrEnvAfterHivraBoot>[0]["agent"], executionContext: context, trigger: "poll" });
              } catch (walletError) {
                log.warn("hivra agent wallet boot sync threw", {
                  source: "hivra/agents/[id]",
                  failureType: "hivra_agent_wallet_boot_env_sync_failed",
                  userId,
                  agentId: current.id,
                  errorMessage: walletError instanceof Error ? walletError.message : String(walletError),
                });
              }
            }
          } else if (j.ready === false) {
            const reportedError = typeof j.error === "string"
              ? j.error.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240)
              : "";
            const failureMessage = reportedError || "Provisioning failed on the selected host.";
            const released = await releaseHivraAgentOperation({
              userId,
              agentId: String(current.id),
              operationId: provisionOperationId,
              error: failureMessage,
              markError: true,
            });
            // This terminal transition is the last automatic owner of the
            // named tunnel/CNAME created before kickoff. Only the guarded
            // release winner may remove it; a losing poll may be observing an
            // operation another request already advanced to a live box.
            if (released && (current.cf_tunnel_id || current.cf_hostname)) {
              await deleteBoxTunnel({
                tunnelId: current.cf_tunnel_id,
                hostname: current.cf_hostname,
              });
            }
            const { data: updated } = await supabaseAdmin
              .from("hivra_agents")
              .select("*")
              .eq("id", current.id)
              .eq("user_id", userId)
              .maybeSingle();
            if (released) {
              await logHivraAgentEvent({
                userId,
                event: "failed",
                agentId: current.id,
                agentType: current.type,
                detail: { reason: "provisioner_reported_failure", vmid: current.vmid },
              });
            }
            current = updated || current;
          }
        } catch (parseOrPersistError) {
          if (!(parseOrPersistError instanceof SyntaxError)) throw parseOrPersistError;
        }
      }
    }

  return { agent: current, stop: false };
}
