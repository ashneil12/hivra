import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildIngressAttachScript,
  buildIngressDetachScript,
  buildIngressGuestTunnelScript,
  buildIngressPreflightScript,
  buildIngressStatusScript,
  GUEST_TUNNEL_PROGRAM,
  parseIngressStep,
} from "../cutover-scripts";
import { buildIngressAttachPayload, buildIngressRoute } from "../route-file";

const TAG = "hivra-agent-abc";
const HOSTNAME = "box-4321.example.test";
const GUEST_IP = "10.250.20.57";
const FAKE_RUN_DOC = "e".repeat(80); // shaped like a run token, not one
const REAL_PY = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();

function allScripts(): Array<[string, string]> {
  return [
    ["preflight", buildIngressPreflightScript({ vmid: 4321, bindingTag: TAG })],
    ["attach", buildIngressAttachScript({ vmid: 4321, bindingTag: TAG, hostname: HOSTNAME, guestIp: GUEST_IP, metricsPort: 21000 })],
    ["detach", buildIngressDetachScript({ vmid: 4321, hostname: HOSTNAME })],
    ["status", buildIngressStatusScript({ vmid: 4321, metricsPort: 21000 })],
    ["guest_disable", buildIngressGuestTunnelScript({ vmid: 4321, bindingTag: TAG, op: "disable" })],
    ["guest_enable", buildIngressGuestTunnelScript({ vmid: 4321, bindingTag: TAG, op: "enable" })],
  ];
}

