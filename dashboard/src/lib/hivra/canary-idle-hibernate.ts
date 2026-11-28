import { parseSleepMode } from "./agent-sleep-policy";
import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";

export const CANARY_DISK_IDLE_SECONDS = 12 * 60;

export function canaryIdleHibernateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const mode = parseSleepMode(env.HIVRA_SLEEP_MODE);
  return isCanonicalGitCanaryDeployment(env) && env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP === "1"
    && (mode === "on" || mode === "canary");
}
