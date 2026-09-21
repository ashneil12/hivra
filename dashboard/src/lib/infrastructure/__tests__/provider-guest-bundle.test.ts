import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProviderGuestBundlePlan as buildPlan, parseProviderGuestBundleReceipt, parseProviderGuestClock } from "../provider-guest-bundle";
import { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES, PORTABLE_HIVRA_PROVISIONER_VERSION } from "../portable-provisioner-contract";
import { receiverFixture } from "./first-boot-receiver.fixtures";

const scope = { binding: receiverFixture().binding, providerServerId: "42" };
const clock = { bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 1000 };
const buildProviderGuestBundlePlan = (input: Parameters<typeof buildPlan>[0], files: Parameters<typeof buildPlan>[1]) => buildPlan(input, files, clock);
const assets = () => PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({ relativePath,
  content: Buffer.from(relativePath === "VERSION" ? PORTABLE_HIVRA_PROVISIONER_VERSION + "\n" : `fixture:${relativePath}\n`) }));
const plan = () => buildProviderGuestBundlePlan(scope, assets());

describe("provider guest bundle delivery", () => {
  it("binds the complete asset manifest and original owner/order/server without carrying credentials", () => {
    const value = plan();
    expect(value.receipt).toMatchObject({ version: 1, state: "bundle_installed", provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION });
    expect(value.receipt.scopeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.receipt.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.script).not.toContain(scope.binding.userId);
    expect(value.script).not.toContain("PRIVATE KEY");
    expect(value.script).toContain('main()');
    const changed = assets(); changed[0].content = Buffer.from("changed");
    expect(buildProviderGuestBundlePlan(scope, changed).receipt.bundleSha256).not.toBe(value.receipt.bundleSha256);
    for (const binding of [{ ...scope.binding, userId: "another-owner" }, { ...scope.binding, connectionRevision: 8 }]) {
      expect(buildProviderGuestBundlePlan({ ...scope, binding }, assets()).receipt.scopeSha256).not.toBe(value.receipt.scopeSha256);
    }
    expect(buildProviderGuestBundlePlan({ ...scope, providerServerId: "43" }, assets()).receipt.scopeSha256).not.toBe(value.receipt.scopeSha256);
    expect(buildProviderGuestBundlePlan(scope, assets().reverse()).receipt).toEqual(value.receipt);
  });
  it.each(["missing", "extra", "duplicate", "version", "large", "traversal"])("rejects %s assets before transport", change => {
    const value = assets();
    if (change === "missing") value.pop();
    if (change === "extra") value.push({ relativePath: "unexpected" as never, content: Buffer.from("x") });
    if (change === "duplicate") value[1] = value[0];
    if (change === "version") value.find(v => v.relativePath === "VERSION")!.content = Buffer.from("unsupported");
    if (change === "large") value[0].content = Buffer.alloc(2 * 1024 * 1024);
    if (change === "traversal") value[0].relativePath = "../outside" as never;
    expect(() => buildProviderGuestBundlePlan(scope, value)).toThrow("Invalid provider guest bundle");
  });
  it.each(["userId", "connectionId", "connectionRevision", "orderId", "attemptId", "quoteFingerprint", "recipeVersion"])("rejects invalid %s scope", field => {
    expect(() => buildProviderGuestBundlePlan({ ...scope, binding: { ...scope.binding, [field]: "bad\nvalue" } } as never, assets()))
      .toThrow("Invalid provider guest bundle");
  });
  it("accepts only the exact bounded receipt with clean protocol framing", () => {
    const value = plan(), output = `HIVRA_PROVIDER_BUNDLE_V1 ${JSON.stringify(value.receipt)}\n`;
    expect(parseProviderGuestBundleReceipt(output, value.receipt)).toEqual(value.receipt);
    for (const invalid of ["", output + output, output + "\n", output.replace("\n", "\r\n"), "noise\n" + output, output + "private", output.repeat(100),
      output.replace(value.receipt.bundleSha256, "a".repeat(64)), output.replace('"bundle_installed"', '"ready"')]) {
      expect(() => parseProviderGuestBundleReceipt(invalid, value.receipt)).toThrow("Invalid provider guest bundle receipt");
    }
  });
  it("accepts a strict bounded guest clock and rejects absent, malformed or overflowing samples", () => {
    const line = `HIVRA_GUEST_CLOCK_V1 ${JSON.stringify(clock)}\n`;
    expect(parseProviderGuestClock(line)).toEqual(clock);
    for (const invalid of ["", line + line, line.replace(clock.bootId, "changed"),
      line.replace("1000", "-1"), line.replace("1000", String(Number.MAX_SAFE_INTEGER)), line + "\n"]) {
      expect(() => parseProviderGuestClock(invalid)).toThrow("Invalid provider guest clock");
    }
    expect(() => buildPlan(scope, assets(), null as never)).toThrow();
  });
});

