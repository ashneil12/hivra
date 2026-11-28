import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";

import release from "../../../../../../../provisioner-releases/2026.11.28.3.json";
import { CANARY_MEMORY_QA_CLONE_PROVISIONER } from "@/lib/infrastructure/host-capacity-policy";

const mockGrant = jest.fn();
const mockGrantRpc = jest.fn();
const mockHostTable = jest.fn();
const mockCpuPolicy = jest.fn();
const mockResolveHost = jest.fn();
const mockRunHostScript = jest.fn();

jest.mock("@/lib/hivra/canary-memory-overcommit", () => ({
  readCanaryMemoryOvercommit: (...args: unknown[]) => mockGrant(...args),
}));
jest.mock("@/lib/logger", () => ({ log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => mockGrantRpc(...args),
    from: (...args: unknown[]) => mockHostTable(...args),
  },
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: (...args: unknown[]) => mockResolveHost(...args),
  runProxmoxHostScript: (...args: unknown[]) => mockRunHostScript(...args),
}));

import { POST } from "../route";

const ORIGINAL_ENV = process.env;
const TOKEN = "qa-clone-fixture-secret";
const HOST = "fixture-node-a";
const TEMPLATE_VMID = 9051;
const hostEnv = { PROXMOX_NODE: HOST, PROXMOX_SSH_HOST: "192.0.2.11" };
const hostRow = { total_cpu: 12, reserved_cpu: 2, cpu_overcommit_ratio: 5 };
const body = {
  apply: true,
  ownerId: "user_fixture1",
  vmid: 9310,
  tag: `hivra-qa-mem-${"a".repeat(32)}`,
  templateConfigSha256: "b".repeat(64),
};
const qualification = { action: "qualify", apply: true, ownerId: body.ownerId, vmid: body.vmid, tag: body.tag };

function request(payload: unknown = body, token: string | null = TOKEN) {
  return new NextRequest("https://canary.hermesos.cloud/api/ops/hivra/canary-memory-qa-clone", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
}

function grant(measuredGuests: string[] = [`${body.vmid}:${body.tag}`]) {
  return {
    hostId: HOST,
    qaTemplateVmid: TEMPLATE_VMID,
    measuredGuests, ratioMilli: 1180, validUntilEpoch: Math.floor(Date.now() / 1000) + 60,
    pressureBaseline: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:0:123:0:7",
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockResolveHost.mockReturnValue({ env: hostEnv });
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    maybeSingle: mockCpuPolicy,
  };
  mockHostTable.mockReturnValue(query);
  mockCpuPolicy.mockResolvedValue({ data: hostRow, error: null });
  process.env = {
    ...ORIGINAL_ENV,
    CRON_SECRET: TOKEN,
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
    VERCEL_GIT_COMMIT_REF: "canary",
    VERCEL_GIT_REPO_OWNER: "ashneil12",
    VERCEL_GIT_REPO_SLUG: "hivra",
    HIVRA_MANAGED_PROVISIONER_CHANNEL: "canary",
  };
});

afterEach(() => { process.env = ORIGINAL_ENV; });

