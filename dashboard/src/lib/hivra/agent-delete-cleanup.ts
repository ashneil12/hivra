import "server-only";

import { deleteBoxTunnelVerified } from "@/lib/services/cloudflare-tunnel-cleanup";
import { revokeManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { revokeRemoteDesktopCapability } from "@/lib/remote-computers/session-broker";
import { readStoredLlmConfig } from "./agent-llm";
import { clearHivraPrivateAccessAfterDelete } from "./private-access-store";
import { releaseTelegramWakeOnDelete } from "./telegram-wake/lifecycle";
import { releaseHostIngressOnDelete } from "./ingress/rollback";

export class HivraAgentDeleteCleanupError extends Error {
  constructor(public readonly stage: "remote_desktop" | "private_access" | "managed_key" | "tunnel") {
    super(stage === "remote_desktop"
      ? "The computer was removed, but its remote desktop access could not be revoked. Deletion is incomplete; retry Delete."
      : stage === "private_access"
        ? "The computer was removed, but its saved private-access authority could not be cleared. Deletion is incomplete; retry Delete."
      : stage === "managed_key"
        ? "The computer was removed, but its managed API key could not be revoked. Deletion is incomplete; retry Delete."
        : "The computer was removed, but its tunnel and DNS cleanup could not be verified. Deletion is incomplete; retry Delete.");
    this.name = "HivraAgentDeleteCleanupError";
  }
}

/** Called only after exact provider absence and an owner/operation-bound read. */
export async function cleanupHivraAgentAccess(input: {
  userId: string;
  agentId: string;
  operationId: string;
  tunnelId: string | null;
  hostname: string | null;
  llmConfig: unknown;
}): Promise<void> {
  const desktop = await revokeRemoteDesktopCapability({
    userId: input.userId,
    computerKind: "hivra-agent",
    computerId: input.agentId,
  });
  if (!desktop.ok) throw new HivraAgentDeleteCleanupError("remote_desktop");
  if (!await clearHivraPrivateAccessAfterDelete({ userId: input.userId, agentId: input.agentId, operationId: input.operationId })) {
    throw new HivraAgentDeleteCleanupError("private_access");
  }
  const config = readStoredLlmConfig(input.llmConfig);
  // Unknown or incomplete metadata cannot prove that no managed key remains.
  if ((input.llmConfig != null && !config) ||
      (config?.mode === "managed" && !config.proxyKeyId)) {
    throw new HivraAgentDeleteCleanupError("managed_key");
  }
  if (config?.proxyKeyId) {
    try {
      await revokeManagedVeniceProxyKey({ userId: input.userId, keyId: config.proxyKeyId });
    } catch {
      throw new HivraAgentDeleteCleanupError("managed_key");
    }
  }
  // A host-ingress agent's connector runs on the host: stop it and remove its
  // route, env file and pin before the tunnel goes. Best effort, never blocks
  // the delete, and one read for an agent that never used host ingress.
  await releaseHostIngressOnDelete({ agentId: input.agentId, hostname: input.hostname });
  try {
    await deleteBoxTunnelVerified({ tunnelId: input.tunnelId, hostname: input.hostname });
  } catch {
    throw new HivraAgentDeleteCleanupError("tunnel");
  }
  // Best effort, never blocks the delete: a Telegram wake webhook comes down
  // and its token is forgotten. Does nothing unless Telegram wake is configured.
  await releaseTelegramWakeOnDelete(input.agentId);
}
