import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import type { PortableProvisionerBundleAsset } from "./connection-preparation";
import type { FirstBootOperationScope } from "./first-boot-operations";
import { parseProviderGuestClock, providerGuestBundleManifest, providerGuestBundleReceipt, providerGuestBundleScopeSha256,
  PROVIDER_GUEST_BUNDLE_DIRECTORY, type ProviderGuestClock } from "./provider-guest-bundle";
import { ProviderGuestWorkerVersion, providerGuestWorkerRecipe } from "./provider-guest-worker-recipes";

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeText = (max: number) => z.string().refine(value => Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value));
const Launch = z.object({ version: z.literal(1), agentKind: z.enum(["claude", "codex", "aeon", "openclaw", "agent-zero"]),
  computerSubstrate: z.literal("provider-vm"), wantBrowser: z.boolean().nullable(), modelKey: safeText(8192),
  modelBaseUrl: safeText(2048), model: safeText(256),
  tunnelToken: z.string().regex(/^[A-Za-z0-9._=-]{1,8192}$/).nullable(),
  accessHostname: z.string().regex(/^(?:[0-9]{1,3}-){3}[0-9]{1,3}\.sslip\.io$/).max(253).nullable(),
}).strict().refine(value => (value.tunnelToken === null) !== (value.accessHostname === null));
export type ProviderGuestLaunch = z.infer<typeof Launch>;
const Identity = z.object({ version: z.literal(1), agentId: Uuid, operationId: Uuid,
  bundle: z.object({ version: z.literal(1), state: z.literal("bundle_installed"), scopeSha256: Digest,
    bundleSha256: Digest, provisionerVersion: ProviderGuestWorkerVersion }).strict(),
}).strict();
export type ProviderGuestWorkerIdentity = z.infer<typeof Identity>;
const Receipt = z.object({ version: z.literal(1), identity: Identity,
  state: z.enum(["unknown", "running", "stopping", "cancelled", "failed", "succeeded"]), stopped: z.boolean(),
}).strict().refine(value => value.stopped === ["cancelled", "failed", "succeeded"].includes(value.state));
export type ProviderGuestWorkerReceipt = z.infer<typeof Receipt>;
export type ProviderGuestWorkerInput = {
  scope: FirstBootOperationScope; agentId: string; operationId: string;
} & ({ action: "start"; assets: PortableProvisionerBundleAsset[]; launch: ProviderGuestLaunch }
  | { action: "status" | "cancel"; identity: ProviderGuestWorkerIdentity });

/** Private command builder. Caller owns the existing provider agent provision
 * operation, not a new first-boot lease. A start receipt is never readiness and
 * a lost SSH acknowledgement never authorizes releasing the operation. The
 * fixed worker journals once-only dispatch and cancellation on the computer.
 */
export function buildProviderGuestWorkerPlan(input: ProviderGuestWorkerInput, clock: ProviderGuestClock) {
  try {
    if (!["start", "status", "cancel"].includes(input.action)) throw new Error();
    const identity = Identity.parse(input.action === "start"
      ? { version: 1, agentId: input.agentId, operationId: input.operationId, bundle: providerGuestBundleReceipt(input.scope, input.assets) }
      : input.identity);
    if (identity.agentId !== input.agentId || identity.operationId !== input.operationId
      || identity.bundle.scopeSha256 !== providerGuestBundleScopeSha256(input.scope)) throw new Error();
    const recipe = providerGuestWorkerRecipe(identity.bundle.provisionerVersion);
    if (input.action === "start") {
      const worker = input.assets.find(file => file.relativePath === "hivra-provider-worker.py");
      if (!worker || worker.content.length !== recipe.workerSize
        || createHash("sha256").update(worker.content).digest("hex") !== recipe.workerSha256) throw new Error();
    }
    const checkedClock = parseProviderGuestClock(`HIVRA_GUEST_CLOCK_V1 ${JSON.stringify(clock)}\n`);
    const request = input.action === "start"
      ? { action: input.action, identity, clock: checkedClock,
        manifest: providerGuestBundleManifest(input.scope, input.assets), launch: Launch.parse(input.launch) }
      : { action: input.action, identity, clock: checkedClock };
    const raw = JSON.stringify(request);
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error();
    // Only a pinned server-owned module is executed. No request-selected path,
    // shell, environment or interpreter; payload bytes travel on SSH stdin.
    const script = `import base64, hashlib, io, os, pathlib, stat, sys
try:
    for directory in ["/", "/opt", "/opt/hivra", "/opt/hivra/provider-bundle", "${PROVIDER_GUEST_BUNDLE_DIRECTORY}"]:
        info = os.lstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError()
    path = "${PROVIDER_GUEST_BUNDLE_DIRECTORY}/hivra-provider-worker.py"
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
    print("Provider installer operation could not be verified", file=sys.stderr)
    sys.exit(1)
`;
    return { identity, script };
  } catch { throw new Error("Invalid provider guest worker request"); }
}

export function parseProviderGuestWorkerReceipt(output: string, expected: ProviderGuestWorkerIdentity): ProviderGuestWorkerReceipt {
  try {
    const marker = "HIVRA_PROVIDER_WORKER_V1 ";
    if (Buffer.byteLength(output) > 2048 || !output.startsWith(marker) || !output.endsWith("\n")
      || output.indexOf("\n") !== output.length - 1 || output.includes("\r")) throw new Error();
    const receipt = Receipt.parse(JSON.parse(output.slice(marker.length)));
    if (JSON.stringify(receipt.identity) !== JSON.stringify(Identity.parse(expected))) throw new Error();
    return receipt;
  } catch { throw new Error("Invalid provider guest worker receipt"); }
}
