import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import type { PortableProvisionerBundleAsset } from "./connection-preparation";
import { FIRST_BOOT_RECIPE_VERSION } from "./first-boot-enrollment";
import type { FirstBootOperationScope } from "./first-boot-operations";
import { PORTABLE_HIVRA_COMPATIBLE_PROVIDER_VM_VERSIONS, PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES, PORTABLE_HIVRA_PROVISIONER_VERSION } from "./portable-provisioner-contract";

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/);
const ScopeSchema = z.object({
  binding: z.object({
    userId: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/), connectionId: UUID,
    connectionRevision: z.number().int().positive().safe(), orderId: UUID, attemptId: UUID,
    quoteFingerprint: DIGEST, recipeVersion: z.literal(FIRST_BOOT_RECIPE_VERSION),
  }).strict(),
  providerServerId: z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value))),
}).strict();
const ReceiptSchema = z.object({
  version: z.literal(1), state: z.literal("bundle_installed"), scopeSha256: DIGEST,
  bundleSha256: DIGEST, provisionerVersion: z.enum(PORTABLE_HIVRA_COMPATIBLE_PROVIDER_VM_VERSIONS),
}).strict();
export type ProviderGuestBundleReceipt = z.infer<typeof ReceiptSchema>;
const ClockSchema = z.object({ bootId: UUID, boottimeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 20_000) }).strict();
export type ProviderGuestClock = z.infer<typeof ClockSchema>;
/** Read-only sample consumed only after clean pinned SSH channel completion.
 * CLOCK_BOOTTIME includes suspend time and does not depend on UTC/NTP skew.
 */
export const PROVIDER_GUEST_CLOCK_SCRIPT = String.raw`import json, time
with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
    boot_id = stream.read(64).strip()
print("HIVRA_GUEST_CLOCK_V1 " + json.dumps({"bootId": boot_id, "boottimeMs": time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1000000}), flush=True)
`;
export function parseProviderGuestClock(output: string): ProviderGuestClock {
  try {
    if (Buffer.byteLength(output) > 256 || !output.startsWith("HIVRA_GUEST_CLOCK_V1 ") || !output.endsWith("\n")
      || output.indexOf("\n") !== output.length - 1 || output.includes("\r")) throw new Error();
    return ClockSchema.parse(JSON.parse(output.slice("HIVRA_GUEST_CLOCK_V1 ".length)));
  } catch { throw new Error("Invalid provider guest clock"); }
}
export const PROVIDER_GUEST_BUNDLE_DIRECTORY = "/opt/hivra/provider-bundle/current";
const MARKER = "HIVRA_PROVIDER_BUNDLE_V1 ";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Stable v1 operation binding, independent of the currently shipped assets.
 * Recovery uses this same digest to reject a journal from another computer.
 */
export function providerGuestBundleScopeSha256(input: FirstBootOperationScope) {
  const scope = ScopeSchema.parse(input), b = scope.binding;
  return hash(JSON.stringify(["hivra/provider-bundle/v1", b.userId, b.connectionId, b.connectionRevision,
    b.orderId, b.attemptId, b.quoteFingerprint, b.recipeVersion, scope.providerServerId]));
}

