/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args), rpc: (...args: unknown[]) => mockRpc(...args) } }));

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  buildProviderRuntimeUpdateDispatchScript,
  buildProviderRuntimeUpdateStatusScript,
  dispatchProviderRuntimeUpdate,
  observeProviderRuntimeUpdate,
  parseProviderRuntimeUpdateStatus,
  PROVIDER_RUNTIME_UPDATE_DISPATCH_MS,
  PROVIDER_RUNTIME_UPDATE_FAILED,
  PROVIDER_RUNTIME_UPDATE_LOST,
  PROVIDER_RUNTIME_UPDATE_MAX_MS,
  PROVIDER_RUNTIME_UPDATE_NOT_STARTED,
} from "../provider-runtime-update";
import { loadPortableProvisionerBundle } from "@/lib/infrastructure/connection-preparation";

const mockFrom = jest.fn();
const mockRpc = jest.fn();
const OPERATION = { userId: "owner", agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222" };
const STARTED = Date.parse("2026-10-20T10:00:00.000Z");

function stubRow(startedAt = new Date(STARTED).toISOString()) {
  mockFrom.mockReturnValue({
    select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: {
      id: OPERATION.agentId, user_id: "owner", allocation_operation_id: "33333333-3333-4333-8333-333333333333",
      computer_substrate: "provider-vm", deployment_mode: "self-managed", proxmox_host: "__hivra_self_managed_no_ambient_authority__",
      vmid: null, infrastructure_connection_id: "44444444-4444-4444-8444-444444444444", infrastructure_connection_revision: 3,
      deployment_target_id: "55555555-5555-4555-8555-555555555555", provider_capacity_order_id: "66666666-6666-4666-8666-666666666666",
      provider_enrollment_attempt_id: "77777777-7777-4777-8777-777777777777", provider_server_id: "42",
      provider_install_identity: {}, provider_install_outcome: "succeeded", provider_install_stopped_at: "2026-10-01T00:00:00.000Z",
      cf_tunnel_id: null, cf_hostname: null, chat_url: "https://box.example", ip: "203.0.113.10",
      type: "codex", status: "provisioning", desired_state: "running", operation_id: OPERATION.operationId,
      operation_kind: "runtime_update", operation_started_at: startedAt,
    }, error: null }),
  });
}

