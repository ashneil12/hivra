import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import release from "../../../provisioner-releases/2026.09.21.1.json";
import priorCapacityRelease from "../../../provisioner-releases/2026.09.15.2.json";
import previousRelease from "../../../provisioner-releases/2026.09.08.3.json";
import priorFifteenRelease from "../../../provisioner-releases/2026.09.15.1.json";
import densityRelease from "../../../provisioner-releases/2026.09.07.1.json";
import scalingRelease from "../../../provisioner-releases/2026.09.06.4.json";
import transferRelease from "../../../provisioner-releases/2026.09.06.3.json";
import preparedRelease from "../../../provisioner-releases/2026.09.06.2.json";
import editorRelease from "../../../provisioner-releases/2026.09.06.1.json";
import ownershipRelease from "../../../provisioner-releases/2026.09.05.10.json";
import workspaceRelease from "../../../provisioner-releases/2026.09.05.9.json";
import coldStartRelease from "../../../provisioner-releases/2026.09.05.8.json";
import framingRelease from "../../../provisioner-releases/2026.09.05.7.json";
import priorRelease from "../../../provisioner-releases/2026.09.05.6.json";
import type { PortableProvisionerBundleAsset } from "./connection-preparation";
import type { FirstBootOperationScope } from "./first-boot-operations";
import { parseProviderGuestClock, providerGuestBundleManifest, providerGuestBundleReceipt,
  providerGuestBundleScopeSha256, type ProviderGuestClock } from "./provider-guest-bundle";
import { providerGuestWorkerRecipe } from "./provider-guest-worker-recipes";
import { parseProviderDesktopLaunch, type ProviderDesktopLaunch, type ProviderDesktopLaunchAuthority } from "./provider-desktop-launch-contract";

/** Staged, PRIVATE v3 desktop contract. Public launch and the default operation store
 * remain v1-only. The desktop SQL fence is separate: an adapter must acquire its
 * cleanup grant BEFORE fresh SSH and record proof against that captured grant.
 * Existing v1 recovery and historical release records deliberately stay intact.
 */
const VERSION = "2026.09.21.1";
const PROFILE = "desktop-owned-services-v1";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const closurePaths = ["remote-desktop/provider-service-owner.py"];
const rows = release.files.map(file => [file.path, file.sha256, file.bytes,
  file.path.endsWith(".sh") || ["hivra-browser-apply", "hivra-guest-ssh-known-hosts", "hivra-network-preflight", "hivra-tg-apply"].includes(file.path) ? 0o700 : 0o600] as const)
  .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const bundleSha256 = hash(JSON.stringify(rows));
// Python worker.encode adds a newline; the bundle manifest digest does not.
const closureSha256 = hash(JSON.stringify(rows.filter(row => closurePaths.includes(row[0]))) + "\n");
function identity(version: "2026.09.05.6" | "2026.09.05.7" | "2026.09.05.8" | "2026.09.05.9" | "2026.09.05.10" | "2026.09.06.1" | "2026.09.06.2" | "2026.09.06.3" | "2026.09.06.4" | "2026.09.07.1" | "2026.09.08.1" | "2026.09.08.2" | "2026.09.08.3" | "2026.09.15.1" | "2026.09.15.2" | "2026.09.21.1", bundle: string) { return z.object({ version: z.literal(3), agentId: Uuid, operationId: Uuid,
  bundle: z.object({ version: z.literal(1), state: z.literal("bundle_installed"), scopeSha256: Digest,
    bundleSha256: z.literal(bundle), provisionerVersion: z.literal(version) }).strict(),
  desktopCleanup: z.object({ profile: z.literal(PROFILE), closureSha256: z.literal(closureSha256) }).strict(),
}).strict(); }
const CurrentIdentity = identity(VERSION, bundleSha256);
const Identity = z.union([CurrentIdentity,
  identity("2026.09.15.2", "17f367fbffbda1212fd61e4aab5e45f0646528de388b0667d0e4dc33c011711f"),
  identity("2026.09.15.1", "8c78992766b7f6f5aa499556342e3ff4e340bd5f8718850b488b4ce09e8dcf49"),
  identity("2026.09.08.3", "9f7d173d1912dc3001770ecbb5fc31b601660b331591b0526311f666057318f9"),
  identity("2026.09.08.2", "1660674e4927585463122666f3471de1ce7e6bc391f476c83f2fb96548f9672e"),
  identity("2026.09.07.1", "73ba80eb4007cdba90046637af0efc4712b395532a3fe890cc6a2bbb6dc322cb"),
  identity("2026.09.06.4", "a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db"),
  identity("2026.09.06.3", "5ea99797e6a1f7b105d1af07c191585c386df5590bd65a3389f045a41466dbef"),
  identity("2026.09.06.2", "9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee"),
  identity("2026.09.06.1", "61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c"),
  identity("2026.09.05.10", "c48b6f0df47743e4fd4978b3a886e1fb68ee5cc163d51781cd8c7a4a539b7860"),
  identity("2026.09.05.9", "89b5e64591d3cff0f2a4f28460ee9075221946ed37694ec5eb566c5a40af4127"),
  identity("2026.09.05.8", "007b9fcf9b667da3264875682d0d72feabff5729b4d7adcc168f6a2dbbcdc545"),
  identity("2026.09.05.7", "d3631ea66b7d74084e1f29e7795f2459e6e215c4f97a6e231ccf480f3cb9ba9b"),
  identity("2026.09.05.6", "1226dfc97e54f745b84b934e89246adc4453f85b3bdad1e14fc892d9ff5d1da4")]);
