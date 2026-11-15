import { NextRequest } from "next/server";

const mockEnable = jest.fn();
const mockRollback = jest.fn();
const mockStatus = jest.fn();

jest.mock("@/lib/hivra/ingress/enable", () => ({ enableHostIngress: (...args: unknown[]) => mockEnable(...args) }));
jest.mock("@/lib/hivra/ingress/rollback", () => ({
  rollbackHostIngress: (...args: unknown[]) => mockRollback(...args),
  readHostIngressStatus: (...args: unknown[]) => mockStatus(...args),
}));

import { POST as enablePOST } from "../enable/route";
import { POST as rollbackPOST } from "../rollback/route";
import { GET as statusGET } from "../status/route";

const ORIGINAL_ENV = process.env;
const AGENT = "11111111-1111-4111-8111-111111111111";

function post(name: string, body: unknown, bearer = "expected-value") {
  return new NextRequest(`http://localhost/api/ops/hivra/ingress/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ops host ingress routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "expected-value" };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it.each([["enable", enablePOST], ["rollback", rollbackPOST]] as const)("%s needs the operator bearer and an agent UUID", async (name, handler) => {
    expect((await handler(post(name, { agent_id: AGENT }, "wrong"))).status).toBe(401);
    expect((await handler(post(name, { agent_id: "nope" }))).status).toBe(400);
    expect(mockEnable).not.toHaveBeenCalled();
    expect(mockRollback).not.toHaveBeenCalled();
  });

  it("enable passes the agent through and maps a refusal to its status", async () => {
    mockEnable.mockResolvedValueOnce({ ok: false, reason: "ingress_off", httpStatus: 409, steps: [] });
    const refused = await enablePOST(post("enable", { agent_id: AGENT.toUpperCase() }));
    expect(refused.status).toBe(409);
    expect(mockEnable).toHaveBeenCalledWith(AGENT);
    mockEnable.mockResolvedValueOnce({ ok: true, mode: "host", phase: "cutover", steps: [] });
    expect((await enablePOST(post("enable", { agent_id: AGENT }))).status).toBe(200);
  });

  it("rollback answers 200 when the agent is back on its computer", async () => {
    mockRollback.mockResolvedValueOnce({ ok: true, mode: "guest", phase: "rolled_back", steps: [] });
    expect((await rollbackPOST(post("rollback", { agent_id: AGENT }))).status).toBe(200);
  });

  it("refuses without CRON_SECRET", async () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "" };
    expect((await enablePOST(post("enable", { agent_id: AGENT }))).status).toBe(500);
  });

  it("status is read-only and needs the bearer", async () => {
    const get = (bearer: string, id = AGENT) => new NextRequest(`http://localhost/api/ops/hivra/ingress/status?agent_id=${id}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect((await statusGET(get("wrong"))).status).toBe(401);
    expect((await statusGET(get("expected-value", "x"))).status).toBe(400);
    mockStatus.mockResolvedValueOnce({ agentId: AGENT, row: null, host: null, connectors: null });
    const ok = await statusGET(get("expected-value"));
    expect(ok.status).toBe(200);
    expect(mockStatus).toHaveBeenCalledWith(AGENT);
  });
});
