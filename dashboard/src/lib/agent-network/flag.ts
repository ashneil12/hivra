import { isCanaryDeployment } from "@/lib/deployment-channel";

type EnvLike = Record<string, string | undefined>;

/**
 * The agent network (shared brain, agent-to-agent messaging) is on for Canary and
 * off everywhere else, decided on the server from the deployment's own channel, so
 * production needs no environment change to keep it off. Every enforcement point
 * asks this first and denies when it is false. Production gets it only when the
 * owner promotes a release that changes this function.
 */
export function isAgentNetworkEnabled(env: EnvLike = process.env): boolean {
  return isCanaryDeployment(env);
}
