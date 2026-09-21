type HivraPreviewId = "deepseek-harness" | "buzz" | "omarchy";

export interface HivraPreviewDefinition {
  id: HivraPreviewId;
  name: string;
  kind: "agent-runtime" | "collaboration" | "computer-image";
  eyebrow: string;
  summary: string;
  href: string;
  actionLabel: string;
  /** A preview can be usable without being an agent or computer launch target. */
  usableNow: boolean;
  launchable: boolean;
}

/**
 * Requested integrations that have a real Hivra surface but are not all agent
 * launch cards. Keep them out of the launchable agent catalog until their own
 * acceptance gates pass; this catalog makes implemented progress discoverable
 * without turning a preview into launch authority.
 */
export const HIVRA_PREVIEWS: readonly HivraPreviewDefinition[] = [
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    kind: "agent-runtime",
    eyebrow: "Experimental runtime",
    summary: "Pinned native interface and provider installer. Native UI, real model reply, PTY, restart, revocation, and teardown passed on a disposable Canary VM; ACP orchestration remains gated.",
    href: "/dashboard/agents#deepseek-harness",
    actionLabel: "Open Agents",
    usableNow: false,
    launchable: false,
  },
  {
    id: "buzz",
    name: "Buzz",
    kind: "collaboration",
    eyebrow: "Agent collaboration",
    summary: "Connect a Buzz relay, give each agent an independent identity, and install the pinned ACP sidecar on an eligible computer.",
    href: "/dashboard/collaboration#buzz",
    actionLabel: "Open collaboration",
    usableNow: true,
    launchable: false,
  },
  {
    id: "omarchy",
    name: "Omarchy",
    kind: "computer-image",
    eyebrow: "Operating system",
    summary: "Pinned full-computer image for an isolated Proxmox KVM target. Install, owner enrollment, desktop reboot, Sunshine preparation, and exact teardown passed; native WAN interaction remains gated.",
    href: "/dashboard/computers#omarchy",
    actionLabel: "Inspect computer",
    usableNow: false,
    launchable: false,
  },
] as const;

export function getHivraPreview(id: string): HivraPreviewDefinition | undefined {
  return HIVRA_PREVIEWS.find((preview) => preview.id === id);
}
