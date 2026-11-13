import { createHash } from "node:crypto";

import { HOST_WAKE_PROXY_BUNDLE_FILES } from "../host-scripts";
import { reviewedWakeProxyDigests, runHostWakeProxyAction } from "../host-wake-proxy";
import { loadPortableProvisionerBundle } from "@/lib/infrastructure/connection-preparation";

const TARGET = "fixturenode";
const BASE_ENV = {
  PROXMOX_FIXTURENODE_SSH_HOST: "fixture.invalid",
  PROXMOX_FIXTURENODE_SSH_USER: "root",
} as unknown as NodeJS.ProcessEnv;
const ALL_ON = {
  ...BASE_ENV,
  HIVRA_HOST_WAKE_PROXY_ENABLED: "true",
  HIVRA_HOST_INGRESS: "canary",
} as NodeJS.ProcessEnv;

const fakeAssets = HOST_WAKE_PROXY_BUNDLE_FILES.map((name) => ({
  relativePath: name,
  content: Buffer.from(`fixture ${name}\n`),
}));

function deps(overrides: Record<string, unknown> = {}) {
  return {
    loadBundle: jest.fn(async () => fakeAssets),
    runHostScript: jest.fn(async () => ({
      ok: true,
      stdout: "HIVRA_WAKE_PROXY_RESULT status=installed step=health changed=1 cloudflared=2026.8.2 ms=900\n",
      stderr: "",
    })),
    loadHostRow: jest.fn(async () => ({ ingress_mode: "canary" })),
    env: ALL_ON,
    ...overrides,
  } as unknown as Parameters<typeof runHostWakeProxyAction>[1];
}

