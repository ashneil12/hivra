import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import release from "../../../provisioner-releases/2026.09.24.1.json";
import type { PortableProvisionerBundleAsset } from "./connection-preparation";
import type { FirstBootOperationScope } from "./first-boot-operations";
import { parseProviderGuestClock, providerGuestBundleManifest, providerGuestBundleReceipt,
  providerGuestBundleScopeSha256, type ProviderGuestClock } from "./provider-guest-bundle";
import { providerGuestWorkerRecipe } from "./provider-guest-worker-recipes";

/** Staged, PRIVATE v2 contract. Public launch and the default operation store
 * remain v1-only. The native SQL fence is separate: an adapter must acquire its
 * cleanup grant BEFORE fresh SSH and record proof against that captured grant.
 * Existing v1 recovery and historical release records deliberately stay intact.
 */
const VERSION = "2026.09.24.1";
const PROFILE = "deepseek-owned-service-v1";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const closurePaths = ["deepseek-harness/bux-hivra-chat.service", "deepseek-harness/install-native.py", "deepseek-harness/service-owner.py"];
const rows = release.files.map(file => [file.path, file.sha256, file.bytes,
  file.path.endsWith(".sh") || ["hivra-browser-apply", "hivra-guest-ssh-known-hosts", "hivra-network-preflight", "hivra-tg-apply"].includes(file.path) ? 0o700 : 0o600] as const)
  .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const bundleSha256 = hash(JSON.stringify(rows));
