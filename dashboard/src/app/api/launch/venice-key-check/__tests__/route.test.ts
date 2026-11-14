import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { POST } from "../route";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));

const KEY = "synthetic-venice-key-for-tests";

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/launch/venice-key-check", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

describe("venice key check route", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const fetchMock = jest.fn();
  let logSpies: jest.SpyInstance[];

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user-1" } as Awaited<ReturnType<typeof auth>>);
    global.fetch = fetchMock as unknown as typeof fetch;
    logSpies = (["log", "info", "warn", "error"] as const).map(level => jest.spyOn(console, level).mockImplementation(() => {}));
  });
  afterEach(() => logSpies.forEach(spy => spy.mockRestore()));

  it("rejects signed-out requests", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: null } as Awaited<ReturnType<typeof auth>>);
    expect((await post({ key: KEY })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists the models a working key can use, with their privacy", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [
      { id: "kimi-k2-6", model_spec: { name: "Kimi K2.6", privacy: "private" } },
      { id: "claude-sonnet-4-6", model_spec: { name: "Claude Sonnet 4.6", privacy: "anonymized" } },
      { id: "e2ee-glm-5-1", model_spec: { privacy: "e2ee_private" } },
      { id: "bad id with spaces" },
    ] }), { status: 200 }));
    const response = await post({ key: KEY });
    expect(await response.json()).toEqual({ ok: true, models: [
      { id: "kimi-k2-6", name: "Kimi K2.6", privacy: "private" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", privacy: "anonymized" },
      { id: "e2ee-glm-5-1", name: "e2ee-glm-5-1", privacy: "e2ee_private" },
    ] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.venice.ai/api/v1/models?type=text");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.signal).toBeDefined();
  });

  it("reports a rejected key and an unreachable Venice by reason only", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(await (await post({ key: KEY })).json()).toEqual({ ok: false, reason: "invalid_key" });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    expect(await (await post({ key: KEY })).json()).toEqual({ ok: false, reason: "unreachable" });
    fetchMock.mockRejectedValueOnce(new Error(`timeout ${KEY}`));
    expect(await (await post({ key: KEY })).json()).toEqual({ ok: false, reason: "unreachable" });
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    expect(await (await post({ key: KEY })).json()).toEqual({ ok: false, reason: "unreachable" });
  });

  it("does not call Venice for something that can't be a key, and never logs the key", async () => {
    expect(await (await post({ key: "short" })).json()).toEqual({ ok: false, reason: "invalid_key" });
    expect(await (await post("nope")).json()).toEqual({ ok: false, reason: "invalid_key" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    await post({ key: KEY });
    expect(JSON.stringify(logSpies.map(spy => spy.mock.calls))).not.toContain(KEY);
  });
});
