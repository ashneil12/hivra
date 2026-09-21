import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockedAuth = auth as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({ userId: "user_123" });
});

describe("GET /api/mobile/personas", () => {
  it("requires a Clerk session", async () => {
    mockedAuth.mockResolvedValue({ userId: null });
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("serves the consumer persona catalog with a short shared cache", async () => {
    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.personas)).toBe(true);
    expect(json.data.personas.length).toBeGreaterThanOrEqual(7);
    expect(json.data.personas[0]).toMatchObject({
      id: "atlas",
      displayName: "Bea",
      role: "Assistant",
      isCustom: false,
    });
    expect(json.data.personas[0].suggestedFirstTasks.length).toBeGreaterThanOrEqual(2);
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600"
    );
  });

  it("never serves engine jargon fields to the phone", async () => {
    const response = await GET();
    const body = JSON.stringify(await response.json());
    for (const banned of ["agentTypeKey", "soulPromptId", "personality", "icon"]) {
      expect(body).not.toContain(banned);
    }
  });
});
