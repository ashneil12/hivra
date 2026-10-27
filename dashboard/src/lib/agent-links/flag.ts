import { isCanaryDeployment } from "@/lib/deployment-channel";

type EnvLike = Record<string, string | undefined>;

/**
 * Agent ↔ computer links are on for Canary and off in production, decided on
 * the server from the deployment's own channel (like attach). The owner routes
 * and the agent API answer 404 unless this is true; Manage shows only what they
 * answer.
 */
export function isAgentLinksEnabled(env: EnvLike = process.env): boolean {
  return isCanaryDeployment(env);
}
