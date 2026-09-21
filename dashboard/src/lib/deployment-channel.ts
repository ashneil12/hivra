type EnvLike = Record<string, string | undefined>;

function explicitChannel(env: EnvLike): string | undefined {
  return (
    env.HERMES_DEPLOY_CHANNEL ||
    env.NEXT_PUBLIC_HERMES_DEPLOY_CHANNEL ||
    env.HERMES_RELEASE_CHANNEL ||
    env.NEXT_PUBLIC_HERMES_RELEASE_CHANNEL
  )?.trim();
}

function isCanaryToken(value: string | undefined): boolean {
  return /(^|[-_/.:])canary($|[-_/.:])/i.test(value || "");
}

function isProdToken(value: string | undefined): boolean {
  return /^(prod|production|main)$/i.test((value || "").trim());
}

function hostnameFromUrl(value: string | undefined): string {
  if (!value?.trim()) return "";
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function isCanaryDeployment(env: EnvLike = process.env): boolean {
  const channel = explicitChannel(env);
  if (isCanaryToken(channel)) return true;
  if (isProdToken(channel)) return false;

  const repoSlug = env.VERCEL_GIT_REPO_SLUG || env.GITHUB_REPOSITORY || "";
  if (isCanaryToken(repoSlug)) return true;

  const deploymentTargets = [
    env.NEXT_PUBLIC_APP_URL,
    env.VERCEL_PROJECT_PRODUCTION_URL,
    env.NEXT_PUBLIC_VERCEL_URL,
    env.VERCEL_URL,
  ].map(hostnameFromUrl);

  return deploymentTargets.some(isCanaryToken);
}

export function deploymentScopedDefault<T>(
  values: { production: T; canary: T },
  env: EnvLike = process.env
): T {
  return isCanaryDeployment(env) ? values.canary : values.production;
}