// Python worker.encode adds a newline; the bundle manifest digest does not.
const closureSha256 = hash(JSON.stringify(rows.filter(row => closurePaths.includes(row[0]))) + "\n");
function identity(version: "2026.08.31.3" | "2026.08.31.4" | "2026.09.01.1" | "2026.09.01.2" | "2026.09.01.3" | "2026.09.01.4" | "2026.09.01.5" | "2026.09.01.6" | "2026.09.01.7" | "2026.09.01.8" | "2026.09.01.9" | "2026.09.02.1" | "2026.09.02.2" | "2026.09.02.3" | "2026.09.02.4" | "2026.09.02.5" | "2026.09.02.6" | "2026.09.02.7" | "2026.09.02.8" | "2026.09.03.1" | "2026.09.03.2" | "2026.09.04.1" | "2026.09.04.2" | "2026.09.04.3" | "2026.09.04.4" | "2026.09.05.1" | "2026.09.05.2" | "2026.09.05.3" | "2026.09.05.4" | "2026.09.05.5" | "2026.09.05.6" | "2026.09.05.7" | "2026.09.05.8" | "2026.09.05.9" | "2026.09.05.10" | "2026.09.06.1" | "2026.09.06.2" | "2026.09.06.3" | "2026.09.06.4" | "2026.09.07.1" | "2026.09.08.1" | "2026.09.08.2" | "2026.09.08.3" | "2026.09.15.1" | "2026.09.15.2" | "2026.09.21.1" | "2026.09.22.1" | "2026.09.22.2" | "2026.09.24.1", bundle: string) { return z.object({ version: z.literal(2), agentId: Uuid, operationId: Uuid,
  bundle: z.object({ version: z.literal(1), state: z.literal("bundle_installed"), scopeSha256: Digest,
    bundleSha256: z.literal(bundle), provisionerVersion: z.literal(version) }).strict(),
  nativeCleanup: z.object({ profile: z.literal(PROFILE), closureSha256: z.literal(closureSha256) }).strict(),
}).strict(); }
const CurrentIdentity = identity(VERSION, bundleSha256);
const Identity = z.union([
  identity("2026.09.22.2", "1569888d0f18186e8291c9752a3b2823028afb044c8596e129924ce05dfc147a"),
  identity("2026.09.22.1", "bff286ca0eb95e56f27ff1c8f5ee26e0f759032f892d46a1106c57296e4e4850"),
  identity("2026.09.21.1", "ff60ff578397dbb49f3405762b4733adc0187b9912e8340671678351295a1469"),
  identity("2026.09.15.2", "17f367fbffbda1212fd61e4aab5e45f0646528de388b0667d0e4dc33c011711f"),
  identity("2026.09.15.1", "8c78992766b7f6f5aa499556342e3ff4e340bd5f8718850b488b4ce09e8dcf49"),
  identity("2026.09.08.2", "1660674e4927585463122666f3471de1ce7e6bc391f476c83f2fb96548f9672e"),
  identity("2026.09.07.1", "73ba80eb4007cdba90046637af0efc4712b395532a3fe890cc6a2bbb6dc322cb"),
  identity("2026.09.06.4", "a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db"),
  identity("2026.09.06.3", "5ea99797e6a1f7b105d1af07c191585c386df5590bd65a3389f045a41466dbef"),
  identity("2026.09.06.2", "9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee"),
  identity("2026.09.06.1", "61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c"),
  identity("2026.09.05.10", "c48b6f0df47743e4fd4978b3a886e1fb68ee5cc163d51781cd8c7a4a539b7860"),
  identity("2026.09.05.9", "89b5e64591d3cff0f2a4f28460ee9075221946ed37694ec5eb566c5a40af4127"),
  identity("2026.08.31.3", "8f74ff4ce921d21c84784fdff6885f2ff60b1e83b9c1f3609a95422982bc16ec"),
  identity("2026.08.31.4", "bb67d66049af310db6f91b9627bd6e0bc25543e9629c9fc264d816b7ffb7b3aa"),
  identity("2026.09.01.1", "efa15f664808c3afa5b1a36a0763d39338d20cbe03acc5c15dc8f82f8e2957b9"),
  identity("2026.09.01.2", "a0a1504fa588332adf3b5a43a88164d61f138f0de61a0d10426f5321cd81b06f"),
  identity("2026.09.01.3", "1d42b30677175bdd07939a98d219321f503b8180934df70e8d633c9243c38f67"),
  identity("2026.09.01.4", "d5b7864c3d1e02bea13ea2d129de289b82cde59389d284eaba56b64e34e1f620"),
  identity("2026.09.01.5", "986bcf1fcd3f6b0f1d7d3e6fdeec795431ec959b7540e02ce6c6b7f3a7c47cc5"),
  identity("2026.09.01.6", "96fd54d3001f8dffbe2419c55ad5669a18b0f3d6ff90bc5dab74e699e9cf8cd1"),
  identity("2026.09.01.7", "88c0c157e03a0e6f70ccd7a3d3b7e6e4ea890638210cdde53a7b39f878994314"),
  identity("2026.09.01.8", "d641a55cb724a59abf5f5453b44bd00a4078be923956b5b82f11a0fd2fbcb4e0"),
  identity("2026.09.01.9", "d2666888d06a02ec75a8edb771e32487e57f54588d527e004bfe134dedb5d246"),
  identity("2026.09.02.1", "7122d4a6b6c0ce4e498841800ad0b372a76e57ca6d67f24245f070df7a61787c"),
  identity("2026.09.02.2", "8897b6ffe01a8182536546834f2025e738435893969ea98aa9b2aff3b2f49730"),
  identity("2026.09.02.3", "78fcc31893fe1837dff872d3feb05f374532e35c568a6d99477d19f276c39374"),
  identity("2026.09.02.4", "72df19a49b746d09b73d8569512707d406c08ccf847a6896991a256a741642e3"),
  identity("2026.09.02.5", "7e91cd275b0af9c7cefe7be8345a288d503873e06858460cb7ef0be14c009944"),
  identity("2026.09.02.6", "98a08c2806a359533a7fdd9768b238bdb4c6647aaa46f48fd939aef00a02f2d2"),
  identity("2026.09.02.7", "4651a9d5d96cbc43b32462c1ff4c149db22a547e5c571f25feeb1f2c761b35c0"),
  identity("2026.09.02.8", "1b76e0a91dc9191319c8bfd519114d12934e75b89378a84113cb12d49667b999"),
  identity("2026.09.03.1", "465b0c04f930f1a33a231cb1473df3333c3344c849c561aebbef2c5ff502b499"),
  identity("2026.09.03.2", "381ba2ebcd9e47aa9f16df134a090f5268caee93972c1704c7be5e9086d22215"),
  identity("2026.09.04.1", "947ade5139187a4dc4116378b16387c5cda847639900cd397388ea62a0930778"),
  identity("2026.09.04.2", "b758765fd8de28fe3fc2c0b6aa4029579c4616ab110686778e4a814bc646ce87"),
  identity("2026.09.04.3", "5d91ff037a175eefedc0ed6def31ebe51f43cc212789e6720576356edd6527b4"),
  identity("2026.09.04.4", "b9ae70bf6469b3c0c726616f7103d7ab809730ab84726a0b7a4a37b2680622a6"),
  identity("2026.09.05.1", "38d91e8f2077f0044beaec57d1846943379a1291225cc2992e71064f63364c93"),
  identity("2026.09.05.2", "391a7ea9b299c01b65b2765824760af3d6a813aa2ae44f129dd9ffb660041b41"),
  identity("2026.09.05.3", "523d59b6e8f89a490558bedd229125e949119b4969b5233e0e12408156fdd269"),
  identity("2026.09.05.4", "cbae304443716f6677a68d398628f2f7296be5f155af8b64b1cb99b84bde250d"),
  identity("2026.09.05.5", "64f86f200ee20aa06e4ff2a56369daddd7b85a723a1688a5e113b8f16f98e596"),
  identity("2026.09.05.6", "1226dfc97e54f745b84b934e89246adc4453f85b3bdad1e14fc892d9ff5d1da4"),
  identity("2026.09.05.7", "d3631ea66b7d74084e1f29e7795f2459e6e215c4f97a6e231ccf480f3cb9ba9b"),
  identity("2026.09.08.3", "9f7d173d1912dc3001770ecbb5fc31b601660b331591b0526311f666057318f9"),
  CurrentIdentity,
  identity("2026.09.05.8", "007b9fcf9b667da3264875682d0d72feabff5729b4d7adcc168f6a2dbbcdc545"),
]);
export type ProviderNativeWorkerIdentity = z.infer<typeof Identity>;
export function parseProviderNativeWorkerIdentity(input: unknown): ProviderNativeWorkerIdentity {
  try { return Identity.parse(input); }
  catch { throw new Error("Invalid provider native worker identity"); }
}

