/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/agent-setup/store", () => ({
  createSetupRequest: jest.fn(), findSetupBySecret: jest.fn(), findLaunchedAgent: jest.fn(), claimSetupRequest: jest.fn(),
}));
jest.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
  apiError: (error: string, status: number) => Response.json({ success: false, error }, { status }),
}));

import { auth } from "@clerk/nextjs/server";
import { claimSetupRequest, createSetupRequest, findLaunchedAgent, findSetupBySecret } from "@/lib/agent-setup/store";
import { POST as create } from "../route";
import { GET as poll } from "../[id]/route";
import { POST as claim } from "../claim/route";

const ORIGIN = "https://canary.hermesos.cloud";
const ID = "11111111-1111-4111-8111-111111111111";
const POLL_VALUE = `hivra_setup_${"x".repeat(32)}`;
const ROW = {
  id: ID, code: "ABCDEFGH", agent: "claude-code", inference: "venice", client: "Claude Code",
  user_id: null, claimed_at: null, agent_id: null, created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
};

let ip = 0;
function post(path: string, body: unknown) {
  ip += 1;
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${ip}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function get(id: string, value: string | null) {
  ip += 1;
  return new NextRequest(`${ORIGIN}/api/agent-setup/${id}`, {
    headers: { "x-forwarded-for": `10.0.1.${ip}`, ...(value ? { "x-hivra-setup-token": value } : {}) },
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.HIVRA_AGENT_SETUP_HANDSHAKE = "1";
  jest.mocked(createSetupRequest).mockResolvedValue({ row: ROW, secret: POLL_VALUE });
});
afterAll(() => { delete process.env.HIVRA_AGENT_SETUP_HANDSHAKE; });

describe("POST /api/agent-setup", () => {
  it("is not there while the switch is off", async () => {
    process.env.HIVRA_AGENT_SETUP_HANDSHAKE = "";
    expect((await create(post("/api/agent-setup", {}))).status).toBe(404);
    expect(createSetupRequest).not.toHaveBeenCalled();
  });

  it("opens a request and answers with the link, code and poll details", async () => {
    const res = await create(post("/api/agent-setup", { agent: "claude-code", inference: "venice", client: "Claude Code" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { data } = await res.json();
    expect(data).toMatchObject({
      id: ID, code: "ABCD-EFGH", approveUrl: `${ORIGIN}/dashboard/agent-setup/ABCDEFGH`,
      pollUrl: `${ORIGIN}/api/agent-setup/${ID}`, pollHeader: "x-hivra-setup-token", pollSecret: POLL_VALUE, pollEverySeconds: 5,
    });
    expect(createSetupRequest).toHaveBeenCalledWith({ agent: "claude-code", inference: "venice", client: "Claude Code" });
  });

  it("accepts an empty body", async () => {
    expect((await create(post("/api/agent-setup", ""))).status).toBe(201);
  });

  it("refuses bad JSON and unknown values", async () => {
    expect((await create(post("/api/agent-setup", "{nope"))).status).toBe(400);
    expect((await create(post("/api/agent-setup", { agent: "windows" }))).status).toBe(400);
    expect(createSetupRequest).not.toHaveBeenCalled();
  });

  it("limits one address to 10 requests an hour", async () => {
    const same = () => new NextRequest(`${ORIGIN}/api/agent-setup`, { method: "POST", headers: { "x-forwarded-for": "10.9.9.9" }, body: "{}" });
    for (let i = 0; i < 10; i += 1) expect((await create(same())).status).toBe(201);
    expect((await create(same())).status).toBe(429);
  });

  it("says to use the plain link when the store fails", async () => {
    jest.mocked(createSetupRequest).mockRejectedValue(new Error("down"));
    const res = await create(post("/api/agent-setup", {}));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("plain Launch link");
  });
});

describe("GET /api/agent-setup/:id", () => {
  it("answers 404 for a missing secret, a bad id or a wrong secret", async () => {
    expect((await poll(get(ID, null), params(ID))).status).toBe(404);
    expect((await poll(get("nope", POLL_VALUE), params("nope"))).status).toBe(404);
    jest.mocked(findSetupBySecret).mockResolvedValue(null);
    expect((await poll(get(ID, "wrong"), params(ID))).status).toBe(404);
  });

  it("reports the launched agent with its link", async () => {
    jest.mocked(findSetupBySecret).mockResolvedValue({ ...ROW, user_id: "user_1", claimed_at: new Date().toISOString() });
    jest.mocked(findLaunchedAgent).mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222", name: "Claude Code", type: "claude-code", status: "running" });
    const res = await poll(get(ID, POLL_VALUE), params(ID));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.status).toBe("ready");
    expect(data.agent.url).toBe(`${ORIGIN}/dashboard/agent/22222222-2222-4222-8222-222222222222`);
    expect(findSetupBySecret).toHaveBeenCalledWith(ID, POLL_VALUE);
  });

  it("is not there while the switch is off", async () => {
    process.env.HIVRA_AGENT_SETUP_HANDSHAKE = "0";
    expect((await poll(get(ID, POLL_VALUE), params(ID))).status).toBe(404);
    expect(findSetupBySecret).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent-setup/claim", () => {
  it("needs a signed-in person", async () => {
    jest.mocked(auth).mockResolvedValue({ userId: null } as never);
    expect((await claim(post("/api/agent-setup/claim", { code: "ABCD-EFGH" }))).status).toBe(401);
  });

  it("ties the request to the person and answers with the Launch link", async () => {
    jest.mocked(auth).mockResolvedValue({ userId: "user_1" } as never);
    jest.mocked(claimSetupRequest).mockResolvedValue({ ...ROW, user_id: "user_1", claimed_at: new Date().toISOString() });
    const res = await claim(post("/api/agent-setup/claim", { code: "abcd-efgh" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.launchPath).toBe("/dashboard/launch?agent=claude-code&inference=venice&ref=agent-setup");
    expect(claimSetupRequest).toHaveBeenCalledWith("ABCDEFGH", "user_1");
  });

  it("refuses a bad, expired or someone else's code", async () => {
    jest.mocked(auth).mockResolvedValue({ userId: "user_1" } as never);
    expect((await claim(post("/api/agent-setup/claim", { code: "nope" }))).status).toBe(400);
    jest.mocked(claimSetupRequest).mockResolvedValue(null);
    expect((await claim(post("/api/agent-setup/claim", { code: "ABCDEFGH" }))).status).toBe(410);
  });
});
