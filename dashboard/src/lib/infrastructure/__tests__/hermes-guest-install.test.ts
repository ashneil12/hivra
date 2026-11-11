/** @jest-environment node */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A made-up managed key, built at run time so it never reads as a credential.
const SAMPLE_KEY = ["hven", "abc-DEF", "123"].join("_");

// A Hermes computer runs OFFICIAL Hermes, installed by Hermes's own installer:
// no fork, no overlay, no pin, no patches. These checks read the installer
// block of provision-claude-code-box.sh and run the one piece of it that is
// ours (writing the model key into ~/.hermes/.env), since the real install
// needs a computer and the network.

const PROVISIONER = path.join(process.cwd(), "provisioner");
const script = fs.readFileSync(path.join(PROVISIONER, "provision-claude-code-box.sh"), "utf8");
const start = script.indexOf('if [ "$AGENT_KIND" = "hermes" ]; then\nsay "5e/7');
const block = script.slice(start, script.indexOf("\nfi\n", script.indexOf("ok \"Hermes dashboard service installed")) + 4);

describe("Hermes guest install", () => {
  it("has a Hermes block, accepted as an agent kind and never given the browser stack", () => {
    expect(start).toBeGreaterThan(0);
    expect(script).toContain("claude|codex|aeon|openclaw|agent-zero|hermes|linux-desktop|linux-server) ;;");
    expect(script).toContain('[ "$AGENT_KIND" = "hermes" ] && WANT_BROWSER=0');
    // Not given the Hivra clean-assistant prompt rewrite that coding agents get.
    expect(script).toContain('[ "$AGENT_KIND" != "hermes" ] && ! is_linux_computer; then\nsay "6/7');
  });

  it("downloads the official installer over HTTPS to a file and runs it as the agent user, never as root or piped", () => {
    expect(block).toContain('HERMES_INSTALL_URL="https://hermes-agent.nousresearch.com/install.sh"');
    expect(block).toMatch(/sudo -u "\$\{AGENT_USER\}" -H curl --proto '=https' --tlsv1\.2 -fsSL/);
    expect(block).toMatch(/sudo -u "\$\{AGENT_USER\}" -H env [^\n]*\\\n\s+bash "\$\{HERMES_TMP\}\/install\.sh" --non-interactive --skip-browser --channel stable/);
    // No pipe into a shell, no unpinned root shell, no version or commit pin.
    expect(block).not.toMatch(/curl[^\n]*\|\s*(sudo\s+)?(ba)?sh/);
    expect(block).not.toMatch(/--(branch|commit|dir)\b/);
    expect(block).not.toMatch(/HERMES_VERSION=.*read_agent_app_pin/);
    expect(block).not.toMatch(/git (clone|checkout|apply)|patch |pip install|npm i/);
  });

  it("points Hermes at managed Venice through hermes config set, keeping the key out of argv", () => {
    expect(block).toContain('HERMES_MODEL="${HIVRA_HERMES_MODEL:-deepseek-v4-1-flash}"');
    expect(block).toContain('hermes_cfg model.provider custom');
    expect(block).toContain('hermes_cfg model.base_url "${HERMES_BASEURL}"');
    expect(block).toContain('hermes_cfg model.default "${HERMES_MODEL}"');
    // The key travels on stdin to a script that writes ~/.hermes/.env as 0600.
    expect(block).toMatch(/printf '%s' "\$\{HIVRA_MODEL_KEY\}" \\\n\s+\| sudo -u "\$\{AGENT_USER\}" -H env/);
    expect(block).not.toMatch(/config set[^\n]*HIVRA_MODEL_KEY/);
    // Values are checked before they reach a command or a file.
    expect(block).toContain("grep -qE '^[A-Za-z0-9_-]+$'");
    expect(block).toContain("grep -qE '^https://[A-Za-z0-9.:/_-]+$'");
  });

  it("runs Hermes's dashboard on loopback as the agent user under its own unit", () => {
    expect(block).toContain("cat > /etc/systemd/system/bux-hermes.service <<UNIT");
    expect(block).toContain("User=${AGENT_USER}");
    expect(block).toContain("ExecStart=${HERMES_BIN} dashboard --host 127.0.0.1 --port ${HERMES_PORT} --no-open");
    expect(block).toContain("HERMES_PORT=9119");
    expect(block).not.toMatch(/--host 0\.0\.0\.0|--insecure/);
  });

  it("records the installed version the way the other apps do, and checks readiness before the receipt", () => {
    expect(block).toContain('record_agent_app hermes "$HERMES_VERSION"');
    expect(block).toContain('"${HERMES_BIN}" --version');
    expect(script).toContain("systemctl enable --now bux-hermes.service");
    const readiness = script.indexOf('elif [ "$AGENT_KIND" = "hermes" ]; then\n  systemctl is-active --quiet bux-hermes.service');
    expect(readiness).toBeGreaterThan(0);
    expect(script.slice(readiness)).toContain('wait_for_http "http://127.0.0.1:${HERMES_PORT}/"');
    expect(readiness).toBeLessThan(script.indexOf("HIVRA_RUNTIME_RECEIPT_V1"));
  });

  it("is carried through the typed installer, the host provisioner and the receipt", () => {
    for (const name of ["hivra-install-agent.py", "hivra-provision-on-host.sh", "hivra-provider-worker.py", "hivra-runtime-receipt.py"]) {
      expect(fs.readFileSync(path.join(PROVISIONER, name), "utf8")).toContain("hermes");
    }
    expect(fs.readFileSync(path.join(PROVISIONER, "hivra-update-guest-runtime.sh"), "utf8")).toContain("name=hermes version=");
    expect(fs.readFileSync(path.join(PROVISIONER, "hivra-guest-runtime-update.sh"), "utf8")).toContain("target=latest");
  });

  describe("the model key file", () => {
    const heredoc = block.match(/cat > "\$\{HERMES_TMP\}\/seed-env\.py" <<'PY'\n([\s\S]*?)\nPY\n/);
    let home: string;
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-hermes-env-")); });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
    const seed = (key: string) => {
      const file = path.join(home, "seed-env.py");
      fs.writeFileSync(file, heredoc![1]);
      return spawnSync("python3", ["-I", file, "https://gateway.test/v1"], { input: key, encoding: "utf8", env: { ...process.env, HERMES_HOME: home } });
    };

    it("writes OPENAI_BASE_URL and OPENAI_API_KEY with mode 600 and keeps the other settings", () => {
      expect(heredoc).not.toBeNull();
      const env = path.join(home, ".env");
      fs.writeFileSync(env, "KEEP=1\nOPENAI_API_KEY=old\nOPENAI_BASE_URL=https://old.test\n", { mode: 0o644 });
      const result = seed(SAMPLE_KEY);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(env, "utf8").trim().split("\n")).toEqual([
        "KEEP=1", "OPENAI_BASE_URL=https://gateway.test/v1", `OPENAI_API_KEY=${SAMPLE_KEY}`,
      ]);
      expect(fs.statSync(env).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(`${env}.next`)).toBe(false);
    });

    it("creates the file when Hermes has not yet", () => {
      expect(seed("hven_x").status).toBe(0);
      expect(fs.statSync(path.join(home, ".env")).mode & 0o777).toBe(0o600);
    });
  });
});
