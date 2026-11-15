/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";

// A Nuphos computer runs Nuphos's OFFICIAL runtime image (Claude Code
// variant): the latest release, run by digest, unmodified. These checks read
// the installer block of provision-claude-code-box.sh.

const PROVISIONER = path.join(process.cwd(), "provisioner");
const script = fs.readFileSync(path.join(PROVISIONER, "provision-claude-code-box.sh"), "utf8");
const start = script.indexOf('if [ "$AGENT_KIND" = "nuphos" ]; then\nsay "5g/7');
const block = script.slice(start, script.indexOf("\nfi\n", script.indexOf('ok "Nuphos service installed')) + 4);
const runner = block.slice(block.indexOf("<<'RUNNER'\n") + "<<'RUNNER'\n".length, block.indexOf("\nRUNNER\n"));

describe("Nuphos guest install", () => {
  it("is an accepted agent kind with its own block and never the box browser stack", () => {
    expect(start).toBeGreaterThan(0);
    expect(script).toContain("claude|codex|aeon|openclaw|agent-zero|hermes|openbot|nuphos|linux-desktop|linux-server) ;;");
    expect(script).toContain('[ "$AGENT_KIND" = "nuphos" ] && WANT_BROWSER=0');
    expect(script).toContain('[ "$AGENT_KIND" != "nuphos" ] && ! is_linux_computer; then');
  });

  it("pulls the latest official runtime, runs it by digest on loopback, and records its release", () => {
    expect(block).toContain('NU_REPO="ghcr.io/nuphos/runtime"');
    expect(block).toContain('NU_TAG="latest-claude-code"');
    expect(block).toContain('docker pull "${NU_REPO}:${NU_TAG}"');
    expect(block).toContain("OPENAB_RUNTIME_VERSION");
    expect(block).toContain('record_agent_app nuphos "$NU_VERSION"');
    expect(runner).toContain("--network host");
    expect(runner).toContain('-e GATEWAY_LISTEN="127.0.0.1:${PORT}"');
    expect(runner).toContain("--cap-drop ALL --security-opt no-new-privileges");
    expect(runner).toContain("-v hivra-nuphos-home:/home/node");
    expect(runner).toMatch(/\^ghcr\\\.io\/nuphos\/runtime@sha256:\[0-9a-f\]\{64\}\$/);
    // No fork, overlay or credential of ours goes into the container.
    expect(runner).not.toMatch(/--env-file|OPENAB_ACP_AUTH_KEY|-v [^ ]*:\/opt/);
    expect(script).toContain('RECEIPT_ARGS+=(--agent-zero-image "$NU_IMAGE")');
  });

  it("starts the service and checks the console answers before the receipt", () => {
    expect(script).toContain("systemctl enable --now hivra-nuphos.service");
    const readiness = script.indexOf('elif [ "$AGENT_KIND" = "nuphos" ]; then\n  systemctl is-active --quiet hivra-nuphos.service');
    expect(readiness).toBeGreaterThan(0);
    expect(readiness).toBeLessThan(script.indexOf("HIVRA_RUNTIME_RECEIPT_V1"));
  });

  it("is carried through the typed installer, the host provisioner, the updater and the receipt", () => {
    for (const name of ["hivra-install-agent.py", "hivra-provision-on-host.sh", "hivra-provider-worker.py", "hivra-runtime-receipt.py", "hivra-agent-shell", "hivra-agent-app-update.sh"]) {
      expect(fs.readFileSync(path.join(PROVISIONER, name), "utf8")).toContain("nuphos");
    }
    expect(fs.readFileSync(path.join(PROVISIONER, "hivra-update-guest-runtime.sh"), "utf8")).toContain("name=(hermes|openbot|nuphos) version=");
  });
});
