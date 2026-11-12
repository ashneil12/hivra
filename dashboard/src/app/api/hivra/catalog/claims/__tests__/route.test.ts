import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { checkClaim, readClaimView, startClaim } from "@/lib/hivra/catalog-claims";

import { GET, POST } from "../route";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/hivra/catalog-claims", () => ({ readClaimView: jest.fn(), startClaim: jest.fn(), checkClaim: jest.fn() }));

const VIEW = { profileId: "codex", name: "Codex", repo: "openai/codex", filePath: ".well-known/hivra.txt", claimed: false, mine: null, numbers: null };
const URL = "http://localhost/api/hivra/catalog/claims";

const get = (query: string) => GET(new NextRequest(`${URL}${query}`));
const post = (body: unknown) => POST(new NextRequest(URL, { method: "POST", body: JSON.stringify(body) }));

describe("catalog claims route", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const read = readClaimView as jest.MockedFunction<typeof readClaimView>;
  const start = startClaim as jest.MockedFunction<typeof startClaim>;
  const check = checkClaim as jest.MockedFunction<typeof checkClaim>;
  let logSpies: jest.SpyInstance[];

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG = "1";
    mockedAuth.mockResolvedValue({ userId: "user-1" } as Awaited<ReturnType<typeof auth>>);
    read.mockResolvedValue(VIEW as Awaited<ReturnType<typeof readClaimView>>);
    start.mockResolvedValue(VIEW as Awaited<ReturnType<typeof startClaim>>);
    check.mockResolvedValue(VIEW as Awaited<ReturnType<typeof checkClaim>>);
    logSpies = (["log", "info", "warn", "error"] as const).map(level => jest.spyOn(console, level).mockImplementation(() => {}));
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG;
    logSpies.forEach(spy => spy.mockRestore());
  });

  it("is not there while the catalog switch is off", async () => {
    delete process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG;
    expect((await get("?profile=codex")).status).toBe(404);
    expect((await post({ profile: "codex", action: "start" })).status).toBe(404);
    expect(mockedAuth).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("needs a signed-in person", async () => {
    mockedAuth.mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);
    expect((await get("?profile=codex")).status).toBe(401);
    expect((await post({ profile: "codex", action: "check" })).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("reads the signed-in person's view of a page's claim", async () => {
    const response = await get("?profile=codex");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { claim: VIEW } });
    expect(read).toHaveBeenCalledWith("user-1", "codex");
  });

  it("refuses a page it does not know", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?profile=../../etc")).status).toBe(400);
    expect((await post({ profile: "not-a-page", action: "start" })).status).toBe(400);
    expect((await post({ profile: "codex", action: "delete" })).status).toBe(400);
    expect((await post({ profile: "codex", action: "start", repo: "someone/else" })).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("starts a claim and checks it for the signed-in person only", async () => {
    expect((await post({ profile: "codex", action: "start" })).status).toBe(200);
    expect(start).toHaveBeenCalledWith("user-1", "codex");
    const response = await post({ profile: "codex", action: "check" });
    expect(await response.json()).toEqual({ success: true, data: { claim: VIEW } });
    expect(check).toHaveBeenCalledWith("user-1", "codex");
  });

  it("says why when there is nothing to start or check", async () => {
    start.mockResolvedValueOnce(null);
    expect((await post({ profile: "openbot", action: "start" })).status).toBe(400);
    check.mockResolvedValueOnce(null);
    expect((await post({ profile: "codex", action: "check" })).status).toBe(409);
  });

  it("answers 500 without details when the database fails", async () => {
    read.mockRejectedValueOnce(new Error("Could not read the claim."));
    const response = await get("?profile=codex");
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("Could not read the claim.");
  });
});
