import fs from "fs";
import os from "os";
import path from "path";

import { loadOpsEnv } from "@/lib/ops/load-ops-env";

describe("loadOpsEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("preserves Hetzner secrets from the ops env file when .env.local leaves them blank", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "load-ops-env-"));
    const homeDir = path.join(tempRoot, "home");
    const appDir = path.join(tempRoot, "app");
    const opsDir = path.join(homeDir, ".config", "hermesdeploy");

    fs.mkdirSync(opsDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(opsDir, "ops-secrets.env"),
      "HETZNER_API_TOKEN=ops-secret-token\n",
      "utf8"
    );
    fs.writeFileSync(path.join(appDir, ".env.local"), 'HETZNER_API_TOKEN=""\n', "utf8");

    delete process.env.HETZNER_API_TOKEN;

    loadOpsEnv(appDir, process.env, homeDir);

    expect(process.env.HETZNER_API_TOKEN).toBe("ops-secret-token");
  });
});
