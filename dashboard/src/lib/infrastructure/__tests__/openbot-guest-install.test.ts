/** @jest-environment node */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// An OpenBot computer runs CopilotKit's OFFICIAL OpenBot image: the latest
// release, run by digest, unmodified. These checks read the installer block of
// provision-claude-code-box.sh and run the one piece of it that handles owner
// input (the runner's reading of the Intelligence key the gateway saved).

const PROVISIONER = path.join(process.cwd(), "provisioner");
const script = fs.readFileSync(path.join(PROVISIONER, "provision-claude-code-box.sh"), "utf8");
const start = script.indexOf('if [ "$AGENT_KIND" = "openbot" ]; then\nsay "5f/7');
const block = script.slice(start, script.indexOf("\nfi\n", script.indexOf('ok "OpenBot service + restart helper installed')) + 4);
const runner = block.slice(block.indexOf("<<'RUNNER'\n") + "<<'RUNNER'\n".length, block.indexOf("\nRUNNER\n"));

describe("OpenBot guest install", () => {
  it("is an accepted agent kind with its own block and never the box browser stack", () => {
    expect(start).toBeGreaterThan(0);
    expect(script).toContain("claude|codex|aeon|openclaw|agent-zero|hermes|openbot|nuphos|linux-desktop|linux-server) ;;");
    expect(script).toContain('[ "$AGENT_KIND" = "openbot" ] && WANT_BROWSER=0');
    expect(script).toContain('[ "$AGENT_KIND" != "openbot" ] && [ "$AGENT_KIND" != "nuphos" ] && ! is_linux_computer; then');
  });

  it("pulls upstream's latest image, runs it by digest on loopback, single-user, and records its release", () => {
    expect(block).toContain('OB_REPO="ghcr.io/copilotkit/openbot"');
    expect(block).toContain('docker pull "${OB_REPO}:latest"');
    expect(block).toContain("OPENBOT_BUILD_VERSION");
    expect(block).toContain('record_agent_app openbot "$OB_VERSION"');
    expect(block).toContain("OPENBOT_SINGLE_USER=true");
    expect(block).toContain("TRUSTED_ORIGINS=http://127.0.0.1:%s");
    expect(block).toContain("EMBEDDED_POSTGRES=on");
    // Venice speaks Chat Completions.
    expect(block).toContain("COPILOTKIT_OPENAI_API=chat");
    expect(runner).toContain("--network host");
    expect(runner).toMatch(/\^ghcr\\\.io\/copilotkit\/openbot@sha256:\[0-9a-f\]\{64\}\$/);
    // The key never travels on a command line.
    expect(runner).toContain('--env-file "$ROOT/intelligence.env"');
    expect(runner).not.toMatch(/-e CPK_INTELLIGENCE_API_KEY/);
    expect(script).toContain('RECEIPT_ARGS+=(--agent-zero-image "$OB_IMAGE")');
  });

  describe("the runner's key reader", () => {
    const reader = runner.slice(runner.indexOf("python3 -I -c '") + "python3 -I -c '".length, runner.indexOf("' \"$KEY_FILE\""));
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-openbot-key-")); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const read = (file: string) => spawnSync("python3", ["-I", "-c", reader, file], { encoding: "utf8" });

    it("reads a saved key", () => {
      fs.writeFileSync(path.join(dir, "key"), "cpk-abc_DEF.123\n");
      const result = read(path.join(dir, "key"));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("cpk-abc_DEF.123\n");
    });

    it.each([
      ["a missing file", () => path.join(dir, "missing")],
      ["a key with a newline that would add a setting", () => { fs.writeFileSync(path.join(dir, "key"), "cpk-abc\nPORT=1\n"); return path.join(dir, "key"); }],
      ["a link to another file", () => { fs.writeFileSync(path.join(dir, "secret"), "cpk-not-yours-1234"); fs.symlinkSync(path.join(dir, "secret"), path.join(dir, "key")); return path.join(dir, "key"); }],
      ["a folder", () => { fs.mkdirSync(path.join(dir, "key")); return path.join(dir, "key"); }],
    ])("refuses %s", (_name, make) => {
      expect(read(make()).status).not.toBe(0);
    });
  });
});
