import { NextRequest } from "next/server";

import { GET, POST } from "../route";

const mocks = {
  access: jest.fn(),
  ssh: jest.fn(),
  releases: jest.fn(),
  update: jest.fn(),
};

jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/services/console-helpers", () => ({ validateConsoleAccess: (...args: unknown[]) => mocks.access(...args) }));
jest.mock("@/lib/hetzner/ssh", () => ({ sshExec: (...args: unknown[]) => mocks.ssh(...args) }));
jest.mock("@/lib/hermes-releases/store", () => ({ loadReleases: (...args: unknown[]) => mocks.releases(...args) }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({ update: (patch: unknown) => ({ eq: () => ({ eq: () => mocks.update(patch) }) }) }),
  },
}));

const INST = "inst-1";
const DIGEST = `sha256:${"a".repeat(64)}`;
const release = {
  id: "rel-1",
  image_repo: "ghcr.io/ashneil12/hivra-hermes",
  version: "0.21.6+hivra.1",
  digest: DIGEST,
  channel: "stable",
  rollout_percent: 100,
  pilot_instance_ids: [],
  halted: false,
  created_at: "2026-10-09T00:00:00Z",
  promoted_at: "2026-10-09T00:00:00Z",
};

function access(config: Record<string, unknown> = {}, status = "running") {
  mocks.access.mockResolvedValue({
    id: INST,
    userId: "user-1",
    hostIp: "box.invalid",
    instance: { id: INST, status, backend: "gateway", release_channel: "stable", config },
    errorResponse: null,
  });
}
const params = Promise.resolve({ id: INST });
const request = (qs = "") => new NextRequest(`http://localhost/api/instances/${INST}/migrate-no-fork${qs}`);

beforeEach(() => {
  jest.clearAllMocks();
  mocks.releases.mockResolvedValue([release]);
  mocks.update.mockResolvedValue({ error: null });
  mocks.ssh.mockResolvedValue({ ok: true, stdout: "", stderr: "" });
  access();
});

describe("migrate-no-fork route", () => {
  it("offers the move without touching the box on a plain read", async () => {
    const res = await GET(request(), { params });
    const body = await res.json();
    expect(body.data.offer.available).toBe(true);
    expect(mocks.ssh).not.toHaveBeenCalled();
  });

  it("starts the move detached on the box with the registry's exact digest, only for the owner's running fork box", async () => {
    mocks.ssh.mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" }).mockResolvedValueOnce({ ok: true, stdout: "started\n", stderr: "" });
    const res = await POST(request(), { params });
    expect(res.status).toBe(202);
    const launcher = String(mocks.ssh.mock.calls[1][1]);
    expect(launcher).toContain("systemd-run --unit=hermes-nofork-migrate-inst-1");
    expect(mocks.ssh.mock.calls[1][2]).toMatchObject({ timeoutMs: 60_000 });
  });

  it("refuses when no release is offered, and changes nothing", async () => {
    mocks.releases.mockResolvedValue([]);
    const res = await POST(request(), { params });
    expect(res.status).toBe(409);
    expect(mocks.ssh).not.toHaveBeenCalled();
  });

  it("refuses a box that already follows upstream or is not running", async () => {
    access({ webuiAgentImage: "hivra-local/hermes:stable" });
    expect((await POST(request(), { params })).status).toBe(409);
    access({}, "stopped");
    expect((await POST(request(), { params })).status).toBe(409);
    expect(mocks.ssh).not.toHaveBeenCalled();
  });

  it("will not start a second move while one is running", async () => {
    mocks.ssh.mockResolvedValueOnce({ ok: true, stdout: '{"state":"running","phase":"snapshot","message":"","updatedAt":"t"}', stderr: "" });
    const res = await POST(request(), { params });
    expect(res.status).toBe(409);
    expect(mocks.ssh).toHaveBeenCalledTimes(1);
  });

  it("reports a start that did not take as a clean failure", async () => {
    mocks.ssh.mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" }).mockResolvedValueOnce({ ok: false, stdout: "", stderr: "boom" });
    const res = await POST(request(), { params });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Nothing was changed/);
  });

  it("records that the box follows upstream once the box says it is done, so no later update undoes it", async () => {
    mocks.ssh.mockResolvedValue({ ok: true, stdout: '{"state":"done","phase":"finishing","message":"ok","updatedAt":"t","toVersion":"0.21.6"}', stderr: "" });
    const res = await GET(request("?status=1"), { params });
    const body = await res.json();
    expect(body.data.progress.state).toBe("done");
    expect(mocks.update).toHaveBeenCalledWith({ config: expect.objectContaining({ webuiAgentImage: "hivra-local/hermes:stable", agentSource: "upstream-overlay" }) });
    expect(body.data.offer.alreadyUpstream).toBe(true);
  });
});
