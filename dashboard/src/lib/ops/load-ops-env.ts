import { loadEnvConfig } from "@next/env";
import * as dotenv from "dotenv";

import { resolveOpsSecretEnvPath } from "./account-deletion";

export function loadOpsEnv(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
  homeDir = process.env.HOME || ""
): string {
  const opsSecretEnvPath = resolveOpsSecretEnvPath(env, homeDir);
  dotenv.config({ path: opsSecretEnvPath, override: true, quiet: true });
  loadEnvConfig(cwd);
  return opsSecretEnvPath;
}
