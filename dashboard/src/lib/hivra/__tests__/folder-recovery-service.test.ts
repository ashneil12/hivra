jest.mock("server-only", () => ({}));
const mockRows = new Map<string, Record<string, unknown>>();
let mockPrior: Record<string, unknown> | null = null;
const mockRpc = jest.fn();
const mockRun = jest.fn();
const mockContext = jest.fn();
const mockBuild = jest.fn();
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: (table: string) => {
    const filters: Record<string, unknown> = {};
    const query = { select: () => query, neq: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      maybeSingle: async () => {
        const row = table === "hivra_agents" ? mockRows.get(String(filters.id)) : mockPrior;
        return { data: row?.user_id === filters.user_id ? row : null, error: null };
      } };
    return query;
  },
} }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: (...args: unknown[]) => mockRun(...args) }));
jest.mock("../agent-execution-context", () => ({ resolveHivraAgentExecutionContext: (...args: unknown[]) => mockContext(...args) }));
jest.mock("../folder-recovery-host", () => ({
  ...jest.requireActual("../folder-recovery-host"),
  buildFolderRecoveryHostScript: (...args: unknown[]) => mockBuild(...args),
}));

import { exportComputerFolder, restoreComputerFolder } from "../folder-recovery-service";
import { encryptFolderRecovery, FOLDER_RECOVERY_FORMAT, sha256FolderBytes, type FolderRecoveryPayload } from "../folder-recovery-artifact";

const source = "11111111-1111-4111-8111-111111111111";
const dest = "22222222-2222-4222-8222-222222222222";
const operation = "33333333-3333-4333-8333-333333333333";
const passphrase = "test folder recovery passphrase";
const payload: FolderRecoveryPayload = { format: FOLDER_RECOVERY_FORMAT, scope: "/home/bux/Hivra",
  source: { agentId: source, bindingHash: "a".repeat(64) }, exportedAt: "2026-09-05T12:00:00Z",
  entries: [{ kind: "file", path: "file", content: Buffer.from("bytes").toString("base64"), sha256: sha256FolderBytes(Buffer.from("bytes")), executable: false }] };
const ok = (data: Record<string, unknown>) => ({ ok: true, stdout: `HIVRA_FOLDER_RESULT ${JSON.stringify(data)}\n`, stderr: "" });
let artifact: Buffer;

