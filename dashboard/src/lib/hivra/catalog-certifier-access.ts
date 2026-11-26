import "server-only";

import { isCanonicalGitCanaryDeployment } from "@/lib/hivra/canonical-git-canary";

export function canCertifyCatalog(userId: string | null | undefined, env = process.env): boolean {
  const ownerId = env.HIVRA_CATALOG_CERTIFIER_OWNER_ID;
  return Boolean(ownerId && /^user_[A-Za-z0-9]+$/.test(ownerId)
    && userId === ownerId && isCanonicalGitCanaryDeployment(env));
}
