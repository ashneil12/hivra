import { GET } from "../route";

describe("GET /api/features/managed-venice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reports Managed Venice enabled", async () => {
    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ success: true, data: { enabled: true } });
  });
});