it.each([null, "wrong"])("requires the operator bearer before reading a grant (%s)", async token => {
  expect((await POST(request(body, token))).status).toBe(401);
  expect(mockGrant).not.toHaveBeenCalled();
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it("fails closed if no operator secret is configured", async () => {
  delete process.env.CRON_SECRET;
  expect((await POST(request())).ok).toBe(false);
  expect(mockGrant).not.toHaveBeenCalled();
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it.each([
  ["VERCEL_ENV", "preview"],
  ["VERCEL_GIT_COMMIT_REF", "main"],
  ["VERCEL_GIT_REPO_OWNER", "other"],
  ["VERCEL_PROJECT_PRODUCTION_URL", "hivra.cloud"],
  ["HIVRA_MANAGED_PROVISIONER_CHANNEL", "default"],
  ["HIVRA_MANAGED_PROVISIONER_CHANNEL", undefined],
] as const)("refuses a valid bearer outside Git Canary's provisioner lane (%s=%s)", async (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  expect((await POST(request())).ok).toBe(false);
  expect(mockGrant).not.toHaveBeenCalled();
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it.each([null, undefined, "9051", 9390, 9051.5])("fails closed without a valid DB-authorized QA template (%s)", async qaTemplateVmid => {
  const selected = grant();
  mockGrant.mockImplementationOnce(jest.requireActual<typeof import("@/lib/hivra/canary-memory-overcommit")>(
    "@/lib/hivra/canary-memory-overcommit",
  ).readCanaryMemoryOvercommit);
  mockGrantRpc.mockResolvedValueOnce({ error: null, data: {
    host_id: selected.hostId, qa_template_vmid: qaTemplateVmid, measured_guests: selected.measuredGuests,
    ratio_milli: selected.ratioMilli, valid_until_epoch: selected.validUntilEpoch, pressure_baseline: selected.pressureBaseline,
  } });
  expect((await POST(request())).ok).toBe(false);
  expect(mockGrant).toHaveBeenCalledWith({
    host: null, ownerId: body.ownerId, channel: "canary", bundleVersion: CANARY_MEMORY_QA_CLONE_PROVISIONER,
  });
  expect(mockGrantRpc).toHaveBeenCalledWith("get_hivra_canary_memory_overcommit", {
    p_host_id: null, p_owner_id: body.ownerId,
  });
  expect(mockHostTable).not.toHaveBeenCalled();
  expect(mockResolveHost).not.toHaveBeenCalled();
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it.each([
  [{ apply: false }], [{ apply: "true" }], [{ ownerId: "arbitrary" }], [{ vmid: "9310" }],
  [{ vmid: 9299 }], [{ vmid: 9302 }], [{ vmid: 9400 }],
  [{ tag: "hivra-bind-" + "a".repeat(32) }], [{ templateConfigSha256: "not-a-digest" }],
  [{ ratioMilli: 1250 }], [{ validUntilEpoch: 5000000000 }], [{ host: "fixture-node-b" }], [{ measuredGuests: [] }],
  [{ cpuBudgetMilli: 100000 }], [{ templateVmid: 9052 }], [{ action: "wake" }], [{ action: "qualify" }],
])("rejects noncanonical bodies or client-supplied authority: %j", async change => {
  expect((await POST(request({ ...body, ...change }))).status).toBe(400);
  expect(mockGrant).not.toHaveBeenCalled();
  expect(mockHostTable).not.toHaveBeenCalled();
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it.each<[string[] | null]>([
  [null],
  [[`9311:${body.tag}`]],
  [[`${body.vmid}:hivra-qa-mem-${"c".repeat(32)}`]],
])("does not reach a host without an exact VMID and tag grant (%j)", async entries => {
  mockGrant.mockResolvedValue(entries ? grant(entries) : null);
  expect((await POST(request())).ok).toBe(false);
  expect(mockGrant).toHaveBeenCalledWith({
    host: null, ownerId: body.ownerId, channel: "canary", bundleVersion: CANARY_MEMORY_QA_CLONE_PROVISIONER,
  });
  expect(mockHostTable).not.toHaveBeenCalled();
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it("does not dispatch a matching VMID and tag after the grant expires", async () => {
  mockGrant.mockResolvedValue({ ...grant(), validUntilEpoch: Math.floor(Date.now() / 1000) - 1 });
  expect((await POST(request())).ok).toBe(false);
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it("does not dispatch without an active CPU policy row for the DB-authorized host", async () => {
  mockGrant.mockResolvedValue(grant());
  mockCpuPolicy.mockResolvedValue({ data: null, error: null });
  expect((await POST(request())).ok).toBe(false);
  expect(mockHostTable).toHaveBeenCalledWith("proxmox_hosts");
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it("binds the exact sealed Canary wrapper to the host and template from the DB grant", async () => {
  const selected = grant();
  mockGrant.mockResolvedValue(selected);
  mockRunHostScript.mockResolvedValue({ ok: true, stdout: `HIVRA_CANARY_MEMORY_QA_RUNNING_FULL_CHARGE ${body.vmid} ${body.tag}\n`, stderr: "" });

  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { host: HOST, vmid: body.vmid, tag: body.tag, state: "running_full_charge" } });

  expect(mockHostTable).toHaveBeenCalledWith("proxmox_hosts");
  const query = mockHostTable.mock.results[0].value;
  expect(query.select).toHaveBeenCalledWith("total_cpu,reserved_cpu,cpu_overcommit_ratio");
  expect(query.eq.mock.calls).toEqual([["id", HOST], ["status", "active"]]);
  expect(query.is).toHaveBeenCalledWith("decommissioned_at", null);
  expect(mockResolveHost).toHaveBeenCalledWith(process.env, HOST);
  expect(mockRunHostScript).toHaveBeenCalledTimes(1);
  const [script, env, options] = mockRunHostScript.mock.calls[0];
  expect(env).toBe(hostEnv);
  expect(options).toMatchObject({ timeoutMs: 210_000 });
  const manifest = [...release.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => `${file.sha256}  ${file.path}\n`).join("");
  expect(script).toContain(createHash("sha256").update(manifest).digest("hex"));
  expect(script).toContain("sha256sum -c --status BUNDLE.sha256");
  expect(script).toContain("hivra-canary-memory-qa-clone.sh");
  expect(script).toMatch(/exec 8>>\/run\/lock\/hivra-allocation\.lock[\s\S]*flock -x -w 40 8[\s\S]*sha256sum -c --status BUNDLE\.sha256[\s\S]*bash "\$PROVISIONER_DIR\/hivra-canary-memory-qa-clone\.sh"/);
  expect(script).toContain("/root/hivra-provisioner-canary");
  expect(script).toContain(body.templateConfigSha256);
  expect(script).toContain(`start '${body.ownerId}' ${body.vmid} '${body.tag}' ${TEMPLATE_VMID} '${body.templateConfigSha256}' 40000`);
  expect(script).toContain(`HIVRA_CAPACITY_CANARY_HOST_ID='${HOST}'`);
  expect(script).toContain(`HIVRA_CAPACITY_CANARY_OVERCOMMIT_MILLI=${selected.ratioMilli}`);
  expect(script).toContain(`HIVRA_CAPACITY_CANARY_OVERCOMMIT_UNTIL=${selected.validUntilEpoch}`);
  expect(script).toContain(`${body.vmid}:${body.tag}`);
  expect(script).toContain(`HIVRA_CAPACITY_CANARY_PRESSURE_BASELINE='${selected.pressureBaseline}'`);
  expect(script).not.toContain(TOKEN);
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })).toMatchObject({ status: 0, stderr: "" });
});

it.each([
  { ok: false, stdout: `HIVRA_CANARY_MEMORY_QA_RUNNING ${body.vmid} ${body.tag}\n` },
  { ok: true, stdout: `HIVRA_CANARY_MEMORY_QA_RUNNING ${body.vmid} ${body.tag}\n` },
  { ok: true, stdout: `HIVRA_CANARY_MEMORY_QA_RUNNING_FULL_CHARGE 9311 ${body.tag}\n` },
  { ok: true, stdout: `noise HIVRA_CANARY_MEMORY_QA_RUNNING_FULL_CHARGE ${body.vmid} ${body.tag}\n` },
])("does not report success without a successful exact host receipt (%j)", async result => {
  mockGrant.mockResolvedValue(grant());
  mockRunHostScript.mockResolvedValue({ ...result, stderr: "opaque host diagnostics" });
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("opaque host diagnostics");
  expect(mockRunHostScript).toHaveBeenCalledTimes(1);
});

it("requires a fresh exact owner grant before dispatching explicit qualification", async () => {
  mockGrant.mockResolvedValue(null);
  const response = await POST(request(qualification));
  expect(response.status).toBe(409);
  expect(mockGrant).toHaveBeenCalledWith({
    host: null, ownerId: body.ownerId, channel: "canary", bundleVersion: CANARY_MEMORY_QA_CLONE_PROVISIONER,
  });
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it("qualifies the exact existing fixture without reading CPU placement or asking the host to start it", async () => {
  mockGrant.mockResolvedValue(grant());
  mockRunHostScript.mockResolvedValue({ ok: true, stdout: `HIVRA_CANARY_MEMORY_QA_QUALIFIED ${body.vmid} ${body.tag}\n`, stderr: "" });
  const response = await POST(request(qualification));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { host: HOST, vmid: body.vmid, tag: body.tag, state: "qualified" } });
  expect(mockHostTable).not.toHaveBeenCalled();
  expect(mockRunHostScript).toHaveBeenCalledTimes(1);
  const [script] = mockRunHostScript.mock.calls[0];
  expect(script).toContain(`hivra-canary-memory-qa-clone.sh" qualify '${body.ownerId}' ${body.vmid} '${body.tag}' ${TEMPLATE_VMID}`);
  expect(script).not.toContain(body.templateConfigSha256);
});

it("never reports a start acknowledgment as qualification", async () => {
  mockGrant.mockResolvedValue(grant());
  mockRunHostScript.mockResolvedValue({ ok: true, stdout: `HIVRA_CANARY_MEMORY_QA_RUNNING_FULL_CHARGE ${body.vmid} ${body.tag}\n`, stderr: "" });
  expect((await POST(request(qualification))).status).toBe(503);
});