describe("executable atomic guest bundle filesystem recipe", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "hivra-provider-bundle-test-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  // Exercise the actual filesystem functions on this test-owned directory.
  // The production entry checks root/Linux/Ubuntu/cloud-init; this fixture calls
  // only install_bundle with the local uid and never invokes that entrypoint.
  function execute(extra = "", value = plan()) {
    const script = value.script.replace('if __name__ == "__main__":\n    main()', "");
    return spawnSync("/usr/bin/python3", ["-I", "-"], { encoding: "utf8", timeout: 10_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "test" }, input: script + `\nroot = ${JSON.stringify(root)}\ncurrent_guest_clock = lambda: ${JSON.stringify(clock)}\n` + extra +
      '\ntry:\n    print(json.dumps(install_bundle(root, os.getuid(), PAYLOAD)))\nexcept Exception:\n    print("fixture rejected")\n    sys.exit(1)\n' });
  }
  it("atomically installs verified bytes and reconciles a repeat without overwriting", () => {
    const first = execute(); expect({ status: first.status, stderr: first.stderr }).toEqual({ status: 0, stderr: "" });
    const current = path.join(root, "current"), before = statSync(current).ino;
    for (const asset of assets()) expect(readFileSync(path.join(current, asset.relativePath))).toEqual(asset.content);
    expect(JSON.parse(first.stdout)).toEqual(plan().receipt);
    const second = execute(); expect(second.status).toBe(0); expect(JSON.parse(second.stdout)).toEqual(plan().receipt);
    expect(statSync(current).ino).toBe(before);
    expect(readdirSync(root).sort()).toEqual([".lock", "current"]);
  });
  it("round-trips the actual reviewed runtime bundle without executing any runtime file", () => {
    const actual = PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({ relativePath,
      content: readFileSync(path.join(process.cwd(), "provisioner", relativePath)) }));
    const value = buildProviderGuestBundlePlan(scope, actual);
    const result = execute("", value); expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    for (const asset of actual) expect(readFileSync(path.join(root, "current", asset.relativePath))).toEqual(asset.content);
    expect(JSON.parse(result.stdout)).toEqual(value.receipt);
  });
  it.each(["asset", "receipt", "missing", "extra", "symlink", "mode"])("rejects %s drift without repairing or overwriting it", change => {
    expect(execute().status).toBe(0);
    const current = path.join(root, "current"), file = path.join(current, ".gitignore");
    if (change === "asset") writeFileSync(file, "changed");
    if (change === "receipt") writeFileSync(path.join(current, ".hivra-receipt.json"), "{}");
    if (change === "missing" || change === "symlink") rmSync(file);
    if (change === "extra") writeFileSync(path.join(current, "unexpected"), "private");
    if (change === "symlink") symlinkSync(path.join(root, "outside"), file);
    if (change === "mode") chmodSync(file, 0o666);
    const before = statSync(current).ino;
    const result = execute(); expect(result.status).toBe(1); expect(result.stdout).toBe("fixture rejected\n");
    expect(statSync(current).ino).toBe(before);
    expect(readdirSync(root).some(name => name.startsWith(".upload-"))).toBe(false);
  });
  it("rejects a different original owner and a new bundle instead of adopting or upgrading", () => {
    expect(execute().status).toBe(0);
    const changedScope = buildProviderGuestBundlePlan({ ...scope, providerServerId: "43" }, assets());
    expect(execute("", changedScope).status).toBe(1);
    const changedAssets = assets(); changedAssets[0].content = Buffer.from("new version bytes");
    expect(execute("", buildProviderGuestBundlePlan(scope, changedAssets)).status).toBe(1);
  });
  it("leaves no published directory and removes its upload on a mid-write failure", () => {
    const result = execute('original_write = write_private\ndef fail_write(*args):\n    original_write(*args)\n    raise RuntimeError("fixture interrupted")\nwrite_private = fail_write');
    expect(result.status).toBe(1); expect(readdirSync(root)).toEqual([".lock"]);
    expect(execute().status).toBe(0);
  });
  it("reconciles a committed install after a lost acknowledgement", () => {
    const result = execute('original_sync = sync_dir\ndef fail_after_commit(directory):\n    original_sync(directory)\n    if str(directory) == root and os.path.isdir(os.path.join(root, "current")):\n        raise RuntimeError("fixture lost ack")\nsync_dir = fail_after_commit');
    expect(result.status).toBe(1);
    expect(execute().status).toBe(0);
  });
  it("refuses a symlinked root or lock before touching its destination", () => {
    const outside = path.join(root, "outside"); writeFileSync(outside, "untouched");
    symlinkSync(outside, path.join(root, ".lock"));
    expect(execute().status).toBe(1); expect(readFileSync(outside, "utf8")).toBe("untouched");
  });
  it.each(["queued_start", "at_deadline", "clock_rollback", "reboot"])("rejects %s before any filesystem write", change => {
    const stale = { ...clock, boottimeMs: change === "queued_start" ? 121_000 : change === "at_deadline" ? 21_000 : change === "clock_rollback" ? 999 : 1000,
      bootId: change === "reboot" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : clock.bootId };
    expect(execute(`current_guest_clock = lambda: ${JSON.stringify(stale)}`).status).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  });
  it.each(["lock", "write", "verification", "before_publication"])("fences expiry after %s without publishing a bundle", boundary => {
    const mutate = 'global expired\n    expired = True';
    const override = boundary === "lock" ? `original = fcntl.flock\ndef wrapped(*args):\n    result = original(*args)\n    ${mutate}\n    return result\nfcntl.flock = wrapped` :
      boundary === "write" ? `original = write_private\ndef wrapped(*args):\n    result = original(*args)\n    ${mutate}\n    return result\nwrite_private = wrapped` :
      boundary === "verification" ? `original = verify_bundle\ndef wrapped(*args):\n    result = original(*args)\n    ${mutate}\n    return result\nverify_bundle = wrapped` :
      `original = sync_dir\ndef wrapped(*args):\n    result = original(*args)\n    ${mutate}\n    return result\nsync_dir = wrapped`;
    const result = execute(`expired = False\ncurrent_guest_clock = lambda: {"bootId": "${clock.bootId}", "boottimeMs": 21000 if expired else 1000}\n` + override);
    expect(result.status).toBe(1); expect(readdirSync(root)).toEqual([".lock"]);
  });
});