describe("dispatch script", () => {
  let script: string;
  beforeAll(async () => {
    script = buildProviderRuntimeUpdateDispatchScript(OPERATION.operationId, await loadPortableProvisionerBundle());
  });

  it("starts with set -e for the seed transport and fits its size limit", () => {
    expect(script.startsWith("set -e\n")).toBe(true);
    expect(Buffer.byteLength(script)).toBeLessThan(1024 * 1024);
  });

  it("runs once per operation: a replayed dispatch fails at the operation's own directory", () => {
    const dir = `/var/lib/hivra/runtime-update/provider-${OPERATION.operationId}`;
    expect(script).toContain(`DIR='${dir}'`);
    expect(script).toContain('mkdir -m 0700 "$DIR"\n');
    expect(script).not.toContain("mkdir -p");
    // The marker is written only after the unit started.
    expect(script.indexOf(': > "$DIR/dispatched"')).toBeGreaterThan(script.indexOf("systemd-run "));
  });

  it("carries the reviewed guest half and every runtime file byte for byte, checked in the guest", async () => {
    const assets = new Map((await loadPortableProvisionerBundle()).map(asset => [asset.relativePath, asset.content]));
    const writes = [...script.matchAll(/^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| gunzip -c > '([^']+)'\n\[ "\$\(sha256sum '[^']+' \| cut -d' ' -f1\)" = ([0-9a-f]{64}) \]$/gm)];
    const byTarget = new Map(writes.map(([, payload, target, digest]) => [target, { content: gunzipSync(Buffer.from(payload, "base64")), digest }]));
    const dir = `/var/lib/hivra/runtime-update/provider-${OPERATION.operationId}`;
    const guest = byTarget.get(`${dir}/guest.sh`)!;
    expect(guest.content.equals(assets.get("hivra-guest-runtime-update.sh")!)).toBe(true);
    expect(guest.digest).toBe(createHash("sha256").update(guest.content).digest("hex"));
    for (const relative of ["hivra-chat/server.js", "hivra-chat/app.js", "hivra-agent-shell", "agent-cli-versions.json", "hivra-claude-app.py"]) {
      expect(byTarget.get(`${dir}/source/${relative}`)!.content.equals(assets.get(relative)!)).toBe(true);
    }
    const runner = byTarget.get(`${dir}/run.sh`)!.content.toString();
    expect(runner).toContain('/bin/bash "$DIR/guest.sh" >"$DIR/result" 2>"$DIR/error"');
    expect(runner.indexOf('mv -f "$DIR/exit.next" "$DIR/exit"')).toBeGreaterThan(runner.indexOf("guest.sh"));
  });

  it("archives each runtime file once, in the layout the guest half expects", () => {
    const tar = script.split("\n").find(line => line.startsWith("tar -czf"))!;
    expect(tar).toBe('tar -czf "$DIR/runtime.tar.gz" -C "$DIR/source/hivra-chat" server.js llm-application.js guarded-files.cjs agent-zero-editor.cjs chat-runs.cjs index.html app.js -C "$DIR/source" hivra-agent-shell bux-ttyd-base-path.conf bux-box-ttyd.service agent-cli-versions.json hivra-agent-cli-update.sh hivra-codex-config-pin.py hivra-tg-apply hivra-claude-app.py hivra-claude-app.service claude-desktop-pin.json');
  });

  it("refuses an operation id that is not a UUID", () => {
    expect(() => buildProviderRuntimeUpdateDispatchScript("../../etc", [])).toThrow();
    expect(() => buildProviderRuntimeUpdateStatusScript("x; rm -rf /")).toThrow();
  });
});

describe("status", () => {
  it.each([
    ["HIVRA_PROVIDER_RUNTIME_UPDATE_STATE absent\n", { state: "absent" }],
    ["HIVRA_PROVIDER_RUNTIME_UPDATE_STATE running\n", { state: "running" }],
    ["HIVRA_PROVIDER_RUNTIME_UPDATE_STATE lost\n", { state: "lost" }],
    ["HIVRA_PROVIDER_RUNTIME_UPDATE_STATE finished 0 1\n", { state: "finished", exitCode: 0, committed: true, agentCli: null }],
    ["HIVRA_PROVIDER_RUNTIME_UPDATE_STATE finished 1 0\n", { state: "finished", exitCode: 1, committed: false, agentCli: null }],
    ["HIVRA_PROVIDER_RUNTIME_UPDATE_STATE finished 0 1\nHIVRA_AGENT_CLI name=codex version=0.149.1 target=0.156.1 state=scheduled\n",
      { state: "finished", exitCode: 0, committed: true, agentCli: "HIVRA_AGENT_CLI name=codex version=0.149.1 target=0.156.1 state=scheduled" }],
  ])("reads %j", (output, expected) => {
    expect(parseProviderRuntimeUpdateStatus(output)).toEqual(expected);
  });

  it.each([
    "", "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE done\n", "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE running 0 1\n",
    "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE finished\n", "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE finished 0 1\nHIVRA_AGENT_CLI name=codex version=latest target=1.0.0 state=scheduled\n",
    "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE finished 0 1\nx\ny\n",
  ])("refuses %j", output => {
    expect(() => parseProviderRuntimeUpdateStatus(output)).toThrow();
  });
});

