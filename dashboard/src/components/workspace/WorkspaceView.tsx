import { redirect } from "next/navigation";

import { parseWorkspaceRoute } from "@/lib/workspace/workspace-route-state";
import { resolveWorkspaceRedirect } from "@/lib/workspace/workspace-redirect";

/**
 * The landing view: pick a runtime, or forward to the one named in the URL.
 *
 * This is what `/dashboard` renders when the workspace shell is enabled, and
 * what `/dashboard/workspace` forwards to — one implementation, so the two
 * cannot drift. It was previously the whole of `workspace/page.tsx`; it is a
 * component now because `/dashboard` is the better address for it and the
 * workspace route keeps its URL contract by redirecting here.
 *
 * The `?agent=&surface=` contract is unchanged: a named resource forwards to the
 * canonical agent route through `resolveWorkspaceRedirect`, whose translation has
 * its own specs because a bad mapping strands a link *silently* — the redirect
 * still returns 200, it just lands somewhere wrong.
 *
 * Home lists the owner's agents and computers, with a "Continue" link to the
 * last one. Only the app opening at Home resumes it (lib/workspace/app-open);
 * `?runtimes=1` and `?attention=1` always ask for the list.
 *
 * The caller decides whether the workspace shell is enabled — this component
 * assumes it is, so `/dashboard` can fall through to the Hermes command center
 * when it is not.
 */
export interface WorkspaceViewProps {
  searchParams: Record<string, string | string[] | undefined>;
}

export async function WorkspaceView({ searchParams }: WorkspaceViewProps) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value) && value[0]) query.set(key, value[0]);
  }

  const route = parseWorkspaceRoute(query);

  const target = resolveWorkspaceRedirect({
    agent: route.agent,
    surface: route.surface,
  });

  if (target) {
    redirect(`/dashboard/agent/${encodeURIComponent(target.id)}?tab=${target.tab}`);
  }

  // A Hermes uid (`h-`) lives at /dashboard/instances/<id> under a different
  // shell, so /dashboard/chat is the right hand-off — its resolver looks at
  // hermes_instances, which is exactly the family asked for.
  if (route.agent !== null) {
    redirect("/dashboard/chat");
  }

  const { FleetControlPane } = await import(
    "@/components/hivra/FleetControlPane"
  );

  // The switcher and the attention link ask for the list explicitly.
  return <FleetControlPane key={`${query.get("runtimes")}:${query.get("attention")}`} requested={query.get("runtimes") === "1" || query.get("attention") === "1"} attentionRequested={query.get("attention") === "1"} />;
}
