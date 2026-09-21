import {
  WEBUI_HERMES_AGENT_DIR,
  WEBUI_HERMES_HOME,
  WEBUI_CLEARABLE_RUNTIME_ENV_KEYS,
  WEBUI_MANAGED_RUNTIME_ENV_KEYS,
  WEBUI_PERSISTENT_INSTALL_ENV_KEYS,
  WEBUI_PERSISTENT_INSTALL_ENV_LINES,
  buildWebUIContainerCliShimCommand,
  buildWebUIHermesPythonRuntimeCommand,
  buildWebUIPersistentStatePermissionRepairCommand,
  buildWebUIPersistentStateShimCommand,
  buildWebUIToolchainDiagnosticCommand,
  buildWebUIUsrLocalHermesShimCommand,
} from "../webui-runtime-env";

describe("webui runtime environment", () => {
  it("prefers the packaged Hermes virtualenv command over the raw source wrapper", () => {
    const script = buildWebUIPersistentStateShimCommand("agent-inst-123");
    const venvHermes = `${WEBUI_HERMES_AGENT_DIR}/.venv/bin/hermes`;
    const sourceHermes = `${WEBUI_HERMES_AGENT_DIR}/hermes`;

    expect(script).toContain(`target="${venvHermes}"`);
    expect(script).toContain(`if [ ! -x /agent-source/.venv/bin/hermes ]; then`);
    expect(script).toContain(`target="${sourceHermes}"`);
    expect(script).toContain("test -x /agent-source/hermes");
  });

  it("fails diagnostics with startup output when the active Hermes CLI cannot import its dependencies", () => {
    const script = buildWebUIToolchainDiagnosticCommand("agent-inst-123");

    expect(script).toContain('hermes_path="$(command -v hermes || true)"');
    expect(script).toContain('resolved_hermes="$(readlink -f "$hermes_path" 2>/dev/null || printf "%s" "$hermes_path")"');
    expect(script).toContain("if ! hermes --help >/tmp/hermes-cli-startup.log 2>&1; then");
    expect(script).toContain("[webui-hermes-cli-check] Hermes CLI failed to start");
    expect(script).toContain("[webui-hermes-cli-check] resolved hermes=");
    expect(script).toContain("cat /tmp/hermes-cli-startup.log >&2 || true");
  });

  it("repairs the durable Hermes log directory before WebUI starts", () => {
    const script = buildWebUIPersistentStateShimCommand("agent-inst-123");

    expect(script).toContain("mkdir -p /state/bin /state/logs");
    expect(script).toContain("touch /state/logs/errors.log /state/logs/agent.log");
    expect(script).toContain("chown -R 1024:1024 /state/bin /state/logs");
    expect(script).toContain("chmod 755 /state/logs");
    expect(script).toContain("chmod 664 /state/logs/errors.log /state/logs/agent.log");
  });

  it("diagnoses unwritable Hermes log files before users hit first-message failures", () => {
    const script = buildWebUIToolchainDiagnosticCommand("agent-inst-123");

    expect(script).toContain('if ! mkdir -p "$HERMES_HOME/logs"');
    expect(script).toContain('if ! : >> "$HERMES_HOME/logs/errors.log"');
    expect(script).toContain("[webui-log-writability-check] cannot create Hermes log directory");
    expect(script).toContain("[webui-log-writability-check] cannot write $HERMES_HOME/logs/errors.log");
    expect(script).toContain('ls -ld "$HERMES_HOME" "$HERMES_HOME/logs"');
  });

  it("installs python3 from apt so the agent venv shebang resolves to python 3.13", () => {
    const script = buildWebUIHermesPythonRuntimeCommand("agent-inst-123");

    expect(script).toContain("docker exec --user 0 -i agent-inst-123 /bin/sh");
    // Skip apt install when /usr/bin/python3 already resolves to python3.13.
    expect(script).toContain("if [ -x /usr/bin/python3 ]; then");
    expect(script).toContain('resolved="$(readlink -f /usr/bin/python3 2>/dev/null || true)"');
    expect(script).toContain("*python3.13*) exit 0 ;;");
    // Otherwise install python3 (Debian trixie main = python 3.13) which
    // also creates the /usr/bin/python3 -> python3.13 symlink the agent
    // venv's bin/python chain expects.
    expect(script).toContain("apt-get install -y --no-install-recommends python3");
    expect(script).toContain("[webui-hermes-python-runtime] /usr/bin/python3 missing after apt-get install");
  });

  it("pre-creates the gateway runtime dirs as uid 1024 so a born-webfree gateway never crashloops on a root-owned hooks dir", () => {
    const script = buildWebUIPersistentStatePermissionRepairCommand("agent-inst-123");

    // Runs as root before container start, mounting the shared webui-state volume.
    expect(script).toContain("docker run --rm -i -u 0:0");
    expect(script).toContain("-v agent-inst-123_webui-state:/state");

    // The four hermes runtime dirs must be pre-created here. On a fresh volume the
    // root-running official-dashboard would otherwise mint them root:0 mode 700,
    // and the uid-1024 gateway's hooks discover_and_load() iterdir() would then
    // PermissionError and crash-loop (never binding :8642).
    for (const dir of ["hooks", "audio_cache", "image_cache", "pairing"]) {
      expect(script).toContain(`/state/${dir}`);
    }

    // The recursive chown re-homes them (and any pre-existing root-owned dir) to
    // uid 1024 so the gateway can scandir them as the owner.
    expect(script).toContain("chown -R 1024:1024 /state");
  });

  it("uses the new Hermes runtime home when running live commands as numeric uid 1024", () => {
    const cliShimScript = buildWebUIContainerCliShimCommand("agent-inst-123");
    const diagnosticScript = buildWebUIToolchainDiagnosticCommand("agent-inst-123");

    expect(cliShimScript).toContain("docker exec --user 1024");
    expect(cliShimScript).toContain("export HOME=/home/hermes");
    expect(cliShimScript).toContain('export HERMES_HOME="/home/hermes/.hermes"');
    expect(cliShimScript).toContain('mkdir -p "$HOME/.local/bin"');

    expect(diagnosticScript).toContain("docker exec --user 1024");
    expect(diagnosticScript).toContain("export HOME=/home/hermes");
    expect(diagnosticScript).toContain('export HERMES_HOME="/home/hermes/.hermes"');
  });

  it("symlinks hermes into /usr/local/bin so it resolves on an agent login-shell PATH", () => {
    const script = buildWebUIUsrLocalHermesShimCommand("agent-inst-123");
    const venvHermes = `${WEBUI_HERMES_AGENT_DIR}/.venv/bin/hermes`;
    const sourceHermes = `${WEBUI_HERMES_AGENT_DIR}/hermes`;

    // Runs as root (uid 1024 cannot write /usr/local/bin), guarded on the
    // container actually running so the update path tolerates a restarting
    // gateway without failing the deploy.
    expect(script).toContain(
      "docker inspect --format='{{.State.Running}}' agent-inst-123"
    );
    expect(script).toContain("docker exec --user 0 agent-inst-123");

    // Prefers the relocated venv binary, falls back to the source wrapper, and
    // installs both hermes + hermes-cli onto the default system PATH.
    expect(script).toContain(`target="${venvHermes}"`);
    expect(script).toContain(`target="${sourceHermes}"`);
    expect(script).toContain("ln -sfn \"$target\" /usr/local/bin/hermes");
    expect(script).toContain("ln -sfn \"$target\" /usr/local/bin/hermes-cli");

    // Best-effort: a failed exec warns but never aborts the bootstrap.
    expect(script).toContain("[webui-usrlocal-shim] WARN");
  });

  it("targets the -gateway container where the agent terminal tool runs", () => {
    const gatewayScript = buildWebUIUsrLocalHermesShimCommand(
      "agent-inst-123-gateway"
    );
    expect(gatewayScript).toContain("docker exec --user 0 agent-inst-123-gateway");
    expect(gatewayScript).toContain("/usr/local/bin/hermes");
  });
});