describe("host ingress scripts", () => {
  it.each(allScripts())("%s is valid bash with no NUL byte and no secret", (_name, script) => {
    expect(script.includes(String.fromCharCode(0))).toBe(false);
    expect(script).not.toContain("TUNNEL_TOKEN=e");
    const check = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  it("times its steps on /proc/uptime, not the wall clock", () => {
    for (const [, script] of allScripts()) {
      expect(script).toContain("/proc/uptime");
      expect(script).not.toMatch(/date \+%s/);
    }
  });

  it("refuses bad inputs instead of building a script", () => {
    expect(() => buildIngressPreflightScript({ vmid: 4321, bindingTag: null })).toThrow();
    expect(() => buildIngressAttachScript({ vmid: 4321, bindingTag: TAG, hostname: "x y", guestIp: GUEST_IP, metricsPort: 21000 })).toThrow();
    expect(() => buildIngressAttachScript({ vmid: 4321, bindingTag: TAG, hostname: HOSTNAME, guestIp: "8.8.8.8", metricsPort: 21000 })).toThrow();
    expect(() => buildIngressAttachScript({ vmid: 4321, bindingTag: TAG, hostname: HOSTNAME, guestIp: GUEST_IP, metricsPort: 80 })).toThrow();
    expect(() => buildIngressDetachScript({ vmid: 12, hostname: HOSTNAME })).toThrow();
    expect(() => buildIngressGuestTunnelScript({ vmid: 4321, bindingTag: TAG, op: "start" as "enable" })).toThrow();
  });

  it("feeds the token to the guest only as stdin", () => {
    const enable = buildIngressGuestTunnelScript({ vmid: 4321, bindingTag: TAG, op: "enable" });
    expect(enable).toContain('run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c "$PROGRAM" enable < "$PAYLOAD"');
    const disable = buildIngressGuestTunnelScript({ vmid: 4321, bindingTag: TAG, op: "disable" });
    expect(disable).not.toContain("head -c");
  });

  it("parses the last well-formed step line only", () => {
    expect(parseIngressStep('x\nHIVRA_INGRESS_STEP {"step":"attach","ok":true,"ms":3}\n')).toEqual({ step: "attach", ok: true, ms: 3 });
    expect(parseIngressStep('HIVRA_INGRESS_STEP {"step":"attach","ok":false,"ms":3}\n')).toBeNull();
    expect(parseIngressStep('HIVRA_INGRESS_STEP {"step":"Bad","ok":true,"ms":3}\n')).toBeNull();
    expect(parseIngressStep("")).toBeNull();
  });
});

// The host boundaries (qm, systemctl, nft, ip, ss, the proxy CLI and its HTTP
// answers) are replaced; the scripts' own logic and files run for real.
function withHost<T>(run: (work: string, bin: string) => T): T {
  const work = mkdtempSync(path.join(tmpdir(), "hivra-ingress-"));
  try {
    const bin = path.join(work, "bin");
    mkdirSync(bin);
    mkdirSync(path.join(work, "state"));
    const stub = (name: string, body: string) => {
      writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "$FAKE_WORK/calls"\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    stub("qm", `case "$1" in
  config) printf 'tags: other;${TAG}\\nnet0: virtio=BC:24:11:AA:BB:CC,bridge=vmbr9,firewall=1\\n' ;;
  status) printf 'status: running\\nqmpstatus: running\\n' ;;
esac`);
    stub("systemctl", `case "$1" in
  enable|restart) touch "$FAKE_WORK/state/active" ;;
  disable) rm -f "$FAKE_WORK/state/active" ;;
  is-active) test -f "$FAKE_WORK/state/active" ;;
esac`);
    stub("nft", `if [ "$1" = list ]; then test -f "$FAKE_WORK/state/chain"; exit; fi
if [ "$1" = -f ] && [ "$2" != - ]; then cp "$2" "$FAKE_WORK/state/applied.nft"; touch "$FAKE_WORK/state/chain"; fi
if [ "$1" = -f ] && [ "$2" = - ]; then cat > /dev/null; rm -f "$FAKE_WORK/state/chain"; fi
exit 0`);
    stub("ip", "exit 0");
    stub("ss", "exit 0");
    stub("python3", `case "$*" in
  *"/ready"*) echo "\${FAKE_READY:-200}" ;;
  *http.client*) echo "\${FAKE_FRONT:-200}" ;;
  *) exec "${REAL_PY}" "$@" ;;
esac`);
    writeFileSync(path.join(work, "proxy.py"), `import json, os, sys
cmd = sys.argv[2] if len(sys.argv) > 2 else ""
print(json.dumps({"ok": True, "route": os.environ.get("FAKE_ROUTE", "1") == "1"}))
`);
    return run(work, bin);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function localize(script: string, work: string): string {
  return script
    .replaceAll("'/etc/hivra/ingress/routes'", `'${work}/etc/routes'`)
    .replaceAll("'/etc/hivra/ingress/pins'", `'${work}/etc/pins'`)
    .replaceAll("'/etc/hivra/ingress'", `'${work}/etc'`)
    .replaceAll("'/usr/local/lib/hivra-ingress/hivra-wake-proxy.py'", `'${work}/proxy.py'`)
    .replaceAll("/run/lock", `${work}/lock`)
    .replaceAll("/run/hivra-ingress-payload", `${work}/payload`);
}

function runScript(work: string, bin: string, script: string, stdin: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", localize(script, work)], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_WORK: work, ...env },
    timeout: 60_000,
  });
}

const attachScript = () => buildIngressAttachScript({ vmid: 4321, bindingTag: TAG, hostname: HOSTNAME, guestIp: GUEST_IP, metricsPort: 21000 });
const attachPayload = () => buildIngressAttachPayload({
  route: buildIngressRoute({ vmid: 4321, hostname: HOSTNAME, bindingTag: TAG, guestIp: GUEST_IP, ticketKey: "a".repeat(64), generation: 2 }),
  token: FAKE_RUN_DOC,
  metricsPort: 21000,
});

describe("attach and detach on a stub host", () => {
  it("writes the route (with the MAC from net0), the 0600 env file and the pin, then starts the connector", () => {
    withHost((work, bin) => {
      const run = runScript(work, bin, attachScript(), attachPayload());
      expect(parseIngressStep(run.stdout)).toMatchObject({ step: "attach", ok: true });
      const route = JSON.parse(readFileSync(path.join(work, "etc/routes/4321.json"), "utf8"));
      expect(route).toMatchObject({ vmid: 4321, hostname: HOSTNAME, guest_ip: GUEST_IP, guest_port: 18080, guest_mac: "bc:24:11:aa:bb:cc" });
      expect(readFileSync(path.join(work, "etc/4321.env"), "utf8")).toBe(`TUNNEL_TOKEN=${FAKE_RUN_DOC}\nTUNNEL_METRICS=127.0.0.1:21000\n`);
      const applied = readFileSync(path.join(work, "state/applied.nft"), "utf8");
      expect(applied).toContain('iifname { "tap4321i0", "fwpr4321p0" } ether saddr != bc:24:11:aa:bb:cc drop');
      // Tagged frames would slip past the ARP and IPv4 matches.
      expect(applied).toContain('iifname { "tap4321i0", "fwpr4321p0" } ether type { 8021q, 8021ad } drop');
      expect(applied).toContain('meta ibrname "vmbr9" iifname "tap*" ether type { 8021q, 8021ad } drop');
      expect(applied).toContain('meta ibrname "vmbr9" iifname "fwpr*" ether type { 8021q, 8021ad } drop');
      expect(applied.indexOf("8021q")).toBeLessThan(applied.indexOf("ether saddr !="));
      expect(applied).toContain(`meta ibrname "vmbr9" iifname != { "tap4321i0", "fwpr4321p0" } arp saddr ip ${GUEST_IP} drop`);
      const calls = readFileSync(path.join(work, "calls"), "utf8");
      expect(calls).toContain("systemctl enable --now hivra-cf@4321.service");
      expect(calls).toContain(`ip neigh replace ${GUEST_IP} lladdr bc:24:11:aa:bb:cc dev vmbr9 nud permanent`);
      // The token never reaches argv or the script's output.
      expect(calls).not.toContain(FAKE_RUN_DOC);
      expect(run.stdout).not.toContain(FAKE_RUN_DOC);
      expect(existsSync(path.join(work, "payload"))).toBe(false);
    });
  });

  it("removes everything it made when the proxy refuses the route", () => {
    withHost((work, bin) => {
      const run = runScript(work, bin, attachScript(), attachPayload(), { FAKE_ROUTE: "0" });
      expect(parseIngressStep(run.stdout)).toMatchObject({ step: "route", ok: false, reason: "route_rejected" });
      expect(existsSync(path.join(work, "etc/routes/4321.json"))).toBe(false);
      expect(existsSync(path.join(work, "etc/4321.env"))).toBe(false);
      expect(existsSync(path.join(work, "etc/pins/4321.nft"))).toBe(false);
      expect(existsSync(path.join(work, "state/chain"))).toBe(false);
      expect(existsSync(path.join(work, "state/active"))).toBe(false);
    });
  });

  it("refuses a payload that does not match the script", () => {
    withHost((work, bin) => {
      const other = buildIngressAttachPayload({
        route: buildIngressRoute({ vmid: 4321, hostname: "other.example.test", bindingTag: TAG, guestIp: GUEST_IP, ticketKey: "a".repeat(64), generation: 2 }),
        token: FAKE_RUN_DOC,
        metricsPort: 21000,
      });
      const run = runScript(work, bin, attachScript(), other);
      expect(parseIngressStep(run.stdout)).toMatchObject({ ok: false, reason: "payload_mismatch" });
      expect(existsSync(path.join(work, "etc/4321.env"))).toBe(false);
    });
  });

  it("detach removes the host side, is idempotent and leaves another hostname's route alone", () => {
    withHost((work, bin) => {
      runScript(work, bin, attachScript(), attachPayload());
      const wrong = runScript(work, bin, buildIngressDetachScript({ vmid: 4321, hostname: "other.example.test" }), "");
      expect(parseIngressStep(wrong.stdout)).toMatchObject({ ok: false, reason: "hostname_mismatch" });
      expect(existsSync(path.join(work, "etc/routes/4321.json"))).toBe(true);

      const first = runScript(work, bin, buildIngressDetachScript({ vmid: 4321, hostname: HOSTNAME }), "");
      expect(parseIngressStep(first.stdout)).toMatchObject({ step: "detach", ok: true });
      expect(existsSync(path.join(work, "etc/routes/4321.json"))).toBe(false);
      expect(existsSync(path.join(work, "etc/4321.env"))).toBe(false);
      expect(existsSync(path.join(work, "state/active"))).toBe(false);
      expect(existsSync(path.join(work, "state/chain"))).toBe(false);

      const second = runScript(work, bin, buildIngressDetachScript({ vmid: 4321, hostname: HOSTNAME }), "");
      expect(parseIngressStep(second.stdout)).toMatchObject({ step: "detach_absent", ok: true });
    });
  });

  it("status reports what is there", () => {
    withHost((work, bin) => {
      runScript(work, bin, attachScript(), attachPayload());
      const run = runScript(work, bin, buildIngressStatusScript({ vmid: 4321, metricsPort: 21000 }), "");
      expect(parseIngressStep(run.stdout)).toMatchObject({ step: "status", ok: true, route: true, env: true, connector: true, ready: true, pin: true, proxy_route: true });
    });
  });
});

describe("guest tunnel program", () => {
  function runGuest(op: string, stdin: string, unitPresent = true) {
    const work = mkdtempSync(path.join(tmpdir(), "hivra-ingress-guest-"));
    try {
      const bin = path.join(work, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "systemctl"), `#!/usr/bin/env bash\necho "$*" >> "${work}/calls"\ncase "$1" in is-active) test -f "${work}/active" ;; restart) touch "${work}/active" ;; disable) rm -f "${work}/active" ;; esac\n`);
      chmodSync(path.join(bin, "systemctl"), 0o755);
      if (unitPresent) writeFileSync(path.join(work, "unit"), "[Unit]\n");
      writeFileSync(path.join(work, "token.env"), "TUNNEL_TOKEN=old\n");
      writeFileSync(path.join(work, "active"), "");
      const program = GUEST_TUNNEL_PROGRAM
        .replace('"/etc/hivra-cf-token.env"', JSON.stringify(path.join(work, "token.env")))
        .replace('"/etc/systemd/system/hivra-cf-tunnel.service"', JSON.stringify(path.join(work, "unit")));
      const run = spawnSync(REAL_PY, ["-I", "-B", "-c", program, op], {
        input: stdin, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      const token = existsSync(path.join(work, "token.env")) ? readFileSync(path.join(work, "token.env"), "utf8") : null;
      const calls = existsSync(path.join(work, "calls")) ? readFileSync(path.join(work, "calls"), "utf8") : "";
      return { step: parseIngressStep(run.stdout), token, calls, active: existsSync(path.join(work, "active")), stdout: run.stdout };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  it("disable stops the connector and deletes its token file", () => {
    const result = runGuest("disable", "");
    expect(result.step).toMatchObject({ step: "guest_disable", ok: true, removed: true });
    expect(result.token).toBeNull();
    expect(result.active).toBe(false);
    expect(result.calls).toContain("disable --now hivra-cf-tunnel.service");
  });

  it("enable writes the token from stdin and restarts the connector, without echoing it", () => {
    const result = runGuest("enable", JSON.stringify({ token: FAKE_RUN_DOC }));
    expect(result.step).toMatchObject({ step: "guest_enable", ok: true });
    expect(result.token).toBe(`TUNNEL_TOKEN=${FAKE_RUN_DOC}\n`);
    expect(result.calls).toContain("restart hivra-cf-tunnel.service");
    expect(result.stdout).not.toContain(FAKE_RUN_DOC);
  });

  it("enable refuses a bad payload and a missing unit", () => {
    expect(runGuest("enable", "{}").step).toMatchObject({ ok: false, reason: "payload_invalid" });
    expect(runGuest("enable", JSON.stringify({ token: FAKE_RUN_DOC }), false).step).toMatchObject({ ok: false, reason: "unit_missing" });
  });
});
