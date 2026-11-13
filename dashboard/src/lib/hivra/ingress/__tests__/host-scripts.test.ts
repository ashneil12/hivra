import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertHostCloudflaredRelease,
  buildHostCredentialRemoveScript,
  buildHostWakeProxyInstallScript,
  buildHostWakeProxyRemoveScript,
  buildHostWakeProxyStatusScript,
  HOST_WAKE_PROXY_BUNDLE_FILES,
  HOST_WAKE_PROXY_PLACEMENTS,
  parseHostWakeProxyResult,
  parseHostWakeProxyStatus,
  type HostCloudflaredRelease,
  type HostWakeProxyBundlePath,
} from "../host-scripts";
import { HIVRA_HOST_CLOUDFLARED_RELEASE } from "@/lib/infrastructure/portable-provisioner-contract";

const TARGET = "fixturenode";
const VERSION = "2026.11.13.1";
const CF_BYTES = "fixture cloudflared binary\n";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const FIXTURE_CF: HostCloudflaredRelease = {
  version: "2026.8.2",
  url: "https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-linux-amd64",
  sha256: sha(CF_BYTES),
};

const FILE_CONTENT: Record<HostWakeProxyBundlePath, string> = {
  "hivra-wake-proxy.py": "print('wake proxy fixture')\n",
  "hivra-wake-helper.service": "[Unit]\nDescription=helper fixture\n",
  "hivra-wake-proxy.service": "[Unit]\nDescription=proxy fixture\n",
  "hivra-cf-template.service": "[Unit]\nDescription=connector fixture\n",
  "hivra-ingress.tmpfiles.conf": "d /run/hivra-ingress 0750 root hivra-ingress -\n",
};
const DIGESTS = Object.fromEntries(
  HOST_WAKE_PROXY_BUNDLE_FILES.map((name) => [name, sha(FILE_CONTENT[name])]),
) as Record<HostWakeProxyBundlePath, string>;

function installScript(extra: { forceHealthFailure?: boolean; cloudflared?: HostCloudflaredRelease; healthDeadlineSeconds?: number; hostCredential?: boolean } = {}) {
  return buildHostWakeProxyInstallScript({
    targetId: TARGET,
    channel: "default",
    bundleVersion: VERSION,
    fileDigests: DIGESTS,
    cloudflared: extra.cloudflared ?? FIXTURE_CF,
    forceHealthFailure: extra.forceHealthFailure,
    healthDeadlineSeconds: extra.healthDeadlineSeconds,
    ...(extra.hostCredential ? { hostCredential: true } : {}),
  });
}

// A neutral credential document for a fixture host; the material is made per run.
function credentialDoc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    host_id: TARGET,
    generation: 3,
    credential: sha(`fixture material ${Math.random()}`),
    origin: "https://app.example.test",
    ...overrides,
  };
}