describe("dispatch and observe", () => {
  const finish = jest.fn();
  const run = jest.fn();
  const deps = (now: number) => ({ run: run as never, finish, now: () => now, bundle: async () => loadPortableProvisionerBundle() });

  beforeEach(() => {
    jest.clearAllMocks();
    finish.mockResolvedValue(true);
    stubRow();
  });

  it("reports dispatched only on the guest's own marker for this operation", async () => {
    run.mockResolvedValue({ ok: true, stdout: `HIVRA_PROVIDER_RUNTIME_UPDATE_DISPATCHED ${OPERATION.operationId}\n` });
    expect(await dispatchProviderRuntimeUpdate(OPERATION, deps(STARTED))).toBe("dispatched");
    expect(run.mock.calls[0][0]).toEqual({ userId: "owner", agentId: OPERATION.agentId });
    run.mockResolvedValue({ ok: true, stdout: "HIVRA_PROVIDER_RUNTIME_UPDATE_DISPATCHED 99999999-9999-4999-8999-999999999999\n" });
    expect(await dispatchProviderRuntimeUpdate(OPERATION, deps(STARTED))).toBe("uncertain");
    run.mockResolvedValue({ ok: false, error: "unreachable" });
    expect(await dispatchProviderRuntimeUpdate(OPERATION, deps(STARTED))).toBe("uncertain");
  });

  it.each([
    ["a committed update", "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE finished 0 1\n", 30_000, "updated", ["succeeded", null]],
    ["a failed, rolled back update", "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE finished 1 0\n", 30_000, "failed", ["failed", PROVIDER_RUNTIME_UPDATE_FAILED]],
    ["an exit without its commit line", "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE finished 0 0\n", 30_000, "failed", ["failed", PROVIDER_RUNTIME_UPDATE_FAILED]],
    ["a dispatch that never landed", "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE absent\n", PROVIDER_RUNTIME_UPDATE_DISPATCH_MS, "failed", ["failed", PROVIDER_RUNTIME_UPDATE_NOT_STARTED]],
    ["an update that stopped without finishing", "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE lost\n", PROVIDER_RUNTIME_UPDATE_DISPATCH_MS, "failed", ["failed", PROVIDER_RUNTIME_UPDATE_LOST]],
  ] as const)("settles %s", async (_name, stdout, age, stage, settled) => {
    run.mockResolvedValue({ ok: true, stdout });
    const result = await observeProviderRuntimeUpdate(OPERATION, deps(STARTED + age));
    expect(result.stage).toBe(stage);
    expect(finish).toHaveBeenCalledWith(OPERATION, settled[0], settled[1]);
  });

  it.each([
    ["still running", { ok: true, stdout: "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE running\n" }, 60_000, "updating"],
    ["not landed yet", { ok: true, stdout: "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE absent\n" }, 10_000, "updating"],
    ["briefly between unit and marker", { ok: true, stdout: "HIVRA_PROVIDER_RUNTIME_UPDATE_STATE lost\n" }, 10_000, "updating"],
    ["unreachable", { ok: false, error: "unreachable" }, 60_000, "verification_unavailable"],
    ["answering garbage", { ok: true, stdout: "nope\n" }, 60_000, "verification_unavailable"],
  ] as const)("keeps the lease while %s", async (_name, result, age, stage) => {
    run.mockResolvedValue(result);
    expect((await observeProviderRuntimeUpdate(OPERATION, deps(STARTED + age))).stage).toBe(stage);
    expect(finish).not.toHaveBeenCalled();
  });

  it("releases the lease once the update's own time limit has passed, even when unreachable", async () => {
    run.mockResolvedValue({ ok: false, error: "unreachable" });
    expect((await observeProviderRuntimeUpdate(OPERATION, deps(STARTED + PROVIDER_RUNTIME_UPDATE_MAX_MS))).stage).toBe("failed");
    expect(finish).toHaveBeenCalledWith(OPERATION, "failed", PROVIDER_RUNTIME_UPDATE_LOST);
  });

  it("never settles another operation's lease", async () => {
    mockFrom.mockReturnValue({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) });
    await expect(observeProviderRuntimeUpdate(OPERATION, deps(STARTED + 60_000))).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
});
