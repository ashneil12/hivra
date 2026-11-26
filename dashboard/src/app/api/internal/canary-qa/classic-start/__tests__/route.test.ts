jest.mock("server-only", () => ({}));
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockedAuth() }));

import { POST } from "../route";

const mockedAuth = jest.fn();
const origin = "https://canary.hermesos.cloud";
const routeUrl = `${origin}/api/internal/canary-qa/classic-start`;
const prefix = "HIVRA_CANARY_QA_CLASSIC_START_";
const fixture = {
  ownerId: "user_testowner",
  instanceId: "22222222-2222-4222-8222-222222222222",
  hostId: "test-host",
  vmid: 1234,
  operationId: "11111111-1111-4111-8111-111111111111",
};
const { instanceId, ...scope } = fixture;
const claim = { status: "claimed", action: "start", ...scope };
const receipt = { status: "settled", operationId: fixture.operationId, outcome: "performed" };
const hostReceipt = { ...fixture, outcome: "performed" };
const databaseUrl = "https://db.example.invalid/rest/v1";
const hostUrl = "https://host.example.invalid/restricted/start";
const hostBearer = "fixture-host-token";
const gatewayKey = "fixture-gateway-key";

function testJwt(role: string) {
  const encoded = Buffer.from(JSON.stringify({ role })).toString("base64url");
  return `fixture.${encoded}.fixture`;
}

const postgrestBearer = testJwt("hivra_canary_qa_testgeneration");
const body = JSON.stringify({ operationId: fixture.operationId });

function request(raw = body, overrides: Record<string, string | null> = {}, url = routeUrl) {
  const headers = new Headers({ origin, "sec-fetch-site": "same-origin", "content-type": "application/json" });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return new Request(url, { method: "POST", headers, body: raw });
}

function setConfig(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[`${prefix}${key}`];
  else process.env[`${prefix}${key}`] = value;
}

