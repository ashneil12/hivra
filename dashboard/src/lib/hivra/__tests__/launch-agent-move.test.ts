import { launchHivraAgentForUser } from "../launch-agent";

let mockInstanceRow: Record<string, unknown> | null = null;
let mockInstanceError: unknown = null;
const mockFrom = jest.fn();
const mockValidateResources = jest.fn();

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) } }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/hivra/resource-gate", () => ({
  ...jest.requireActual("@/lib/hivra/resource-gate"),
  validateAgentResources: (...args: unknown[]) => mockValidateResources(...args),
}));

function instanceTable() {
  const stub: Record<string, unknown> = {
    select: jest.fn(() => stub),
    eq: jest.fn(() => stub),
    maybeSingle: jest.fn(async () => ({ data: mockInstanceRow, error: mockInstanceError })),
  };
  return stub;
}

async function refusal(body: Record<string, unknown>, moveFromInstanceId = "inst_old") {
  const response = await launchHivraAgentForUser("user_a", body, { moveFromInstanceId });
  return { status: response.status, json: await response.json() };
}

describe("launchHivraAgentForUser moveFromInstanceId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInstanceRow = { id: "inst_old", user_id: "user_a", status: "running" };
    mockInstanceError = null;
    mockFrom.mockImplementation((table: string) => {
      if (table === "hermes_instances") return instanceTable();
      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("refuses an instance that belongs to another owner", async () => {
    mockInstanceRow = { id: "inst_old", user_id: "user_b", status: "running" };
    expect((await refusal({ type: "hermes" })).status).toBe(400);
    expect(mockValidateResources).not.toHaveBeenCalled();
  });

  it("refuses an instance that does not exist", async () => {
    mockInstanceRow = null;
    expect((await refusal({ type: "hermes" })).status).toBe(400);
  });

  it.each(["provisioning", "deleted", "error", "suspended"])("refuses an instance whose status is %s", async status => {
    mockInstanceRow = { id: "inst_old", user_id: "user_a", status };
    const result = await refusal({ type: "hermes" });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.json)).toContain("running or stopped");
  });

  it.each([undefined, "codex", "claude-code"])("refuses a launch whose type is %p", async type => {
    const result = await refusal({ type });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.json)).toContain("Hermes");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("refuses when the instance cannot be read", async () => {
    mockInstanceError = { message: "boom" };
    expect((await refusal({ type: "hermes" })).status).toBe(503);
  });
});
