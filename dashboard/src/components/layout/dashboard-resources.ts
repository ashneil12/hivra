import { resourceAttention, type ResourceAttention } from "@/lib/hivra/resource-attention";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { getComputerTemplate } from "@/lib/hivra/computer-catalog";
import { hivraResourceKind } from "@/lib/hivra/unified-agent";

export type DashboardResourceSource = "hermes" | "hivra";

/** Display metadata only. Guest URLs, credentials and runtime content stay out of the shell. */
export interface DashboardResource {
  attention?: ResourceAttention | null;
  uid: string;
  id: string;
  source: DashboardResourceSource;
  kind: "agent" | "computer";
  name: string;
  description: string;
  status: string;
  href: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid resource response");
  return value as Record<string, unknown>;
}

function required(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid resource metadata");
  return value;
}

export function parseDashboardResources(value: unknown, source: DashboardResourceSource): DashboardResource[] {
  const envelope = record(value);
  if (envelope.success !== true) throw new Error("Resource source unavailable");
  const rows = source === "hermes" ? envelope.data : record(envelope.data).agents;
  if (!Array.isArray(rows)) throw new Error("Invalid resource list");
  const seen = new Set<string>();
  const resources: DashboardResource[] = [];
  for (const candidate of rows) {
    const row = record(candidate);
    const id = required(row, "id");
    if (seen.has(id)) throw new Error("Duplicate source resource identity");
    seen.add(id);
    const status = required(row, "status");
    if (status === "deleted" || row.lifecycle_state === "deleted") continue;
    const name = required(row, "name");
    if (source === "hermes") {
      resources.push({ uid: `h-${id}`, id, source, kind: "agent", name, status, attention: resourceAttention(status, row.pendingPrompt),
        description: "Hermes", href: `/dashboard/instances/${encodeURIComponent(id)}` });
    } else {
      const type = required(row, "type");
      const definition = getAgent(type);
      const profileId = typeof row.computer_profile === "string" ? row.computer_profile : null;
      // Web Home's rule, so the sidebar, native shells and Home list a row in the same group.
      const kind = hivraResourceKind({ type, computer_profile: profileId });
      const profile = profileId ? getComputerTemplate(profileId) : undefined;
      const desktopQuery = kind !== "computer" ? ""
        : profile?.id === "windows" ? "?tab=desktop&open=fast"
          : "?tab=desktop";
      resources.push({ uid: `x-${id}`, id, source, kind, name, status, attention: resourceAttention(status),
        description: kind === "computer" ? profile?.name ?? "Desktop computer" : definition?.name ?? type,
        href: `/dashboard/agent/${encodeURIComponent(id)}${desktopQuery}` });
    }
  }
  return resources.sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
}

export function resourceMatchesPath(resource: DashboardResource, pathname: string | null): boolean {
  const base = resource.href.split("?")[0];
  return pathname === base || Boolean(pathname?.startsWith(`${base}/`));
}

export function resourceStatusLabel(status: string): string {
  const label = status.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function filterDashboardResources(resources: DashboardResource[], query: string): DashboardResource[] {
  const term = query.trim().toLocaleLowerCase();
  return resources.filter((item) => `${item.name} ${item.description} ${item.kind} ${item.source} ${item.uid}`.toLocaleLowerCase().includes(term));
}
