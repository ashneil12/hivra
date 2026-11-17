jest.mock("@/lib/status/load-status", () => ({
  loadPublicStatus: jest.fn(async () => ({ generatedAt: "x", overall: {}, components: [], incidents: [] })),
}));

import { GET } from "../route";

describe("GET /api/status", () => {
  const original = process.env.NEXT_PUBLIC_HIVRA_STATUS_PAGE;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_HIVRA_STATUS_PAGE;
    else process.env.NEXT_PUBLIC_HIVRA_STATUS_PAGE = original;
  });

  it("returns 404 when the switch is off", async () => {
    delete process.env.NEXT_PUBLIC_HIVRA_STATUS_PAGE;
    expect((await GET()).status).toBe(404);
  });

  it("returns cached JSON when the switch is on", async () => {
    process.env.NEXT_PUBLIC_HIVRA_STATUS_PAGE = "1";
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=60");
  });
});
