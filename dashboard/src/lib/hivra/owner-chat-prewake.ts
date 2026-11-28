import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";

export function allowsOwnerChatPrewake(agent: Record<string, unknown>): boolean {
  return isCanonicalGitCanaryDeployment()
    && agent.status === "running"
    && agent.deployment_mode === "hivra-managed"
    && agent.computer_substrate === "proxmox-kvm"
    && agent.seat_funding === "paid"
    && agent.sleep_stored_at == null
    && (agent.type === "claude-code" || agent.type === "codex");
}
