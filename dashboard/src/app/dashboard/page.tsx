import { WorkspaceView } from "@/components/workspace/WorkspaceView";

/**
 * The landing page: your runtimes.
 *
 * The interaction area is the most important surface in the product, so it holds
 * the front door. `/dashboard/workspace` used to be its address, which meant the
 * nav carried both a "Home" and a "Chat" item rendering overlapping lists. Now
 * there is one landing page and no "Chat" item. `?agent=&surface=` opens a
 * runtime directly.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <WorkspaceView searchParams={params} />;
}