beforeEach(async () => {
  mockRows.clear(); mockPrior = null; mockRun.mockReset(); mockRpc.mockReset(); mockContext.mockReset(); mockBuild.mockReset();
  for (const [id, hash, token, vmid] of [[source,"a","source-token",1001],[dest,"b","fresh-token",1002]]) {
    mockRows.set(String(id), { id, user_id: "owner", type: "linux-desktop", computer_profile: "ubuntu-desktop",
      computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true,
      infrastructure_binding_token_hash: String(hash).repeat(64), api_token: token, vmid,
      ip: "10.241.0.2", status: "running", desired_state: "running", operation_id: null });
  }
  mockContext.mockResolvedValue({ env: { EXACT_HOST: "fixture" }, infrastructureBindingTagEnforced: true,
    infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`, paths: { vmSshKeyPath: "/fixture/key" } });
  mockBuild.mockImplementation((_target, request) => JSON.stringify(request));
  mockRpc.mockImplementation(async (name) => ({ error: null, data: name === "begin_hivra_folder_recovery" ? operation : true }));
  artifact = await encryptFolderRecovery(payload, passphrase);
  mockRun.mockImplementation(async (script) => {
    const request = JSON.parse(script);
    return request.action === "export" ? ok({ entries: [] })
      : ok({ verified: true, operationId: operation, artifactSha256: sha256FolderBytes(artifact), files: 1, bytes: 5 });
  });
});
function restore(overrides = {}) {
  return restoreComputerFolder({ userId: "owner", sourceId: source, destinationId: dest, artifact, passphrase, revokeSourceSessions: true, ...overrides });
}

describe("folder recovery orchestration", () => {
  it("claims only after empty-folder inspection and completes only after exact guest hash evidence", async () => {
    await expect(restore()).resolves.toMatchObject({ destinationId: dest, files: 1, bytes: 5 });
    expect(mockRun.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[0]);
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockRun.mock.invocationCallOrder[1]);
    expect(mockRun.mock.invocationCallOrder[1]).toBeLessThan(mockRpc.mock.invocationCallOrder[1]);
    expect(mockRpc).toHaveBeenLastCalledWith("complete_hivra_folder_recovery", expect.objectContaining({ p_operation_id: operation, p_file_count: 1, p_byte_count: 5 }));
    expect(mockBuild).toHaveBeenLastCalledWith(expect.objectContaining({ vmid: 1002 }), expect.objectContaining({ tokenSha256: sha256FolderBytes(Buffer.from("fresh-token")) }));
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain(passphrase);
    expect(JSON.stringify(mockRun.mock.calls)).not.toContain(passphrase);
  });
  it("does not claim or dispatch without explicit source-session consent", async () => {
    await expect(restore({ revokeSourceSessions: false })).rejects.toThrow("Confirm");
    expect(mockRpc).not.toHaveBeenCalled(); expect(mockRun).not.toHaveBeenCalled();
  });
  it("rejects foreign ownership, same-source, changed source binding and reused gateway identity", async () => {
    await expect(restore({ userId: "stranger" })).rejects.toThrow("not found");
    await expect(restore({ destinationId: source })).rejects.toThrow("different");
    await expect(restore({ sourceId: dest })).rejects.toThrow("different original");
    mockRows.get(source)!.infrastructure_binding_token_hash = "c".repeat(64);
    await expect(restore()).rejects.toThrow("identity");
    mockRows.get(source)!.infrastructure_binding_token_hash = "a".repeat(64);
    mockRows.get(dest)!.api_token = "source-token";
    await expect(restore()).rejects.toThrow("identity");
    expect(mockRun).not.toHaveBeenCalled();
  });
  it("rejects nonempty destination before taking a lease", async () => {
    mockRun.mockResolvedValue(ok({ entries: payload.entries }));
    await expect(restore()).rejects.toThrow("must be empty");
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("does not dispatch after losing the durable operation claim", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "55000" } });
    await expect(restore()).rejects.toThrow("Nothing new was dispatched");
    expect(mockRun).toHaveBeenCalledTimes(1);
  });
  it("retains uncertain or mismatched host outcomes; never clears a lease or revokes sessions blindly", async () => {
    mockRun.mockResolvedValueOnce(ok({ entries: [] })).mockResolvedValueOnce({ ok: false, stdout: "", stderr: "sensitive-output" });
    await expect(restore()).rejects.toThrow("remains recorded");
    expect(mockRpc).toHaveBeenCalledTimes(1);
    mockRun.mockReset().mockResolvedValueOnce(ok({ entries: [] })).mockResolvedValueOnce(ok({ verified: true, operationId: operation, artifactSha256: "wrong", files: 1, bytes: 5 }));
    await expect(restore()).rejects.toThrow("remains recorded");
    expect(mockRpc.mock.calls.every(([name]) => name === "begin_hivra_folder_recovery")).toBe(true);
  });
  it("resumes only the persisted exact operation, and a completed replay does not revoke new source sessions", async () => {
    mockPrior = { id: operation, user_id: "owner", status: "pending" };
    await expect(restore()).resolves.toMatchObject({ resumed: true });
    expect(mockRun).toHaveBeenCalledTimes(1);
    mockPrior.status = "complete"; mockRun.mockClear(); mockRpc.mockClear();
    await expect(restore()).resolves.toMatchObject({ resumed: true });
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("begin_hivra_folder_recovery", expect.anything());
  });
  it("export preserves sessions and never writes a recovery journal", async () => {
    mockRun.mockResolvedValue(ok({ entries: payload.entries }));
    await expect(exportComputerFolder("owner", source, passphrase)).resolves.toBeInstanceOf(Buffer);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockBuild).toHaveBeenCalledWith(expect.anything(), { action: "export" });
  });
});
