import { isCanaryDeployment } from "@/lib/deployment-channel";

type EnvLike = Record<string, string | undefined>;

/**
 * Adding an agent to a computer its owner already has (slice 15) is on for
 * Canary and off in production, decided on the server from the deployment's
 * own channel, so production needs no environment change to keep it off
 * (design 5.6, build step 8). The attach routes and the minute worker refuse
 * to run unless this is true; the UI only shows what those routes answer.
 */
export function isAgentAttachEnabled(env: EnvLike = process.env): boolean {
  return isCanaryDeployment(env);
}