describe("lazy-install target + managed Daytona key", () => {
  it("pins HERMES_LAZY_INSTALL_TARGET onto the uid-1024-writable HERMES_HOME", () => {
    // The agent image hardcodes /opt/data/lazy-packages and seeds it via its s6
    // stage2-hook — but these boxes bypass s6 (entrypoint:[] + gateway-supervisor)
    // and home at /home/hermes/.hermes, so that path is root-owned/absent and EVERY
    // lazy feature (terminal.daytona, terminal.modal, TTS, Firecrawl, mem0,
    // connectors) died with "lazy install target ... is not writable".
    const line = WEBUI_PERSISTENT_INSTALL_ENV_LINES.find((l) =>
      l.startsWith("HERMES_LAZY_INSTALL_TARGET=")
    );
    expect(line).toBe(`HERMES_LAZY_INSTALL_TARGET=${WEBUI_HERMES_HOME}/lazy-packages`);
    expect(line).not.toContain("/opt/data");
    // Auto-joining the pinned key set is what stops a stale persisted .env winning.
    expect(WEBUI_PERSISTENT_INSTALL_ENV_KEYS).toContain("HERMES_LAZY_INSTALL_TARGET");
  });

  it("manages every user-entered per-instance key so a saved value reaches existing boxes", () => {
    // The update path preserves /state/.env and only re-applies the managed key
    // set from the freshly generated hermes.env. Any user-entered key emitted
    // into hermes.env but missing here is silently FROZEN on already-provisioned
    // boxes: a newly-added key is never added, an edited key keeps its old value
    // forever, and the user just sees the feature stay broken however many times
    // they re-save. Add a key here whenever buildHermesEnvFile learns to emit a
    // new user-settable value.
    for (const key of ["DAYTONA_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY"]) {
      expect(WEBUI_MANAGED_RUNTIME_ENV_KEYS).toContain(key);
    }
  });

  it("does NOT manage provider/model env pins — config.yaml owns those", () => {
    // The update path deliberately scrubs stale provisioning-time model pins and
    // treats config.yaml as the owner of provider/model. Managing them here would
    // fight that contract and re-pin a value the user already switched.
    for (const key of ["HERMES_INFERENCE_PROVIDER", "OPENAI_BASE_URL", "HERMES_MODEL"]) {
      expect(WEBUI_MANAGED_RUNTIME_ENV_KEYS).not.toContain(key);
    }
  });
});

