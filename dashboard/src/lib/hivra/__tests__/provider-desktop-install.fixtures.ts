import { readFileSync } from "node:fs";
import path from "node:path";
import { receiverFixture } from "@/lib/infrastructure/__tests__/first-boot-receiver.fixtures";
import { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES } from "@/lib/infrastructure/portable-provisioner-contract";
import { buildProviderDesktopWorkerPlan } from "@/lib/infrastructure/provider-desktop-worker";
import type { ProviderDesktopInstallContext } from "../provider-desktop-install-store";

export function desktopInstallFixture(accessMode: "cloudflare-named" | "direct-https" = "cloudflare-named") {
  const f = receiverFixture(), op = { userId: f.binding.userId,
    agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const scope = { binding: f.binding, providerServerId: "42" };
  const assets = PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({ relativePath,
    content: readFileSync(path.join(process.cwd(), "provisioner", relativePath)) }));
  const context: ProviderDesktopInstallContext = { operation: op, scope, targetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    runtime: "linux-desktop", computerProfile: "ubuntu-desktop", desiredState: "running", accessMode,
    hostname: accessMode === "direct-https" ? "203-0-113-10.sslip.io" : "fixture.hivra.test",
    tunnelId: accessMode === "direct-https" ? null : "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    identity: null, stoppedAt: null, outcome: null, cancellationRequested: false };
  const request = { ...op, action: "start" as const, launch: { version: 3 as const, computerSubstrate: "provider-vm" as const,
    agentKind: "linux-desktop" as const, wantBrowser: null,
    computerId: op.agentId, controlOrigin: "https://canary.hermesos.cloud", modelKey: "" as const, modelBaseUrl: "" as const, model: "" as const,
    publicOrigin: `https://${context.hostname}`,
    tunnelToken: accessMode === "direct-https" ? null
      : Buffer.from(JSON.stringify({ a: "a".repeat(32), t: context.tunnelId, s: "private-fixture-tunnel" })).toString("base64"),
    accessHostname: accessMode === "direct-https" ? context.hostname : null } };
  const clock = { bootId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", boottimeMs: 1000 };
  const identity = buildProviderDesktopWorkerPlan({ ...request, scope, assets, authority: {computerId: op.agentId, controlOrigin: request.launch.controlOrigin,
    access: accessMode === "direct-https" ? {mode: "direct-https", hostname: context.hostname!, tunnelId: null}
      : {mode: "cloudflare-named", hostname: context.hostname!, tunnelId: context.tunnelId!}} }, clock).identity;
  const grant = { observationId: "ffffffff-ffff-4fff-8fff-ffffffffffff", budgetMs: 30000 as const };
  return { f, op, scope, assets, context, request, clock, identity, grant };
}