describe("guest platform admission before filesystem changes", () => {
  function platformProbe(change: string) {
    const source = plan().script.replace('if __name__ == "__main__":\n    main()', "");
    return spawnSync("/usr/bin/python3", ["-I", "-"], { encoding: "utf8", timeout: 10_000,
      env: { PATH: "/usr/bin:/bin", NODE_ENV: "test" }, input: source + `\nfrom unittest.mock import patch, mock_open\nfrom types import SimpleNamespace\nchange = ${JSON.stringify(change)}\n` +
      'release = "ID=ubuntu\\nVERSION_ID=\\"22.04\\"\\n"\n' +
      'if change == "os": release = release.replace("ubuntu", "debian")\n' +
      'if change == "version": release = release.replace("22.04", "24.04")\n' +
      'with patch("os.geteuid", return_value=1 if change == "uid" else 0), patch("platform.system", return_value="Darwin" if change == "kernel" else "Linux"), patch("platform.machine", return_value="aarch64" if change == "arch" else "x86_64"), patch("builtins.open", mock_open(read_data=release)), patch("os.path.isdir", return_value=change != "systemd"), patch("os.access", return_value=change != "apt"), patch("subprocess.run") as command, patch("os.mkdir") as mkdir:\n' +
      '    command.return_value = SimpleNamespace(returncode=2 if change == "degraded" else 0, stdout=b"status: running" if change == "running" else b"status: done\\n")\n' +
      '    if change == "timeout": command.side_effect = subprocess.TimeoutExpired("cloud-init", 2)\n' +
      '    try:\n        check_platform()\n        assert not mkdir.called\n        assert command.call_args.args == (["/usr/bin/cloud-init", "status"],)\n        assert command.call_args.kwargs["timeout"] == 2\n        print("accepted")\n    except Exception:\n        assert not mkdir.called\n        print("rejected")\n        sys.exit(1)\n' });
  }
  it("accepts only the supported clean Ubuntu guest", () => {
    const result = platformProbe("supported"); expect({ status: result.status, stdout: result.stdout, stderr: result.stderr })
      .toEqual({ status: 0, stdout: "accepted\n", stderr: "" });
  });
  it.each(["uid", "kernel", "arch", "os", "version", "systemd", "apt", "degraded", "running", "timeout"])("rejects %s without filesystem mutation", change => {
    const result = platformProbe(change); expect({ status: result.status, stdout: result.stdout, stderr: result.stderr })
      .toEqual({ status: 1, stdout: "rejected\n", stderr: "" });
  });
});