describe("WEBUI_CLEARABLE_RUNTIME_ENV_KEYS", () => {
  it("only clears keys the repair also manages", () => {
    // Clearing keys off a box that the upsert half never re-applies would be a
    // one-way door: the value could be removed but never restored.
    for (const key of WEBUI_CLEARABLE_RUNTIME_ENV_KEYS) {
      expect(WEBUI_MANAGED_RUNTIME_ENV_KEYS).toContain(key);
    }
  });

  it("never clears BANKR_* — absence there can mean the wallet lookup threw", () => {
    // THE load-bearing assertion. Clearing keys on "absent from the generated
    // env" is only sound when absence unambiguously means the user cleared it.
    // BANKR_* comes from resolveBankrAgentConfigForUpdate(), which catches ANY
    // error and returns null, so buildBankrEnvLines emits [] for BOTH "no wallet"
    // and "the lookup just threw". Clearing on that would erase live wallet
    // credentials from every box that hit a transient DB hiccup mid-redeploy.
    // If this ever needs to change, teach that resolver to distinguish
    // resolved-empty from lookup-failed FIRST, and suppress the clear on failure.
    const bankr = WEBUI_MANAGED_RUNTIME_ENV_KEYS.filter((k) => k.startsWith("BANKR_"));
    expect(bankr.length).toBeGreaterThan(0);
    for (const key of bankr) {
      expect(WEBUI_CLEARABLE_RUNTIME_ENV_KEYS).not.toContain(key);
    }
  });

  it("clears BROWSER_CDP_URL — every reading of its absence wants it dropped", () => {
    // Absence IS ambiguous here (user disabled / tier+RAM said no / the fleet-wide
    // CDP kill switch), which is why this was originally excluded. The ambiguity
    // doesn't matter: the same expression that emits the line gates whether the
    // sidecar container exists at all, so an absent line always means the URL
    // points at nothing, and all three readings want the same action. Left behind,
    // browser_tool.py connects over CDP to a deleted container.
    expect(WEBUI_CLEARABLE_RUNTIME_ENV_KEYS).toContain("BROWSER_CDP_URL");
  });

  it("never clears HERMES_BROWSER_SIDECAR_URL — the stale sentinel is the correct state", () => {
    // Goes absent on exactly the same runs as BROWSER_CDP_URL, so the symmetry is
    // tempting — but it is only ever emitted as the "disabled" SENTINEL, and a stale
    // sentinel already produces the right outcome: no sidecar container means
    // _is_sidecar_available() must fail, and the sentinel fails it instantly on the
    // missing scheme. Clearing it would fall back to _DEFAULT_URL and buy a real 3s
    // network probe for the same unregistered toolset.
    expect(WEBUI_CLEARABLE_RUNTIME_ENV_KEYS).not.toContain("HERMES_BROWSER_SIDECAR_URL");
  });
});