function bundlePayload(input: FirstBootOperationScope, assets: PortableProvisionerBundleAsset[]) {
  let payload: { receipt: ProviderGuestBundleReceipt; files: { path: string; sha256: string; size: number; mode: number; data: string }[] };
  try {
    const scope = ScopeSchema.parse(input);
    const expected = new Set<string>(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES);
    if (assets.length !== expected.size || assets.some(asset => !expected.delete(asset.relativePath) || !Buffer.isBuffer(asset.content))
      || expected.size || assets.reduce((size, asset) => size + asset.content.length, 0) > 2 * 1024 * 1024
      || assets.find(asset => asset.relativePath === "VERSION")?.content.toString().trim() !== PORTABLE_HIVRA_PROVISIONER_VERSION) throw new Error();
    const files = assets.map(asset => ({ path: asset.relativePath, sha256: hash(asset.content), size: asset.content.length,
      mode: asset.relativePath.endsWith(".sh") || ["hivra-browser-apply", "hivra-guest-ssh-known-hosts", "hivra-network-preflight", "hivra-tg-apply"].includes(asset.relativePath) ? 0o700 : 0o600,
      data: asset.content.toString("base64"),
    })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    payload = { files, receipt: { version: 1, state: "bundle_installed", provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      scopeSha256: providerGuestBundleScopeSha256(scope),
      bundleSha256: hash(JSON.stringify(files.map(file => [file.path, file.sha256, file.size, file.mode]))),
    } };
  } catch { throw new Error("Invalid provider guest bundle"); }
  return payload;
}

export function providerGuestBundleReceipt(input: FirstBootOperationScope, assets: PortableProvisionerBundleAsset[]) {
  return bundlePayload(input, assets).receipt;
}

/** Non-secret integrity manifest for the fixed guest worker. */
export function providerGuestBundleManifest(input: FirstBootOperationScope, assets: PortableProvisionerBundleAsset[]) {
  return bundlePayload(input, assets).files.map(({ path, sha256, size, mode }) => ({ path, sha256, size, mode }));
}

/** Fixed, non-executing delivery of the same reviewed runtime assets. The
 * caller supplies server-owned bytes, not a URL, command or install directory.
 * A recently observed clock on this pinned guest fences delayed starts/writes.
 * The durable receipt omits that per-invocation clock so retries can reconcile.
 */
export function buildProviderGuestBundlePlan(input: FirstBootOperationScope, assets: PortableProvisionerBundleAsset[], clock: ProviderGuestClock): {
  receipt: ProviderGuestBundleReceipt; script: string;
} {
  const payload = { ...bundlePayload(input, assets), clock: ClockSchema.parse(clock) };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  return { receipt: payload.receipt, script: `# Hivra provider bundle delivery v1; no package/service/runtime execution.
import base64, fcntl, hashlib, json, os, pathlib, platform, shutil, signal, stat, subprocess, sys, tempfile, time
PAYLOAD = json.loads(base64.b64decode("${encoded}", validate=True))
` + String.raw`
def current_guest_clock():
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
        boot_id = stream.read(64).strip()
    return {"bootId": boot_id, "boottimeMs": time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1000000}

def check_authority():
    observed = PAYLOAD["clock"]
    current = current_guest_clock()
    if current["bootId"] != observed["bootId"] or current["boottimeMs"] < observed["boottimeMs"] or current["boottimeMs"] >= observed["boottimeMs"] + 20000:
        raise RuntimeError("guest authority expired")

def checked_dir(directory, uid):
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
        raise RuntimeError("unsafe directory")

def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def read_private(file, uid, mode, size):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode or info.st_size != size:
            raise RuntimeError("changed file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(size + 1)
        if len(data) != size:
            raise RuntimeError("changed size")
        return data
    finally:
        os.close(fd)

def write_private(file, data, mode):
    check_authority()
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            check_authority()
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)

def receipt_bytes(payload):
    return json.dumps(payload["receipt"], sort_keys=True, separators=(",", ":")).encode("ascii") + b"\n"

def verify_bundle(directory, uid, payload):
    check_authority()
    checked_dir(directory, uid)
    expected = {file["path"] for file in payload["files"]} | {".hivra-receipt.json"}
    actual = set()
    expected_dirs = {str(pathlib.PurePosixPath(name).parent) for name in expected} - {"."}
    for parent, dirs, files in os.walk(directory, followlinks=False):
        checked_dir(parent, uid)
        for child in dirs:
            item = pathlib.Path(parent) / child
            checked_dir(item, uid)
            if str(item.relative_to(directory)) not in expected_dirs:
                raise RuntimeError("unexpected directory")
        for child in files:
            actual.add(str((pathlib.Path(parent) / child).relative_to(directory)))
    if actual != expected:
        raise RuntimeError("changed manifest")
    for file in payload["files"]:
        check_authority()
        data = read_private(pathlib.Path(directory) / file["path"], uid, file["mode"], file["size"])
        if hashlib.sha256(data).hexdigest() != file["sha256"]:
            raise RuntimeError("changed asset")
    receipt = receipt_bytes(payload)
    if read_private(pathlib.Path(directory) / ".hivra-receipt.json", uid, 0o600, len(receipt)) != receipt:
        raise RuntimeError("changed receipt")

def install_bundle(root, uid, payload):
    # The parent is root-owned/non-writable to the agent. A scoped flock and
    # O_NOFOLLOW/O_EXCL prevent cooperating retries or symlinks from replacing
    # any existing installation. A different scope/version needs explicit upgrade.
    check_authority()
    checked_dir(root, uid)
    check_authority()
    lock = os.open(os.path.join(root, ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    upload = None
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("unsafe lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        check_authority()
        current = os.path.join(root, "current")
        if os.path.lexists(current):
            verify_bundle(current, uid, payload)
            check_authority()
            return payload["receipt"]
        check_authority()
        upload = tempfile.mkdtemp(prefix=".upload-", dir=root)
        for file in payload["files"]:
            check_authority()
            name = pathlib.PurePosixPath(file["path"])
            if name.is_absolute() or ".." in name.parts or not name.parts:
                raise RuntimeError("unsafe asset path")
            destination = pathlib.Path(upload) / name
            check_authority()
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            data = base64.b64decode(file["data"], validate=True)
            if len(data) != file["size"] or hashlib.sha256(data).hexdigest() != file["sha256"]:
                raise RuntimeError("invalid asset")
            write_private(destination, data, file["mode"])
        write_private(pathlib.Path(upload) / ".hivra-receipt.json", receipt_bytes(payload), 0o600)
        verify_bundle(upload, uid, payload)
        for parent, dirs, files in os.walk(upload, topdown=False):
            check_authority()
            sync_dir(parent)
        # Atomic publication only after complete verification and fsync. A lost
        # SSH acknowledgement is reconciled by rereading these exact bytes.
        check_authority()
        os.rename(upload, current)
        upload = None
        sync_dir(root)
        verify_bundle(current, uid, payload)
        check_authority()
        return payload["receipt"]
    finally:
        if upload is not None:
            shutil.rmtree(upload)  # Only this invocation's mkdtemp directory.
        os.close(lock)

def check_platform():
    if os.geteuid() != 0 or platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("unsupported platform")
    # Parse data, never source os-release as executable shell.
    release = {}
    with open("/etc/os-release", encoding="utf-8") as stream:
        for line in stream:
            key, separator, value = line.strip().partition("=")
            if separator:
                release[key] = value.strip('"')
    if release.get("ID") != "ubuntu" or release.get("VERSION_ID") != "22.04":
        raise RuntimeError("unsupported image")
    if not os.path.isdir("/run/systemd/system") or not os.access("/usr/bin/apt-get", os.X_OK):
        raise RuntimeError("unsupported init")
    boot = subprocess.run(["/usr/bin/cloud-init", "status"], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, check=False)
    if boot.returncode != 0 or boot.stdout.strip() != b"status: done":
        raise RuntimeError("cloud init incomplete")

def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        check_authority()
        check_platform()  # No filesystem mutation before this check.
        check_authority()
        for directory in ["/", "/opt"]:
            checked_dir(directory, 0)
        for directory in ["/opt/hivra", "/opt/hivra/provider-bundle"]:
            if not os.path.lexists(directory):
                check_authority()
                os.mkdir(directory, 0o700)
                sync_dir(os.path.dirname(directory))
            checked_dir(directory, 0)
        receipt = install_bundle("/opt/hivra/provider-bundle", 0, PAYLOAD)
        check_authority()
        print("HIVRA_PROVIDER_BUNDLE_V1 " + json.dumps(receipt, separators=(",", ":")), flush=True)
    except Exception:
        print("Provider guest bundle delivery failed", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
` };
}

export function parseProviderGuestBundleReceipt(output: string, expected: ProviderGuestBundleReceipt): ProviderGuestBundleReceipt {
  try {
    if (Buffer.byteLength(output) > 1024 || !output.startsWith(MARKER) || !output.endsWith("\n")
      || output.indexOf("\n") !== output.length - 1 || output.includes("\r")) throw new Error();
    const receipt = ReceiptSchema.parse(JSON.parse(output.slice(MARKER.length)));
    if (Object.keys(expected).some(key => receipt[key as keyof typeof receipt] !== expected[key as keyof typeof expected])) throw new Error();
    return receipt;
  } catch { throw new Error("Invalid provider guest bundle receipt"); }
}
