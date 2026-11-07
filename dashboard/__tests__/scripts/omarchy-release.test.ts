import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { assertOmarchyInstallerRelease, resolveLatestOmarchyInstaller, VALIDATED_OMARCHY_INSTALLER } from "../../scripts/omarchy-release";
import { buildOmarchyLabLaunchScript } from "../../scripts/omarchy-proxmox-lab";

function response(body: string, status = 200): Response {
  let read = false;
  return { ok: status >= 200 && status < 300, status, body: { getReader: () => ({
    read: async () => read ? { done: true } : (read = true, { done: false, value: Buffer.from(body) }),
    cancel: async () => undefined,
  }) } } as unknown as Response;
}
function upstream(overrides: Record<string, string> = {}) {
  const prefix = "https://api.github.com/repos/omacom/omarchy";
  const bodies: Record<string, string> = {
    [`${prefix}/releases/latest`]: JSON.stringify({ tag_name: "v4.0.7", draft: false, prerelease: false }),
    [`${prefix}/git/ref/tags/v4.0.7`]: JSON.stringify({ ref: "refs/tags/v4.0.7", object: { type: "commit", sha: "a".repeat(40) } }),
    "https://iso.omarchy.org/omarchy-4.0.7.iso.sha256": `${"b".repeat(64)}  omarchy-4.0.7.iso\n`,
    ...overrides,
  };
  return jest.fn(async (url: string) => {
    if (!(url in bodies)) throw new Error(`Unexpected upstream request: ${url}`);
    return response(bodies[url]);
  }) as jest.Mock & typeof fetch;
}

it("resolves a newer stable release and pins that artifact rather than the old default", async () => {
  const fetcher = upstream();
  const release = await resolveLatestOmarchyInstaller(fetcher);
  expect(release).toEqual({ release: "v4.0.7", releaseCommit: "a".repeat(40),
    isoUrl: "https://iso.omarchy.org/omarchy-4.0.7.iso", isoFilename: "omarchy-4.0.7.iso", isoSha256: "b".repeat(64) });
  const script = buildOmarchyLabLaunchScript({ vmid: 2099, name: "hivra-omarchy-lab",
    operationId: "018f6d3c-1d91-7c65-9d86-37fc915b8377", expectedHostname: "lab-node",
    vmStorage: "local-lvm", isoStorage: "local", bridge: "vmbr1", cpu: 4, memoryMb: 8192, diskGb: 40 }, [], release);
  expect(script).toContain("OMARCHY_RELEASE='v4.0.7'");
  expect(script).toContain(`OMARCHY_RELEASE_COMMIT='${"a".repeat(40)}'`);
  expect(script).toContain("omarchy-4.0.7.iso");
  expect(script).not.toContain("omarchy-4.0.6.iso");
  expect(script).toContain(".installer.json");
  expect(script).toContain('"$OMARCHY_RELEASE_COMMIT"');
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
  const root = fs.mkdtempSync(path.join(tmpdir(), "omarchy-installer-receipt-"));
  try {
    const start = script.indexOf("printf '{\"vmid\":");
    const receiptCommand = script.slice(start, script.indexOf('chmod 0600 "$INSTALLER_RECEIPT.tmp"', start));
    const result = spawnSync("bash", ["-c", receiptCommand], { encoding: "utf8", env: { ...process.env,
      VMID: "2099", OPERATION_ID: "018f6d3c-1d91-7c65-9d86-37fc915b8377", OMARCHY_RELEASE: release.release,
      OMARCHY_RELEASE_COMMIT: release.releaseCommit, OMARCHY_ISO_SHA256: release.isoSha256,
      INSTALLER_RECEIPT: root + "/selected.json" } });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(fs.readFileSync(root + "/selected.json.tmp", "utf8"))).toEqual({
      vmid: 2099, operationId: "018f6d3c-1d91-7c65-9d86-37fc915b8377", release: release.release,
      releaseCommit: release.releaseCommit, isoSha256: release.isoSha256 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const [, init] of fetcher.mock.calls) expect(init).toEqual(expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
});

it("dereferences an annotated official tag to its immutable commit", async () => {
  const base = "https://api.github.com/repos/omacom/omarchy";
  const release = await resolveLatestOmarchyInstaller(upstream({
    [`${base}/git/ref/tags/v4.0.7`]: JSON.stringify({ ref: "refs/tags/v4.0.7", object: { type: "tag", sha: "c".repeat(40) } }),
    [`${base}/git/tags/${"c".repeat(40)}`]: JSON.stringify({ object: { type: "commit", sha: "d".repeat(40) } }),
  }));
  expect(release.releaseCommit).toBe("d".repeat(40));
});

it.each([
  { tag_name: "v4.1.0-beta.1", draft: false, prerelease: true },
  { tag_name: "v4.0.7", draft: true, prerelease: false },
  { tag_name: "v5.0.0", draft: false, prerelease: false },
  { tag_name: "v4.0.7; touch /tmp/injected", draft: false, prerelease: false },
])("rejects unsupported upstream metadata: %j", async latest => {
  const fetcher = upstream({ "https://api.github.com/repos/omacom/omarchy/releases/latest": JSON.stringify(latest) });
  await expect(resolveLatestOmarchyInstaller(fetcher)).rejects.toThrow(/supported stable v4/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("refuses a checksum naming a different artifact", async () => {
  await expect(resolveLatestOmarchyInstaller(upstream({
    "https://iso.omarchy.org/omarchy-4.0.7.iso.sha256": `${"b".repeat(64)}  other.iso\n`,
  }))).rejects.toThrow(/different artifact/);
});

it("fails closed on upstream outage and oversized metadata", async () => {
  await expect(resolveLatestOmarchyInstaller(jest.fn(async () => response("no", 503)))).rejects.toThrow(/503/);
  await expect(resolveLatestOmarchyInstaller(jest.fn(async () => response("x".repeat(131_073))))).rejects.toThrow(/too large/);
});

it("refuses caller-supplied shell and download URL substitutions", () => {
  expect(() => assertOmarchyInstallerRelease({ ...VALIDATED_OMARCHY_INSTALLER, isoUrl: "https://untrusted.example/install.iso" })).toThrow(/invalid/);
  expect(() => assertOmarchyInstallerRelease({ ...VALIDATED_OMARCHY_INSTALLER, releaseCommit: "$(id)" })).toThrow(/invalid/);
});