describe("host wake proxy scripts (pure)", () => {
  it("pins the cloudflared release the guests run, with a verified digest", () => {
    expect(HIVRA_HOST_CLOUDFLARED_RELEASE.version).toBe("2026.8.2");
    expect(() => assertHostCloudflaredRelease(HIVRA_HOST_CLOUDFLARED_RELEASE)).not.toThrow();
    expect(installScript({ cloudflared: HIVRA_HOST_CLOUDFLARED_RELEASE })).toContain(HIVRA_HOST_CLOUDFLARED_RELEASE.sha256);
  });

  it("blocks install on a missing or placeholder cloudflared digest or a foreign URL", () => {
    expect(() => installScript({ cloudflared: { ...FIXTURE_CF, sha256: "REPLACE_ME" } })).toThrow(/sha256/);
    expect(() => installScript({ cloudflared: { ...FIXTURE_CF, sha256: "" } })).toThrow(/sha256/);
    expect(() =>
      installScript({ cloudflared: { ...FIXTURE_CF, url: "https://example.invalid/cloudflared-linux-amd64" } }),
    ).toThrow(/official/);
    expect(() =>
      installScript({
        cloudflared: { ...FIXTURE_CF, url: FIXTURE_CF.url.replace("2026.8.2", "2026.8.1") },
      }),
    ).toThrow(/official/);
  });

  it("refuses a missing reviewed digest, an unsafe target or an inexact version", () => {
    const partial = { ...DIGESTS } as Partial<Record<HostWakeProxyBundlePath, string>>;
    delete partial["hivra-wake-proxy.py"];
    expect(() =>
      buildHostWakeProxyInstallScript({
        targetId: TARGET,
        channel: "default",
        bundleVersion: VERSION,
        fileDigests: partial as Record<HostWakeProxyBundlePath, string>,
        cloudflared: FIXTURE_CF,
      }),
    ).toThrow(/hivra-wake-proxy\.py/);
    expect(() => buildHostWakeProxyStatusScript("Bad Host")).toThrow();
    expect(() => buildHostWakeProxyRemoveScript("a;b")).toThrow();
    expect(() =>
      buildHostWakeProxyInstallScript({ targetId: TARGET, channel: "default", bundleVersion: "latest", fileDigests: DIGESTS }),
    ).toThrow();
  });

  it("produces bash that parses, with no NUL bytes and no wall-clock timing", () => {
    for (const script of [installScript(), buildHostWakeProxyStatusScript(TARGET), buildHostWakeProxyRemoveScript(TARGET)]) {
      expect(script.includes("\u0000")).toBe(false);
      expect(script).not.toMatch(/date \+%s/);
      expect(script).toContain("/proc/uptime");
      execFileSync("bash", ["-n"], { input: script });
    }
  });

  it("reads the channel's own bundle directory", () => {
    expect(installScript()).toContain("BUNDLE='/root/hivra-provisioner'");
    expect(
      buildHostWakeProxyInstallScript({ targetId: TARGET, channel: "canary", bundleVersion: VERSION, fileDigests: DIGESTS, cloudflared: FIXTURE_CF }),
    ).toContain("BUNDLE='/root/hivra-provisioner-canary'");
  });

  it("adds the credential step only when asked, reading the document from stdin", () => {
    const plain = installScript();
    const withCredential = installScript({ hostCredential: true });
    for (const marker of ["CRED_", "host-credential", "head -c"]) expect(plain).not.toContain(marker);
    expect(withCredential).toContain('CRED_IN="$(head -c 4097)"');
    expect(withCredential).toContain("'/etc/hivra/ingress/host-credential.json'");
    expect(withCredential).not.toContain("\0");
    expect(() => execFileSync("bash", ["-n"], { input: withCredential })).not.toThrow();
    // It is written only after the proxy proved healthy.
    expect(withCredential.indexOf("CRED_STATE=written")).toBeGreaterThan(withCredential.indexOf("until health_ok; do"));
    expect(withCredential.indexOf("CRED_STATE=written")).toBeLessThan(withCredential.indexOf("COMMITTED=1"));
  });

  it("matches the reviewed snapshots", () => {
    expect(installScript()).toMatchSnapshot("install");
    expect(installScript({ hostCredential: true })).toMatchSnapshot("install-with-credential");
    expect(buildHostCredentialRemoveScript(TARGET)).toMatchSnapshot("credential-remove");
    expect(buildHostWakeProxyStatusScript(TARGET, FIXTURE_CF)).toMatchSnapshot("status");
    expect(buildHostWakeProxyRemoveScript(TARGET)).toMatchSnapshot("remove");
  });

  it("parses result and status markers", () => {
    expect(parseHostWakeProxyResult("noise\nHIVRA_WAKE_PROXY_RESULT status=installed step=health changed=1 cloudflared=2026.8.2 ms=812\n")).toEqual({
      status: "installed", step: "health", changed: true, ms: 812,
    });
    expect(parseHostWakeProxyResult("HIVRA_WAKE_PROXY_RESULT status=refused step=dependents changed=0 ms=3\n")?.status).toBe("refused");
    expect(parseHostWakeProxyResult("HIVRA_WAKE_PROXY_RESULT status=unchanged step=credential changed=0 cloudflared=2026.8.2 credential=written ms=40\n")).toEqual({
      status: "unchanged", step: "credential", changed: false, ms: 40, credential: "written",
    });
    expect(parseHostWakeProxyResult("HIVRA_WAKE_PROXY_RESULT status=bogus step=x changed=0 ms=1\n")).toBeNull();
    expect(parseHostWakeProxyResult("")).toBeNull();
    expect(
      parseHostWakeProxyStatus(
        "HIVRA_WAKE_PROXY_STATUS installed=1 version=2026.11.13.1 helper=active proxy=active cloudflared=ok routes=2 connectors=1 health=1 front_door=503\n",
      ),
    ).toEqual({
      installed: true, version: "2026.11.13.1", helper: "active", proxy: "active", cloudflared: "ok",
      routes: 2, connectors: 1, healthy: true, frontDoor: 503,
    });
    expect(parseHostWakeProxyStatus("HIVRA_WAKE_PROXY_STATUS installed=0\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Running the scripts against a fake host: every absolute host path is moved
// under a temporary root, and systemctl, curl, useradd and friends are stubs
// that record what they were asked to do.

const STUBS: Record<string, string> = {
  hostname: 'echo fixturenode',
  uname: 'echo x86_64',
  flock: 'exit 0',
  ss: 'exit 0',
  "systemd-tmpfiles": 'exit 0',
  getent: '[ -f "$FAKE_STATE/user" ]',
  useradd: 'touch "$FAKE_STATE/user"; echo useradd >> "$FAKE_STATE/calls.log"',
  userdel: 'rm -f "$FAKE_STATE/user"; echo userdel >> "$FAKE_STATE/calls.log"',
  curl: [
    'echo curl >> "$FAKE_STATE/calls.log"',
    'out=""',
    'while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; shift; fi; shift; done',
    'cp "$FAKE_CF_SOURCE" "$out"',
  ].join("\n"),
  install: [
    'args=()',
    'while [ $# -gt 0 ]; do case "$1" in -o|-g) shift;; *) args+=("$1");; esac; shift; done',
    'exec "$REAL_INSTALL" "${args[@]}"',
  ].join("\n"),
  python3: [
    'case "$*" in',
    '  *"ctl health"*) echo \'{"forwarder":true,"ok":true}\'; exit 0;;',
    '  *http.client*) echo "${FAKE_FRONT_DOOR:-503}"; exit 0;;',
    'esac',
    'exec "$REAL_PYTHON" "$@"',
  ].join("\n"),
  systemctl: [
    'S="$FAKE_STATE"',
    'echo "$*" >> "$S/systemctl.log"',
    'quiet=0; now=0; args=()',
    'for a in "$@"; do case "$a" in --quiet) quiet=1;; --now) now=1;; --*) ;; *) args+=("$a");; esac; done',
    'cmd="${args[0]}"; units=("${args[@]:1}")',
    'case "$cmd" in',
    '  is-active) if [ -f "$S/active.${units[0]}" ]; then [ $quiet = 1 ] || echo active; exit 0; fi; [ $quiet = 1 ] || echo inactive; exit 3;;',
    '  is-enabled) [ -f "$S/enabled.${units[0]}" ]; exit $?;;',
    '  start|restart) for u in "${units[@]}"; do touch "$S/active.$u"; done;;',
    '  stop) for u in "${units[@]}"; do rm -f "$S/active.$u"; done;;',
    '  enable) for u in "${units[@]}"; do touch "$S/enabled.$u"; [ $now = 0 ] || touch "$S/active.$u"; done;;',
    '  disable) for u in "${units[@]}"; do rm -f "$S/enabled.$u"; [ $now = 0 ] || rm -f "$S/active.$u"; done;;',
    'esac',
    'exit 0',
  ].join("\n"),
};

type FakeHost = {
  root: string;
  state: string;
  /** With stdin, the script runs as `bash -c` and reads stdin itself, as runProxmoxHostScriptWithStdin does. */
  run: (script: string, env?: Record<string, string>, stdin?: string) => { status: number | null; stdout: string; stderr: string };
  file: (hostPath: string) => string;
  exists: (hostPath: string) => boolean;
  writeHostFile: (hostPath: string, content: string) => void;
};

const REAL_PYTHON = execFileSync("bash", ["-c", "command -v python3"]).toString().trim();
const REAL_INSTALL = execFileSync("bash", ["-c", "command -v install"]).toString().trim();

function relocate(script: string, root: string): string {
  return script
    .replace(/(['"\s=(])\/(usr\/local|etc|run|root)\//g, (_match, lead: string, top: string) => `${lead}${root}/${top}/`)
    .replace(/(['"\s=(])\/(usr\/local|etc|run|root)\//g, (_match, lead: string, top: string) => `${lead}${root}/${top}/`);
}

function fakeHost(): FakeHost {
  const root = mkdtempSync(path.join(tmpdir(), "hivra-wake-proxy-host-"));
  const state = path.join(root, "fake-state");
  const bin = path.join(root, "fake-bin");
  for (const dir of ["usr/local/lib", "usr/local/bin", "etc/systemd/system", "etc/tmpfiles.d", "run/lock", "root/hivra-provisioner", "fake-state", "fake-bin"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const [name, body] of Object.entries(STUBS)) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  }
  const bundle = path.join(root, "root/hivra-provisioner");
  writeFileSync(path.join(bundle, "VERSION"), `${VERSION}\n`);
  const manifest = ["VERSION", ...HOST_WAKE_PROXY_BUNDLE_FILES]
    .map((name) => {
      const content = name === "VERSION" ? `${VERSION}\n` : FILE_CONTENT[name as HostWakeProxyBundlePath];
      if (name !== "VERSION") writeFileSync(path.join(bundle, name), content);
      return `${sha(content)}  ${name}`;
    })
    .join("\n");
  writeFileSync(path.join(bundle, "BUNDLE.sha256"), `${manifest}\n`);
  writeFileSync(path.join(state, "cf-good"), CF_BYTES);
  const at = (hostPath: string) => path.join(root, hostPath);
  return {
    root,
    state,
    run: (script, env = {}, stdin) => {
      const relocated = relocate(script, root);
      const result = spawnSync("bash", stdin === undefined ? ["-s"] : ["-c", relocated], {
        input: stdin === undefined ? relocated : stdin,
        env: {
          PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          FAKE_STATE: state,
          FAKE_CF_SOURCE: path.join(state, "cf-good"),
          REAL_PYTHON,
          REAL_INSTALL,
          ...env,
        } as unknown as NodeJS.ProcessEnv,
        timeout: 60_000,
      });
      return { status: result.status, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    },
    file: (hostPath) => readFileSync(at(hostPath), "utf8"),
    exists: (hostPath) => existsSync(at(hostPath)),
    writeHostFile: (hostPath, content) => {
      mkdirSync(path.dirname(at(hostPath)), { recursive: true });
      writeFileSync(at(hostPath), content);
    },
  };
}

const UNIT_DEST = "/etc/systemd/system/hivra-wake-proxy.service";

describe("host wake proxy scripts (on a fake host)", () => {
  const hosts: FakeHost[] = [];
  const newHost = () => {
    const host = fakeHost();
    hosts.push(host);
    return host;
  };
  afterAll(() => {
    for (const host of hosts) rmSync(host.root, { recursive: true, force: true });
  });

  it("installs everything on a fresh host, then converges without restarting", () => {
    const host = newHost();
    const first = host.run(installScript());
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(parseHostWakeProxyResult(first.stdout)).toMatchObject({ status: "installed", changed: true });
    for (const entry of HOST_WAKE_PROXY_PLACEMENTS) {
      expect(host.file(entry.dest)).toBe(FILE_CONTENT[entry.bundlePath]);
    }
    expect(host.file("/usr/local/bin/hivra-cloudflared")).toBe(CF_BYTES);
    expect(statSync(path.join(host.root, "usr/local/bin/hivra-cloudflared")).mode & 0o777).toBe(0o755);
    expect(host.file("/usr/local/lib/hivra-ingress/SOURCE")).toBe(`channel=default version=${VERSION} cloudflared=2026.8.2\n`);
    expect(existsSync(path.join(host.state, "active.hivra-wake-proxy.service"))).toBe(true);
    expect(existsSync(path.join(host.state, "enabled.hivra-wake-helper.service"))).toBe(true);

    const log = path.join(host.state, "systemctl.log");
    writeFileSync(log, "");
    writeFileSync(path.join(host.state, "calls.log"), "");
    const second = host.run(installScript());
    expect(second.status).toBe(0);
    expect(parseHostWakeProxyResult(second.stdout)).toMatchObject({ status: "unchanged", changed: false });
    expect(readFileSync(log, "utf8")).not.toMatch(/^(start|restart|daemon-reload|enable) /m);
    expect(readFileSync(path.join(host.state, "calls.log"), "utf8")).not.toContain("curl");

    const status = host.run(buildHostWakeProxyStatusScript(TARGET, FIXTURE_CF));
    expect(status.status).toBe(0);
    expect(parseHostWakeProxyStatus(status.stdout)).toMatchObject({
      installed: true, version: VERSION, helper: "active", proxy: "active", cloudflared: "ok", routes: 0, healthy: true, frontDoor: 503,
    });
  });

  it("aborts before touching anything when the cloudflared download does not match its pin", () => {
    const host = newHost();
    writeFileSync(path.join(host.state, "cf-bad"), "tampered\n");
    const run = host.run(installScript(), { FAKE_CF_SOURCE: path.join(host.state, "cf-bad") });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("does not match the pinned sha256");
    expect(parseHostWakeProxyResult(run.stdout)).toMatchObject({ status: "failed", step: "cloudflared", changed: false });
    expect(host.exists("/usr/local/bin/hivra-cloudflared")).toBe(false);
    expect(host.exists(UNIT_DEST)).toBe(false);
    expect(existsSync(path.join(host.state, "user"))).toBe(false);
    expect(existsSync(path.join(host.state, "systemctl.log")) ? readFileSync(path.join(host.state, "systemctl.log"), "utf8") : "").not.toMatch(/^(start|restart|enable) /m);
  });

  it("aborts when a bundle file is not the reviewed one", () => {
    const host = newHost();
    host.writeHostFile("/root/hivra-provisioner/hivra-wake-proxy.service", "[Unit]\nDescription=edited\n");
    const run = host.run(installScript());
    expect(run.status).not.toBe(0);
    expect(parseHostWakeProxyResult(run.stdout)).toMatchObject({ status: "failed", step: "bundle" });
    expect(host.exists(UNIT_DEST)).toBe(false);
  });

  it("restores the previous units and service state when the health check fails after an upgrade", () => {
    const host = newHost();
    expect(host.run(installScript()).status).toBe(0);
    const previous = "[Unit]\nDescription=previous proxy\n";
    host.writeHostFile(UNIT_DEST, previous);
    const log = path.join(host.state, "systemctl.log");
    writeFileSync(log, "");
    const run = host.run(installScript({ healthDeadlineSeconds: 1 }), { FAKE_FRONT_DOOR: "200" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("health check failed");
    expect(parseHostWakeProxyResult(run.stdout)).toMatchObject({ status: "rolled_back", step: "health", changed: true });
    expect(host.file(UNIT_DEST)).toBe(previous);
    expect(host.exists(`${UNIT_DEST}.hivra-new`)).toBe(false);
    // It was running before, so it runs again on its previous files.
    expect(existsSync(path.join(host.state, "active.hivra-wake-proxy.service"))).toBe(true);
    expect(existsSync(path.join(host.state, "enabled.hivra-wake-proxy.service"))).toBe(true);
    const calls = readFileSync(log, "utf8");
    expect(calls.lastIndexOf("daemon-reload")).toBeLessThan(calls.lastIndexOf("restart hivra-wake-proxy.service"));
    expect(readdirStage(host)).toEqual([]);
  });

  it("leaves a fresh host as it was when a forced health failure rolls back the first install", () => {
    const host = newHost();
    const run = host.run(installScript({ forceHealthFailure: true }));
    expect(run.status).not.toBe(0);
    expect(parseHostWakeProxyResult(run.stdout)).toMatchObject({ status: "rolled_back", step: "health" });
    for (const entry of HOST_WAKE_PROXY_PLACEMENTS) expect(host.exists(entry.dest)).toBe(false);
    expect(host.exists("/usr/local/bin/hivra-cloudflared")).toBe(false);
    expect(host.exists("/usr/local/lib/hivra-ingress")).toBe(false);
    expect(existsSync(path.join(host.state, "user"))).toBe(false);
    expect(existsSync(path.join(host.state, "active.hivra-wake-proxy.service"))).toBe(false);
    expect(existsSync(path.join(host.state, "enabled.hivra-wake-helper.service"))).toBe(false);
  });

  it("writes the host credential from stdin, root only, once the proxy is healthy, and converges", () => {
    const host = newHost();
    const doc = credentialDoc();
    const stdin = `${JSON.stringify(doc)}\n`;
    const first = host.run(installScript({ hostCredential: true }), {}, stdin);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(parseHostWakeProxyResult(first.stdout)).toMatchObject({ status: "installed", credential: "written" });
    const dest = "/etc/hivra/ingress/host-credential.json";
    expect(JSON.parse(host.file(dest))).toEqual(doc);
    expect(statSync(path.join(host.root, dest.slice(1))).mode & 0o777).toBe(0o600);
    // The credential is never echoed.
    expect(first.stdout + first.stderr).not.toContain(doc.credential);

    const again = host.run(installScript({ hostCredential: true }), {}, stdin);
    expect(parseHostWakeProxyResult(again.stdout)).toMatchObject({ status: "unchanged", changed: false, credential: "unchanged" });

    // A new generation replaces the file without restarting anything.
    const log = path.join(host.state, "systemctl.log");
    writeFileSync(log, "");
    const rotated = credentialDoc({ generation: 4 });
    const third = host.run(installScript({ hostCredential: true }), {}, `${JSON.stringify(rotated)}\n`);
    expect(parseHostWakeProxyResult(third.stdout)).toMatchObject({ status: "unchanged", credential: "written" });
    expect(JSON.parse(host.file(dest))).toEqual(rotated);
    expect(readFileSync(log, "utf8")).not.toMatch(/^(restart|start|daemon-reload) /m);

    const removed = host.run(buildHostCredentialRemoveScript(TARGET));
    expect(parseHostWakeProxyResult(removed.stdout)).toMatchObject({ status: "removed", changed: true });
    expect(host.exists(dest)).toBe(false);
    expect(parseHostWakeProxyResult(host.run(buildHostCredentialRemoveScript(TARGET)).stdout)?.status).toBe("absent");
  });

  it("refuses a credential document for another host, or a malformed one, before changing anything", () => {
    for (const stdin of [
      JSON.stringify(credentialDoc({ host_id: "otherhost" })),
      JSON.stringify(credentialDoc({ origin: "http://app.example.test" })),
      JSON.stringify({ ...credentialDoc(), extra: true }),
      JSON.stringify(credentialDoc({ credential: "short" })),
      "not json",
      "",
      "x".repeat(5000),
    ]) {
      const host = newHost();
      const run = host.run(installScript({ hostCredential: true }), {}, stdin);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("host credential document is invalid");
      expect(parseHostWakeProxyResult(run.stdout)).toMatchObject({ status: "failed", step: "credential", changed: false, credential: "none" });
      expect(host.exists(UNIT_DEST)).toBe(false);
      expect(host.exists("/etc/hivra/ingress/host-credential.json")).toBe(false);
    }
  });

  it("puts the previous credential back when the install rolls back", () => {
    const host = newHost();
    const first = credentialDoc();
    expect(host.run(installScript({ hostCredential: true }), {}, JSON.stringify(first)).status).toBe(0);
    const run = host.run(installScript({ hostCredential: true, forceHealthFailure: true }), {}, JSON.stringify(credentialDoc({ generation: 9 })));
    expect(parseHostWakeProxyResult(run.stdout)).toMatchObject({ status: "rolled_back", step: "health" });
    expect(JSON.parse(host.file("/etc/hivra/ingress/host-credential.json"))).toEqual(first);
  });

  it("refuses to remove while a computer has a route, and removes cleanly otherwise", () => {
    const host = newHost();
    expect(host.run(installScript()).status).toBe(0);
    host.writeHostFile("/etc/hivra/ingress/routes/101.json", "{}\n");
    const refused = host.run(buildHostWakeProxyRemoveScript(TARGET));
    expect(refused.status).not.toBe(0);
    expect(parseHostWakeProxyResult(refused.stdout)).toMatchObject({ status: "refused", step: "dependents" });
    expect(host.exists(UNIT_DEST)).toBe(true);

    rmSync(path.join(host.root, "etc/hivra/ingress/routes/101.json"));
    const removed = host.run(buildHostWakeProxyRemoveScript(TARGET));
    expect(removed.status).toBe(0);
    expect(parseHostWakeProxyResult(removed.stdout)).toMatchObject({ status: "removed", changed: true });
    for (const entry of HOST_WAKE_PROXY_PLACEMENTS) expect(host.exists(entry.dest)).toBe(false);
    expect(host.exists("/usr/local/bin/hivra-cloudflared")).toBe(false);
    expect(existsSync(path.join(host.state, "user"))).toBe(false);
    expect(parseHostWakeProxyResult(host.run(buildHostWakeProxyRemoveScript(TARGET)).stdout)?.status).toBe("absent");
  });
});

function readdirStage(host: FakeHost): string[] {
  return readdirSync(path.join(host.root, "root")).filter((name) => name.startsWith(".hivra-wake-proxy-install."));
}
