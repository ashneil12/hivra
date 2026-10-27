/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: jest.fn() }));
jest.mock("@/lib/agent-links/flag", () => ({ isAgentLinksEnabled: jest.fn() }));
jest.mock("@/lib/agent-links/exec", () => ({ runLinkedCommand: jest.fn(), execRefusalCopy: (reason: string) => `refused:${reason}` }));
jest.mock("@/lib/agent-links/store", () => ({
  findAgentByKey: jest.fn(), loadOwnedRow: jest.fn(), loadOwnedRows: jest.fn(), loadLinks: jest.fn(), touchLink: jest.fn(async () => undefined),
  targetState: (row: { status?: string }) => (row.status === "running" ? { ready: true } : { ready: false, reason: "stopped" }),
}));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
  apiError: (error: string, status: number) => Response.json({ success: false, error }, { status }),
}));

import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { isAgentLinksEnabled } from "@/lib/agent-links/flag";
import { runLinkedCommand } from "@/lib/agent-links/exec";
import { findAgentByKey, loadLinks, loadOwnedRow, loadOwnedRows } from "@/lib/agent-links/store";
import { GET, POST } from "../route";

const OWNER = "user_owner";
const AGENT = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: OWNER, name: "Claude", type: "claude-code" };
const STUDIO = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", user_id: OWNER, name: "Studio", type: "linux-desktop",
  computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", status: "running" };
const OTHER = { ...STUDIO, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Unlinked" };
const KEY = `hvl_${"e".repeat(64)}`;

function request(method: "GET" | "POST", body?: unknown, key: string | null = KEY) {
  return new NextRequest("https://canary.hermesos.cloud/api/agent-link", {
    method, headers: { host: "canary.hermesos.cloud", "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isHivraApiAllowed).mockReturnValue(true);
  jest.mocked(isAgentLinksEnabled).mockReturnValue(true);
  jest.mocked(findAgentByKey).mockResolvedValue({ agentId: AGENT.id, userId: OWNER });
  jest.mocked(loadOwnedRow).mockResolvedValue(AGENT as never);
  jest.mocked(loadOwnedRows).mockResolvedValue([AGENT, STUDIO, OTHER] as never);
  jest.mocked(loadLinks).mockResolvedValue([{ id: "link-1", agent_id: AGENT.id, computer_id: STUDIO.id, created_at: "x", last_used_at: null }]);
});

describe("/api/agent-link", () => {
  it("is not there off Canary", async () => {
    jest.mocked(isAgentLinksEnabled).mockReturnValue(false);
    expect((await GET(request("GET"))).status).toBe(404);
    expect(findAgentByKey).not.toHaveBeenCalled();
  });

  it("refuses a missing or unknown key", async () => {
    expect((await GET(request("GET", undefined, null))).status).toBe(401);
    jest.mocked(findAgentByKey).mockResolvedValue(null);
    expect((await POST(request("POST", { computer: "Studio", command: "ls" }))).status).toBe(401);
    expect(runLinkedCommand).not.toHaveBeenCalled();
  });

  it("refuses a key whose agent is gone", async () => {
    jest.mocked(loadOwnedRow).mockResolvedValue(null);
    expect((await GET(request("GET"))).status).toBe(401);
  });

  it("lists only the linked computers", async () => {
    const payload = await (await GET(request("GET"))).json();
    expect(payload.data.computers).toEqual([{ id: STUDIO.id, name: "Studio", kind: "Ubuntu desktop", status: "running", ready: true }]);
    expect(loadLinks).toHaveBeenCalledWith(OWNER, { agentId: AGENT.id });
  });

  it("runs a command on a linked computer by name or id, never on an unlinked one", async () => {
    jest.mocked(runLinkedCommand).mockResolvedValue({ status: "ran", exitCode: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0),
      stdoutTruncated: false, stderrTruncated: false, timedOut: false, durationMs: 3 });
    const byName = await (await POST(request("POST", { computer: "studio", command: "uname -a", stdinBase64: "aGk=", timeoutSeconds: 30 }))).json();
    expect(byName.data).toMatchObject({ exitCode: 0, stdoutBase64: Buffer.from("ok").toString("base64"), computer: { id: STUDIO.id } });
    expect(jest.mocked(runLinkedCommand).mock.calls[0][1]).toBe(STUDIO);
    expect(jest.mocked(runLinkedCommand).mock.calls[0][2]).toEqual({ command: "uname -a", stdin: Buffer.from("hi"), timeoutSeconds: 30 });
    expect((await POST(request("POST", { computer: STUDIO.id, command: "ls" }))).status).toBe(200);
    expect((await POST(request("POST", { computer: OTHER.id, command: "ls" }))).status).toBe(404);
    expect((await POST(request("POST", { computer: "Unlinked", command: "ls" }))).status).toBe(404);
    expect(runLinkedCommand).toHaveBeenCalledTimes(2);
  });

  it("refuses bad bodies and names a computer's refusal", async () => {
    expect((await POST(request("POST", { computer: "Studio", command: "ls", extra: 1 }))).status).toBe(400);
    expect((await POST(request("POST", { computer: "Studio", command: "ls", timeoutSeconds: 500 }))).status).toBe(400);
    jest.mocked(runLinkedCommand).mockResolvedValue({ status: "refused", reason: "computer_not_running" });
    const response = await POST(request("POST", { computer: "Studio", command: "ls" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("refused:computer_not_running");
  });
});
