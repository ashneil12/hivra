import { auth } from "@clerk/nextjs/server";

import { readCatalogOrder } from "@/lib/hivra/catalog-claims";

import { GET } from "../route";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/hivra/catalog-claims", () => ({ readCatalogOrder: jest.fn() }));

describe("catalog order route", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const order = readCatalogOrder as jest.MockedFunction<typeof readCatalogOrder>;
  let logSpies: jest.SpyInstance[];

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG = "1";
    mockedAuth.mockResolvedValue({ userId: "user-1" } as Awaited<ReturnType<typeof auth>>);
    order.mockResolvedValue(["openclaw", "codex"]);
    logSpies = (["log", "info", "warn", "error"] as const).map(level => jest.spyOn(console, level).mockImplementation(() => {}));
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG;
    logSpies.forEach(spy => spy.mockRestore());
  });

  it("is not there while the catalog switch is off", async () => {
    delete process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG;
    expect((await GET()).status).toBe(404);
    expect(order).not.toHaveBeenCalled();
  });

  it("needs a signed-in person", async () => {
    mockedAuth.mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);
    expect((await GET()).status).toBe(401);
    expect(order).not.toHaveBeenCalled();
  });

  it("gives the order and no numbers", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { order: ["openclaw", "codex"] } });
  });
});