export type ProviderDesktopWorkerIdentity = z.infer<typeof Identity>;
export function parseProviderDesktopWorkerIdentity(input: unknown): ProviderDesktopWorkerIdentity {
  try { return Identity.parse(input); }
  catch { throw new Error("Invalid provider desktop worker identity"); }
}

const Cleanup = z.union([
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.enum(["not_started", "verified_stopped"]), bootId: Uuid }).strict(),
]);
const Receipt = z.object({ version: z.literal(3), identity: Identity,
  state: z.enum(["unknown", "running", "stopping", "cancelled", "failed", "succeeded"]), stopped: z.boolean(), desktopCleanup: Cleanup,
}).strict().refine(value => value.stopped === ["cancelled", "failed", "succeeded"].includes(value.state)
  && (value.desktopCleanup.state === "pending" || value.stopped)
  && (value.desktopCleanup.state !== "not_started" || value.state === "cancelled"));
export type ProviderDesktopWorkerReceipt = z.infer<typeof Receipt>;
export type ProviderDesktopWorkerInput = { scope: FirstBootOperationScope; agentId: string; operationId: string } & (
  { action: "start"; assets: PortableProvisionerBundleAsset[]; launch: ProviderDesktopLaunch; authority: ProviderDesktopLaunchAuthority }
  | { action: "status" | "cancel"; identity: ProviderDesktopWorkerIdentity }
);

/** No host/key lookup, grant acquisition or execution. Authority must come from
 * the original server-owned access journal, never the browser. Recovery only
 * uses the original identity and does not reload launch credentials.
 */
