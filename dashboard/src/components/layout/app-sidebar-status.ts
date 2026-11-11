import type { DashboardResource } from "./dashboard-resources";

export type SidebarStatusTone = "ok" | "busy" | "off" | "error" | "you";

const STARTING = new Set(["provisioning", "creating", "pending", "starting", "queued", "restarting"]);
const STOPPED = new Set(["stopped", "suspended", "paused"]);

/**
 * The plain word and colour family a sidebar row shows for an agent or
 * computer. Something waiting on the owner outranks its status.
 */
export function sidebarStatus(resource: Pick<DashboardResource, "status" | "attention">): { label: string; tone: SidebarStatusTone } {
  if (resource.attention === "approval" || resource.attention === "clarify") return { label: "Needs you", tone: "you" };
  const status = resource.status.trim().toLowerCase();
  if (resource.attention === "error" || status === "error" || status === "failed") return { label: "Needs attention", tone: "error" };
  if (status === "running") return { label: "Running", tone: "ok" };
  if (STARTING.has(status)) return { label: "Starting", tone: "busy" };
  if (status === "stopping") return { label: "Stopping", tone: "busy" };
  if (STOPPED.has(status)) return { label: status === "paused" ? "Paused" : "Stopped", tone: "off" };
  const words = status.replaceAll("_", " ");
  return { label: words.charAt(0).toUpperCase() + words.slice(1), tone: "busy" };
}
