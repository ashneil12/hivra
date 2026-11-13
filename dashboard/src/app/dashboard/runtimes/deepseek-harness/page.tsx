import { redirect } from "next/navigation";

import { buildLaunchHref } from "@/lib/hivra/launch-navigation";

/** DeepSeek Harness launches from Launch like every other agent. The old
 * preview address forwards there, so bookmarks and links keep working. */
export default function DeepSeekHarnessPage() {
  redirect(buildLaunchHref({ start: true, profile: "deepseek-harness" }));
}