function canonicalHostname(value: string) {
  return value.length <= 253 && value.includes(".") && /^[a-z]{2,63}$/.test(value.split(".").at(-1)!)
    && value.split(".").every(label => !label.startsWith("xn--") && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
const Hostname = z.string().refine(canonicalHostname);
const DirectHostname = z.string().regex(/^(?:[0-9]{1,3}-){3}[0-9]{1,3}\.sslip\.io$/).refine(value =>
  value.slice(0, -".sslip.io".length).split("-").every(octet => Number(octet) <= 255 && String(Number(octet)) === octet));
const Access = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("cloudflare-named"), hostname: Hostname, tunnelId: Uuid }).strict(),
  z.object({ mode: z.literal("direct-https"), hostname: DirectHostname, tunnelId: z.null() }).strict(),
]);
export type ProviderNativeAccess = z.infer<typeof Access>;
export function parseProviderNativeAccess(input: unknown): ProviderNativeAccess {
  try { return Access.parse(input); }
  catch { throw new Error("Invalid provider native access binding"); }
}
const Launch = z.object({ version: z.literal(2), agentKind: z.literal("deepseek-harness"),
  computerSubstrate: z.literal("provider-vm"), wantBrowser: z.boolean().nullable(),
  modelKey: z.literal(""), modelBaseUrl: z.literal(""), model: z.literal(""),
  publicOrigin: z.string().refine(value => value.startsWith("https://") && canonicalHostname(value.slice(8))),
  tunnelToken: z.string().regex(/^[A-Za-z0-9._=-]{1,8192}$/).nullable(), accessHostname: DirectHostname.nullable(),
}).strict().refine(value => (value.tunnelToken === null) !== (value.accessHostname === null)
  && (value.accessHostname === null || value.publicOrigin === `https://${value.accessHostname}`));
