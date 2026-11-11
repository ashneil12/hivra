/** @jest-environment node */
jest.mock("server-only", () => ({}));

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HOME_CONNECTOR_FILES, HomeConnectorScriptError, renderHomeConnectorInstaller } from "../home-connector-install-script";

describe("the home connector installer", () => {
  it("serves the same connector files that live in services/host-connector", () => {
    for (const name of HOME_CONNECTOR_FILES) {
      const served = readFileSync(join(process.cwd(), "bootstrap/home-connector", name));
      const source = readFileSync(join(process.cwd(), "..", "services/host-connector", name));
      expect(served.equals(source)).toBe(true);
    }
  });

  it("is one script: validates the code, carries the files, exchanges the code for config, prints no secret", async () => {
    const script = await renderHomeConnectorInstaller("https://canary.example.test");
    expect(script).toContain("origin='https://canary.example.test'");
    expect(script).toContain("^hvc_[A-Za-z0-9_-]{32}$");
    for (const name of HOME_CONNECTOR_FILES) expect(script).toContain(`base64 -d > "$tmp/${name}"`);
    expect(script).toContain("/api/infrastructure/home-connector/enrol");
    expect(script).toContain('bash "$tmp/install.sh" < "$tmp/config.json"');
    expect(script).not.toMatch(/echo .*\$token|cat .*config\.json"?$/m);
  });

  it("refuses an origin that is not the bare https app origin", async () => {
    await expect(renderHomeConnectorInstaller("http://canary.example.test")).rejects.toThrow();
    await expect(renderHomeConnectorInstaller("https://x.test/'; rm -rf /")).rejects.toThrow();
  });

  it("serves nothing when a file is missing", async () => {
    await expect(renderHomeConnectorInstaller("https://canary.example.test", async () => { throw new Error("missing"); }))
      .rejects.toBeInstanceOf(HomeConnectorScriptError);
  });
});
