import "server-only";
import { z } from "zod";
import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";
import { GvisorLocalImageSchema } from "./gvisor-computer-contract";

const settings = z.object({
  owner: z.string().regex(/^user_[a-zA-Z0-9_]{1,128}$/),
  target: z.string().uuid(),
  image: GvisorLocalImageSchema,
  adapter: z.string().regex(/^[0-9a-f]{64}$/),
  origin: z.string().url().refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.port === ""
      && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(url.hostname)
      && url.hostname !== "canary.hermesos.cloud";
  }),
  grantKey: z.string().regex(/^[0-9a-f]{64}$/),
});

export function claudeSandboxPilot(userId: string | null | undefined, env: Record<string, string | undefined> = process.env) {
  if (!userId || env.HIVRA_CLAUDE_SANDBOX_PILOT_ENABLED !== "1" || !isCanonicalGitCanaryDeployment(env)) return null;
  const result = settings.safeParse({
    owner: env.HIVRA_CLAUDE_SANDBOX_PILOT_OWNER,
    target: env.HIVRA_CLAUDE_SANDBOX_PILOT_TARGET,
    image: env.HIVRA_CLAUDE_SANDBOX_PILOT_IMAGE,
    adapter: env.HIVRA_CLAUDE_SANDBOX_PILOT_ADAPTER_SHA,
    origin: env.HIVRA_CLAUDE_SANDBOX_PILOT_ORIGIN,
    grantKey: env.HIVRA_CLAUDE_SANDBOX_PILOT_GRANT_KEY,
  });
  return result.success && result.data.owner === userId ? result.data : null;
}