export type ProviderNativeLaunch = z.infer<typeof Launch>;
const Cleanup = z.union([
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.enum(["not_started", "verified_stopped"]), bootId: Uuid }).strict(),
]);
const Receipt = z.object({ version: z.literal(2), identity: Identity,
  state: z.enum(["unknown", "running", "stopping", "cancelled", "failed", "succeeded"]), stopped: z.boolean(), nativeCleanup: Cleanup,
}).strict().refine(value => value.stopped === ["cancelled", "failed", "succeeded"].includes(value.state)
  && (value.nativeCleanup.state === "pending" || value.stopped)
  && (value.nativeCleanup.state !== "not_started" || value.state === "cancelled"));
export type ProviderNativeWorkerReceipt = z.infer<typeof Receipt>;
export type ProviderNativeWorkerInput = { scope: FirstBootOperationScope; agentId: string; operationId: string } & (
  { action: "start"; assets: PortableProvisionerBundleAsset[]; launch: ProviderNativeLaunch; journaledHostname: string }
  | { action: "status" | "cancel"; identity: ProviderNativeWorkerIdentity }
);

/** No host/key lookup, grant acquisition or execution. The caller must pass its
 * durable access hostname, not one from the browser. Named and direct access
 * both bind the same canonical public origin BEFORE any dispatch grant.
 */
export function buildProviderNativeWorkerPlan(input: ProviderNativeWorkerInput, clock: ProviderGuestClock) {
  try {
    if (!["start", "status", "cancel"].includes(input.action)) throw new Error();
    const checkedClock = parseProviderGuestClock(`HIVRA_GUEST_CLOCK_V1 ${JSON.stringify(clock)}\n`);
    if (checkedClock.boottimeMs > Number.MAX_SAFE_INTEGER - 480_000) throw new Error();
    let launch: ProviderNativeLaunch | undefined;
    if (input.action === "start") {
      launch = Launch.parse(input.launch);
      if (launch.publicOrigin !== `https://${Hostname.parse(input.journaledHostname)}`) throw new Error();
    }
    const identity = (input.action === "start" ? CurrentIdentity : Identity).parse(input.action === "start"
      ? { version: 2, agentId: input.agentId, operationId: input.operationId,
        bundle: providerGuestBundleReceipt(input.scope, input.assets), nativeCleanup: { profile: PROFILE, closureSha256 } }
      : input.identity);
    if (identity.agentId !== input.agentId || identity.operationId !== input.operationId
      || identity.bundle.scopeSha256 !== providerGuestBundleScopeSha256(input.scope)) throw new Error();
    const request = input.action === "start"
      ? { action: input.action, identity, clock: checkedClock, manifest: providerGuestBundleManifest(input.scope, input.assets), launch }
      : { action: input.action, identity, clock: checkedClock };
    const raw = JSON.stringify(request);
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error();
    const recipe = providerGuestWorkerRecipe(identity.bundle.provisionerVersion);
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
    print("Provider native installer operation could not be verified", file=sys.stderr)
    sys.exit(1)
`;
    return { identity, script };
  } catch { throw new Error("Invalid provider native worker request"); }
}

/** Cleanup authority is distinct from installer outcome and must match the
 * guest boot sampled on this invocation. Persisting this receipt alone is not
 * a timeless readiness/delete grant or proof of whole-computer teardown.
 */
export function parseProviderNativeWorkerReceipt(output: string, expected: ProviderNativeWorkerIdentity, clock: ProviderGuestClock): ProviderNativeWorkerReceipt {
  try {
    const marker = "HIVRA_PROVIDER_WORKER_V1 "; // Existing wire marker; envelope discriminates v2.
    const checkedClock = parseProviderGuestClock(`HIVRA_GUEST_CLOCK_V1 ${JSON.stringify(clock)}\n`);
    if (Buffer.byteLength(output) > 4096 || !output.startsWith(marker) || !output.endsWith("\n")
      || output.indexOf("\n") !== output.length - 1 || output.includes("\r")) throw new Error();
    const receipt = Receipt.parse(JSON.parse(output.slice(marker.length)));
    if (JSON.stringify(receipt.identity) !== JSON.stringify(Identity.parse(expected))
      || (receipt.nativeCleanup.state !== "pending" && receipt.nativeCleanup.bootId !== checkedClock.bootId)) throw new Error();
    return receipt;
  } catch { throw new Error("Invalid provider native worker receipt"); }
}
