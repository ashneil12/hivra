import { isWorkspaceShellEnabled } from "@/lib/flags/workspace-shell";
import { WorkspaceView } from "@/components/workspace/WorkspaceView";

/**
 * The landing page: your runtimes, or the Hermes command center.
 *
 * The interaction area is the most important surface in the product, so it holds
 * the front door. `/dashboard/workspace` used to be its address, which meant the
 * nav carried both a "Home" and a "Chat" item rendering overlapping lists — four
 * items listing the same agents and computers once Agents and Computers are
 * counted. Now there is one landing page and no "Chat" item.
 *
 * The switch is the **server** flag (`HIVRA_WORKSPACE_SHELL_ENABLED`), not the
 * client `isHivraEnabled()` hostname check, because the decision has to pick a
 * component before anything ships to the browser. It is `"1"` on canary and unset
 * on prod, so:
 *
 *   - canary → the workspace view (pick a runtime, or follow `?agent=&surface=`)
 *   - prod   → the Hermes command center, which is all prod has
 *
 * Keeping the flag as the switch also preserves it as a kill switch: unsetting
 * it returns `/dashboard` to the Hermes page with no code change, and the
 * workspace view stays reachable at its own route meanwhile.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  if (isWorkspaceShellEnabled()) {
    return <WorkspaceView searchParams={params} />;
  }

  const { HermesDashboardPage } = await import(
    "@/components/dashboard/HermesDashboardPage"
  );
  return <HermesDashboardPage />;
}