describe("runHostWakeProxyAction", () => {
  it("installs only with the install flag, both ingress switches and a configured target", async () => {
    const cases: Array<[NodeJS.ProcessEnv, string | null, RegExp]> = [
      [BASE_ENV, "canary", /HIVRA_HOST_WAKE_PROXY_ENABLED/],
      [{ ...BASE_ENV, HIVRA_HOST_WAKE_PROXY_ENABLED: "true" }, "canary", /Host ingress is off/],
      [ALL_ON, "off", /Host ingress is off/],
      [ALL_ON, null, /Host ingress is off/],
    ];
    for (const [env, mode, error] of cases) {
      const d = deps({ env, loadHostRow: jest.fn(async () => (mode === null ? null : { ingress_mode: mode })) });
      const result = await runHostWakeProxyAction({ action: "install-wake-proxy", channel: "default", targetId: TARGET }, d);
      expect(result).toMatchObject({ ok: false, httpStatus: 409 });
      expect(result.error).toMatch(error);
      expect(d!.runHostScript).not.toHaveBeenCalled();
    }
    const unknown = deps();
    expect(
      await runHostWakeProxyAction({ action: "install-wake-proxy", channel: "default", targetId: "elsewhere" }, unknown),
    ).toMatchObject({ ok: false, httpStatus: 400 });
    expect(unknown!.runHostScript).not.toHaveBeenCalled();
  });

  it("runs the install script with the reviewed digests and reports the result", async () => {
    const d = deps();
    const result = await runHostWakeProxyAction(
      { action: "install-wake-proxy", channel: "canary", targetId: TARGET, forceHealthFailure: true },
      d,
    );
    expect(result).toMatchObject({ ok: true, result: { status: "installed", changed: true } });
    const script = (d!.runHostScript as jest.Mock).mock.calls[0][0] as string;
    for (const asset of fakeAssets) {
      expect(script).toContain(createHash("sha256").update(asset.content).digest("hex"));
    }
    expect(script).toContain("FORCE_HEALTH_FAILURE=1");
    expect(script).toContain("BUNDLE='/root/hivra-provisioner-canary'");
  });

  it("reports a rollback as a failure and a refused removal as a conflict", async () => {
    const rolled = deps({
      runHostScript: jest.fn(async () => ({
        ok: false,
        stdout: "HIVRA_WAKE_PROXY_RESULT status=rolled_back step=health changed=1 cloudflared=2026.8.2 ms=31000\n",
        stderr: "wake proxy health check failed\n",
      })),
    });
    expect(await runHostWakeProxyAction({ action: "install-wake-proxy", channel: "default", targetId: TARGET }, rolled)).toMatchObject({
      ok: false, httpStatus: 503, result: { status: "rolled_back" },
    });
    const refused = deps({
      env: BASE_ENV,
      runHostScript: jest.fn(async () => ({
        ok: false,
        stdout: "HIVRA_WAKE_PROXY_RESULT status=refused step=dependents changed=0 ms=4\n",
        stderr: "",
      })),
    });
    expect(await runHostWakeProxyAction({ action: "remove-wake-proxy", channel: "default", targetId: TARGET }, refused)).toMatchObject({
      ok: false, httpStatus: 409,
    });
  });

  it("reads status without any flag", async () => {
    const d = deps({
      env: BASE_ENV,
      runHostScript: jest.fn(async () => ({
        ok: true,
        stdout: "HIVRA_WAKE_PROXY_STATUS installed=0 version=none helper=inactive proxy=inactive cloudflared=missing routes=0 connectors=0 health=0 front_door=0\n",
        stderr: "",
      })),
    });
    const result = await runHostWakeProxyAction({ action: "wake-proxy-status", channel: "default", targetId: TARGET }, d);
    expect(result).toMatchObject({ ok: true, status: { installed: false, version: null, cloudflared: "missing" } });
    expect(d!.loadHostRow).not.toHaveBeenCalled();
  });

  it("with HIVRA_INGRESS_HOST_CREDENTIAL, sends the credential document on stdin and never in the script", async () => {
    const document = {
      version: 1 as const, host_id: TARGET, generation: 2,
      credential: createHash("sha256").update("fixture material").digest("hex"), origin: "https://app.example.test",
    };
    const runHostScriptWithStdin = jest.fn(async () => ({
      ok: true,
      stdout: "HIVRA_WAKE_PROXY_RESULT status=unchanged step=credential changed=0 cloudflared=2026.8.2 credential=written ms=500\n",
      stderr: "",
    }));
    const issueCredential = jest.fn(async () => ({ ok: true as const, document }));
    const d = deps({ env: { ...ALL_ON, HIVRA_INGRESS_HOST_CREDENTIAL: "true" }, runHostScriptWithStdin, issueCredential });
    const result = await runHostWakeProxyAction({ action: "install-wake-proxy", channel: "default", targetId: TARGET }, d);
    expect(result).toMatchObject({ ok: true, result: { status: "unchanged", credential: "written" } });
    expect(issueCredential).toHaveBeenCalledWith(TARGET, expect.anything());
    expect(d!.runHostScript).not.toHaveBeenCalled();
    const [script, stdin] = runHostScriptWithStdin.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(stdin)).toEqual(document);
    expect(script).toContain('CRED_IN="$(head -c 4097)"');
    expect(script).not.toContain(document.credential);
  });

  it("refuses the install when the credential cannot be issued", async () => {
    const d = deps({
      env: { ...ALL_ON, HIVRA_INGRESS_HOST_CREDENTIAL: "true" },
      issueCredential: jest.fn(async () => ({ ok: false as const, reason: "origin_missing" as const })),
      runHostScriptWithStdin: jest.fn(),
    });
    const result = await runHostWakeProxyAction({ action: "install-wake-proxy", channel: "default", targetId: TARGET }, d);
    expect(result).toMatchObject({ ok: false, httpStatus: 409 });
    expect(result.error).toContain("origin_missing");
    expect(d!.runHostScript).not.toHaveBeenCalled();
  });

  it("revokes a host credential without any flag, then tidies the host file", async () => {
    const revokeCredential = jest.fn(async () => ({ ok: true as const, generation: 5 }));
    const d = deps({
      env: BASE_ENV,
      revokeCredential,
      runHostScript: jest.fn(async () => ({ ok: true, stdout: "HIVRA_WAKE_PROXY_RESULT status=removed step=credential changed=1 ms=3\n", stderr: "" })),
    });
    const result = await runHostWakeProxyAction({ action: "revoke-host-credential", channel: "default", targetId: TARGET }, d);
    expect(result).toMatchObject({ ok: true, credentialGeneration: 5, hostFileRemoved: true });
    expect(revokeCredential).toHaveBeenCalledWith(TARGET);
    expect((d!.runHostScript as jest.Mock).mock.calls[0][0]).toContain("host-credential.json");
    // The revocation holds even when the host cannot be reached.
    const offline = deps({ env: BASE_ENV, revokeCredential, runHostScript: jest.fn(async () => ({ ok: false, stdout: "", stderr: "", error: "ssh" })) });
    expect(await runHostWakeProxyAction({ action: "revoke-host-credential", channel: "default", targetId: TARGET }, offline))
      .toMatchObject({ ok: true, hostFileRemoved: false });
    const failed = deps({ env: BASE_ENV, revokeCredential: jest.fn(async () => ({ ok: false as const, reason: "unknown_host" })) });
    expect(await runHostWakeProxyAction({ action: "revoke-host-credential", channel: "default", targetId: TARGET }, failed))
      .toMatchObject({ ok: false, httpStatus: 409 });
    expect(failed!.runHostScript).not.toHaveBeenCalled();
  });

  it("hashes the five wake proxy files of the real reviewed bundle", async () => {
    const digests = await reviewedWakeProxyDigests(loadPortableProvisionerBundle);
    expect(Object.keys(digests).sort()).toEqual([...HOST_WAKE_PROXY_BUNDLE_FILES].sort());
    for (const value of Object.values(digests)) expect(value).toMatch(/^[0-9a-f]{64}$/);
  });
});