export function buildProviderDesktopWorkerPlan(input: ProviderDesktopWorkerInput, clock: ProviderGuestClock) {
  try {
    if (!["start", "status", "cancel"].includes(input.action)) throw new Error();
    const checkedClock = parseProviderGuestClock(`HIVRA_GUEST_CLOCK_V1 ${JSON.stringify(clock)}\n`);
    let launch: ProviderDesktopLaunch | undefined;
    if (input.action === "start") {
      if (input.authority.computerId !== input.agentId) throw new Error();
      launch = parseProviderDesktopLaunch(input.launch, input.authority);
    }
    const identity = (input.action === "start" ? CurrentIdentity : Identity).parse(input.action === "start"
      ? { version: 3, agentId: input.agentId, operationId: input.operationId,
        bundle: providerGuestBundleReceipt(input.scope, input.assets), desktopCleanup: { profile: PROFILE, closureSha256 } }
      : input.identity);
    const maxRunMs = [VERSION, "2026.09.06.3", "2026.09.06.2", "2026.09.06.1", "2026.09.05.10", "2026.09.05.9", "2026.09.05.8"].includes(identity.bundle.provisionerVersion) ? 1_200_000 : 480_000;
    if (checkedClock.boottimeMs > Number.MAX_SAFE_INTEGER - maxRunMs) throw new Error();
    if (identity.agentId !== input.agentId || identity.operationId !== input.operationId
      || identity.bundle.scopeSha256 !== providerGuestBundleScopeSha256(input.scope)) throw new Error();
    const request = input.action === "start"
      ? { action: input.action, identity, clock: checkedClock, manifest: providerGuestBundleManifest(input.scope, input.assets), launch }
      : { action: input.action, identity, clock: checkedClock };
    const raw = JSON.stringify(request);
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error();
    const recipe = providerGuestWorkerRecipe(identity.bundle.provisionerVersion);
    const boundRelease = identity.bundle.provisionerVersion === VERSION ? release
      : identity.bundle.provisionerVersion === "2026.09.15.2" ? priorCapacityRelease
      : identity.bundle.provisionerVersion === "2026.09.15.1" ? priorFifteenRelease
      : identity.bundle.provisionerVersion === "2026.09.08.3" ? previousRelease
      : identity.bundle.provisionerVersion === "2026.09.07.1" ? densityRelease
      : identity.bundle.provisionerVersion === "2026.09.06.4" ? scalingRelease
      : identity.bundle.provisionerVersion === "2026.09.06.3" ? transferRelease
      : identity.bundle.provisionerVersion === "2026.09.06.2" ? preparedRelease
      : identity.bundle.provisionerVersion === "2026.09.06.1" ? editorRelease
      : identity.bundle.provisionerVersion === "2026.09.05.10" ? ownershipRelease
      : identity.bundle.provisionerVersion === "2026.09.05.9" ? workspaceRelease
      : identity.bundle.provisionerVersion === "2026.09.05.8" ? coldStartRelease
      : identity.bundle.provisionerVersion === "2026.09.05.7" ? framingRelease : priorRelease;
    const worker = boundRelease.files.find(file => file.path === "hivra-provider-worker.py");
    if (!worker || recipe.workerSha256 !== worker.sha256 || recipe.workerSize !== worker.bytes) throw new Error();
    // Retained recovery takes precedence and never even reads the current
    // bundle. Only the pre-dispatch absence case may use the SAME pinned worker
    // from current. A missing/changed retained controller after dispatch cannot
    // be repaired or hidden by a fallback, download, overwrite or new release.
    const script = `import base64, hashlib, io, os, stat, sys
try:
    def directory(path):
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError()
    def exists(path):
        try:
            os.lstat(path)
            return True
        except FileNotFoundError:
            return False
    path = "/opt/hivra/provider-bundle/current/hivra-provider-worker.py"
    retained = False
    ${input.action === "start" ? "# Starts use the exact current bundle; the worker retains it before dispatch." : `for parent in ["/", "/var", "/var/lib"]:
        directory(parent)
    root = "/var/lib/hivra/provider-install"
    if exists("/var/lib/hivra"):
        directory("/var/lib/hivra")
        if exists(root):
            directory(root)
            if exists(root + "/controller.py"):
                path = root + "/controller.py"
                retained = True
            elif exists(root + "/dispatch.json") or exists(root + "/started.json"):
                raise ValueError()`}
    if not retained:
        for parent in ["/", "/opt", "/opt/hivra", "/opt/hivra/provider-bundle", "/opt/hivra/provider-bundle/current"]:
            directory(parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != ${recipe.workerSize}:
            raise ValueError()
        with os.fdopen(fd, "rb", closefd=False) as stream:
            source = stream.read(${recipe.workerSize + 1})
    finally:
        os.close(fd)
    if hashlib.sha256(source).hexdigest() != "${recipe.workerSha256}":
        raise ValueError()
    module = {"__name__": "hivra_provider_worker", "__file__": path}
    exec(compile(source, path, "exec"), module)
    sys.argv = [path]
    sys.stdin = io.TextIOWrapper(io.BytesIO(base64.b64decode("${Buffer.from(raw).toString("base64")}", validate=True)), encoding="utf-8")
    sys.exit(module["main"]())
except Exception:
    print("Provider desktop installer operation could not be verified", file=sys.stderr)
    sys.exit(1)
`;
    return { identity, script };
  } catch { throw new Error("Invalid provider desktop worker request"); }
}

/** Cleanup authority is distinct from installer outcome and must match the
 * guest boot sampled on this invocation. Persisting this receipt alone is not
 * a timeless readiness/delete grant or proof of whole-computer teardown.
 */
export function parseProviderDesktopWorkerReceipt(output: string, expected: ProviderDesktopWorkerIdentity, clock: ProviderGuestClock): ProviderDesktopWorkerReceipt {
  try {
    const marker = "HIVRA_PROVIDER_WORKER_V1 "; // Existing wire marker; envelope discriminates v3.
    const checkedClock = parseProviderGuestClock(`HIVRA_GUEST_CLOCK_V1 ${JSON.stringify(clock)}\n`);
    if (Buffer.byteLength(output) > 4096 || !output.startsWith(marker) || !output.endsWith("\n")
      || output.indexOf("\n") !== output.length - 1 || output.includes("\r")) throw new Error();
    const receipt = Receipt.parse(JSON.parse(output.slice(marker.length)));
    if (JSON.stringify(receipt.identity) !== JSON.stringify(Identity.parse(expected))
      || (receipt.desktopCleanup.state !== "pending" && receipt.desktopCleanup.bootId !== checkedClock.bootId)) throw new Error();
    return receipt;
  } catch { throw new Error("Invalid provider desktop worker receipt"); }
}
