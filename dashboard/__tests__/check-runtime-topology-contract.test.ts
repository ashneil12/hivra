import fs from "node:fs";
import path from "node:path";

describe("runtime topology contract", () => {
  const composePath = path.resolve(__dirname, "..", "..", "docker-compose.yml");
  const compose = fs.readFileSync(composePath, "utf8");

  it("keeps the checked-in runtime pinned to the external vanilla Hermes agent image", () => {
    expect(compose).toContain("image: ghcr.io/ashneil12/vanilla-hermes-agent:latest");
    expect(compose).toContain('command: "gateway run"');
    expect(compose).toContain("- HERMES_HOME=/root/.hermes");
  });

  it("keeps the sidecar service wired to the checked-in server entrypoint and auth contract", () => {
    expect(compose).toContain("sidecar:");
    expect(compose).toContain("- ./sidecar_server.js:/opt/data/server.js");
    expect(compose).toContain(
      "- API_SERVER_KEY=${API_SERVER_KEY:?Set API_SERVER_KEY before starting the sidecar}",
    );
    expect(compose).toContain('- "9090"');
    expect(compose).toContain("- agent-profiles:/profiles");
  });
});
