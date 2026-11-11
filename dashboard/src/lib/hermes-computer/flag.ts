import { isCanaryDeployment } from "@/lib/deployment-channel";

type EnvLike = Record<string, string | undefined>;

/**
 * New Hermes agents launch as a Hivra computer (official Hermes installed by
 * its own installer, its own web UI shown behind the Hivra gate) on Canary and
 * not yet in production. Like attach and agent links, this is decided on the
 * server from the deployment's own channel, so production needs no environment
 * change to keep it off. Promoting it is removing this check.
 *
 * Off means the launch lane before it: a new Hermes agent goes to the existing
 * Hermes instances lane, exactly as it did. Hermes agents already created on
 * either lane are never affected by this flag.
 */
export function isHermesComputerEnabled(env: EnvLike = process.env): boolean {
  return isCanaryDeployment(env);
}