describe("Canary QA Classic Start route", () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.replaceProperty(process, "env", {
      NODE_ENV: "test",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
      VERCEL_GIT_COMMIT_REF: "canary",
      VERCEL_GIT_REPO_OWNER: "ashneil12",
      VERCEL_GIT_REPO_SLUG: "hivra",
      NEXT_PUBLIC_SUPABASE_URL: new URL(databaseUrl).origin,
      SUPABASE_SERVICE_ROLE_KEY: "test-legacy-placeholder",
    });
    Object.entries({
      ENABLED: "true",
      OWNER_ID: fixture.ownerId,
      INSTANCE_ID: instanceId,
      HOST_ID: fixture.hostId,
      VMID: String(fixture.vmid),
      POSTGREST_URL: databaseUrl,
      POSTGREST_BEARER: postgrestBearer,
      POSTGREST_GATEWAY_KEY: gatewayKey,
      HOST_URL: hostUrl,
      HOST_BEARER: hostBearer,
    }).forEach(([key, value]) => setConfig(key, value));
    mockedAuth.mockReset().mockResolvedValue({ userId: fixture.ownerId });
    fetchMock = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
  });

  afterEach(() => jest.restoreAllMocks());

  it("is hidden by default and never enables on a noncanonical deployment", async () => {
    setConfig("ENABLED", undefined);
    const off = await POST(request());
    expect(off.status).toBe(404);
    expect(off.headers.get("Cache-Control")).toBe("no-store");
    setConfig("ENABLED", "true");
    process.env.VERCEL_GIT_COMMIT_REF = "main";
    expect((await POST(request())).status).toBe(404);
    expect(mockedAuth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["POSTGREST_BEARER", undefined],
    ["POSTGREST_BEARER", testJwt("service_role")],
    ["POSTGREST_BEARER", testJwt("hivra_canary_qa_")],
    ["HOST_BEARER", postgrestBearer],
    ["HOST_URL", undefined],
    ["HOST_URL", "http://host.example.invalid/restricted/start"],
    ["POSTGREST_URL", "https://user:pass@db.example.invalid/rest/v1"],
    ["POSTGREST_URL", "https://other.example.invalid/rest/v1"],
    ["POSTGREST_URL", "https://db.example.invalid/wrong"],
    ["POSTGREST_BEARER", testJwt("hivra_canary_qa_test_generation")],
    ["POSTGREST_GATEWAY_KEY", "test-legacy-placeholder"],
    ["HOST_BEARER", "test-legacy-placeholder"],
    ["OWNER_ID", "not-a-clerk-owner"],
    ["HOST_ID", "not:a:host"],
    ["INSTANCE_ID", "invalid"],
    ["VMID", "99"],
    ["VMID", "1.5"],
  ])("is hidden for invalid %s without falling back to other server config", async (key, value) => {
    setConfig(key, value);
    expect((await POST(request())).status).toBe(404);
    expect(mockedAuth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ origin: null }, routeUrl],
    [{ origin: "https://box.example.invalid" }, routeUrl],
    [{ origin: "null" }, routeUrl],
    [{ "sec-fetch-site": "same-site" }, routeUrl],
    [{ origin }, routeUrl.replace(origin, "https://other.example.invalid")],
  ])("denies noncanonical or non-same-origin requests before auth", async (headers, url) => {
    expect((await POST(request(body, headers, url))).status).toBe(403);
    expect(mockedAuth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a Clerk session for the exact standing owner", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: null }).mockResolvedValueOnce({ userId: "user_other" });
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request())).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{}, JSON.stringify({ ...fixture, action: "start" }), routeUrl],
    [{}, `{"operationId":"${fixture.operationId}","operationId":"${fixture.operationId}"}`, routeUrl],
    [{}, `["${fixture.operationId}"]`, routeUrl],
    [{}, JSON.stringify({ operationId: "not-a-uuid" }), routeUrl],
    [{}, `${" ".repeat(257)}${body}`, routeUrl],
    [{ "content-length": "300" }, body, routeUrl],
    [{ "content-type": "text/plain" }, body, routeUrl],
    [{}, body, `${routeUrl}?host=other`],
  ])("rejects extra, malformed, oversized, or non-JSON input before transport", async (headers, raw, url) => {
    expect((await POST(request(raw, headers, url))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["performed", "refused"] as const)("uses only the named RPCs and one scoped host request, then replays a %s receipt", async (outcome) => {
    fetchMock
      .mockResolvedValueOnce(Response.json(claim))
      .mockResolvedValueOnce(Response.json({ ...hostReceipt, outcome }))
      .mockResolvedValueOnce(Response.json({ ...receipt, outcome }))
      .mockResolvedValueOnce(Response.json({ ...receipt, outcome }));
    const result = await POST(request(body, {
      authorization: "Bearer caller-placeholder",
      apikey: "caller-key",
      "x-forwarded-host": "ignored.example.invalid",
    }));
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ status: "settled", outcome });
    await expect((await POST(request())).json()).resolves.toEqual({ status: "settled", outcome });

    const claimUrl = `${databaseUrl}/rpc/claim_canary_qa_classic_start`;
    const finishUrl = `${databaseUrl}/rpc/finish_canary_qa_classic_start`;
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([claimUrl, hostUrl, finishUrl, claimUrl]);
    const [, claimInit] = fetchMock.mock.calls[0];
    const [, hostInit] = fetchMock.mock.calls[1];
    const [, finishInit] = fetchMock.mock.calls[2];
    for (const dbCall of [claimInit, finishInit]) {
      expect(dbCall.headers).toMatchObject({
        authorization: `Bearer ${postgrestBearer}`,
        apikey: gatewayKey,
        "content-profile": "public",
        "accept-profile": "public",
      });
    }
    expect(JSON.parse(claimInit.body)).toEqual({
      p_action: "start", p_owner_id: fixture.ownerId, p_instance_id: instanceId, p_host_id: fixture.hostId,
      p_vmid: fixture.vmid, p_operation_id: fixture.operationId,
    });
    expect(hostInit.headers).toEqual({
      accept: "application/json", "content-type": "application/json", authorization: `Bearer ${hostBearer}`,
    });
    expect(JSON.parse(hostInit.body)).toEqual({ ...fixture, action: "start" });
    expect(JSON.parse(finishInit.body)).toEqual({ p_operation_id: fixture.operationId, p_outcome: outcome });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", signal: expect.any(AbortSignal) });
    }
  });

  it.each(["pending", "denied"] as const)("does not call the host when claim is %s", async (status) => {
    setConfig("POSTGREST_GATEWAY_KEY", undefined);
    fetchMock.mockResolvedValueOnce(Response.json({ status }));
    await expect((await POST(request())).json()).resolves.toEqual({ status: "denied", reason: "claim_not_granted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("apikey");
  });

  it("never calls the host when PostgREST denies the bearer or the claim response is lost", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(claim, { status: 403 }))
      .mockRejectedValueOnce(new Error("claim response lost"));
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect((await POST(request())).json()).resolves.toEqual({ status: "denied", reason: "claim_unconfirmed" });
    }
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${databaseUrl}/rpc/claim_canary_qa_classic_start`, `${databaseUrl}/rpc/claim_canary_qa_classic_start`,
    ]);
  });

  it.each([
    ["wrong owner", () => Response.json({ ...hostReceipt, ownerId: "user_other" })],
    ["wrong instance", () => Response.json({ ...hostReceipt, instanceId: fixture.operationId })],
    ["wrong host", () => Response.json({ ...hostReceipt, hostId: "other-host" })],
    ["wrong VM", () => Response.json({ ...hostReceipt, vmid: "1234" })],
    ["wrong operation", () => Response.json({ ...hostReceipt, operationId: instanceId })],
    ["extra fields", () => Response.json({ ...hostReceipt, extra: true })],
    ["oversized", () => Response.json({ ...hostReceipt, extra: "x".repeat(4097) })],
    ["non-JSON", () => new Response(JSON.stringify(hostReceipt))],
    ["nonterminal HTTP status", () => Response.json(hostReceipt, { status: 202 })],
    ["HTTP refusal", () => Response.json({ ...hostReceipt, outcome: "refused" }, { status: 403 })],
    ["HTTP redirect", () => Response.redirect("https://other.example.invalid", 307)],
    ["lost acknowledgement", () => { throw new Error("transport lost"); }],
  ])("holds without finishing or falling back on %s", async (_label, hostReply) => {
    fetchMock.mockResolvedValueOnce(Response.json(claim))
      .mockImplementationOnce(async () => hostReply());
    const response = await POST(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ status: "held", reason: "runner_unconfirmed" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${databaseUrl}/rpc/claim_canary_qa_classic_start`, hostUrl,
    ]);
  });

  it("holds when finish acknowledgement is lost and does not send another host request", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(claim))
      .mockResolvedValueOnce(Response.json(hostReceipt))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(Response.json(receipt));
    await expect((await POST(request())).json()).resolves.toEqual({ status: "held", reason: "finish_unconfirmed" });
    await expect((await POST(request())).json()).resolves.toEqual({ status: "settled", outcome: "performed" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === hostUrl)).toHaveLength(1);
  });
});
