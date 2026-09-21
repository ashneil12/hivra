import { spawnSync } from "node:child_process";
import { buildHermesTuiBootstrapCommand } from "@/lib/hermes-tui-bootstrap";

describe("buildHermesTuiBootstrapCommand", () => {
  it("repairs the legacy ui-tui runtime before delegating to the Hermes CLI", () => {
    const command = buildHermesTuiBootstrapCommand();

    expect(command).toContain("TERM=xterm-256color");
    expect(command).toContain("stty cols \\${COLUMNS:-80} rows \\${LINES:-24}");
    expect(command).toContain("/opt/hermes/ui-tui/node_modules/@hermes/ink/dist/ink-bundle.js");
    expect(command).toContain("/opt/hermes/ui-tui/node_modules/@hermes/ink/package.json");
    expect(command).toContain("/opt/hermes/ui-tui/node_modules/.bin/esbuild");
    expect(command).toContain("cd /opt/hermes/ui-tui");
    expect(command).toContain("Repairing Hermes TUI runtime...");
    expect(command).toContain("Hermes TUI repair build:");
    expect(command).toContain("Hermes TUI repair strategy:");
    expect(command).toContain("toolchain missing, reinstalling dependencies");
    expect(command).toContain("rm -rf node_modules");
    expect(command).toContain("npm install --include=dev --silent --no-fund --no-audit");
    expect(command).toContain("npm run build --prefix packages/hermes-ink");
    expect(command).toContain("hermes-ink build failed, trying ui-tui build");
    expect(command).toContain("npm run build || { echo '[!] Hermes TUI repair: ui-tui build failed' >&2; exit 1; }");
    expect(command).toContain("cp -r packages/hermes-ink/dist/. node_modules/@hermes/ink/dist/");
    expect(command).toContain("Hermes TUI repair: failed to reset node_modules");
    expect(command).toContain("Hermes TUI repair: npm install failed");
    expect(command).toContain("Hermes TUI repair: ui-tui build failed");
    expect(command).toContain("Hermes TUI repair: ink-bundle.js is still missing after repair");
    expect(command).toContain("/opt/hermes/.venv/bin/hermes --tui");
    expect(command).toContain("command -v hermes");
    expect(command).toContain("exec hermes --tui");
    expect(command).toContain("Hermes CLI not found in container PATH");
  });

  it("emits shell-valid bootstrap syntax", () => {
    const command = buildHermesTuiBootstrapCommand();
    const result = spawnSync("bash", ["-n", "-c", command], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
