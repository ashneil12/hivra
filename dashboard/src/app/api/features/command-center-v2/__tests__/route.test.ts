jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

import { auth, currentUser } from "@clerk/nextjs/server";

import { GET } from "../route";

const mockedAuth = auth as unknown as jest.Mock;
const mockedCurrentUser = currentUser as unknown as jest.Mock;

describe("GET /api/features/command-center-v2", () => {
  const originalAllowlist = process.env.COMMAND_CENTER_V2_ALLOWLIST;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COMMAND_CENTER_V2_ALLOWLIST;
    mockedAuth.mockResolvedValue({ userId: null });
    mockedCurrentUser.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalAllowlist === undefined) {
      delete process.env.COMMAND_CENTER_V2_ALLOWLIST;
    } else {
      process.env.COMMAND_CENTER_V2_ALLOWLIST = originalAllowlist;
    }
  });

  it("keeps unauthenticated callers out of the pilot without hard failing the dashboard", async () => {
    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ success: true, data: { enabled: false } });
  });

  it("enables a server-allowlisted pilot user", async () => {
    process.env.COMMAND_CENTER_V2_ALLOWLIST = "pilot@example.com";
    mockedAuth.mockResolvedValue({ userId: "user_fixture_pilot" });
    mockedCurrentUser.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "pilot@example.com" },
      emailAddresses: [{ emailAddress: "pilot@example.com" }],
    });

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.enabled).toBe(true);
  });

  it("does not enable regular signed-in users", async () => {
    mockedAuth.mockResolvedValue({ userId: "user_regular" });
    mockedCurrentUser.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "person@example.com" },
      emailAddresses: [{ emailAddress: "person@example.com" }],
    });

    const response = await GET();
    const payload = await response.json();

    expect(payload.data.enabled).toBe(false);
  });

  it("supports adding temporary testers through the server allowlist", async () => {
    process.env.COMMAND_CENTER_V2_ALLOWLIST = "extra@example.com";
    mockedAuth.mockResolvedValue({ userId: "user_extra" });
    mockedCurrentUser.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "extra@example.com" },
      emailAddresses: [{ emailAddress: "extra@example.com" }],
    });

    const response = await GET();
    const payload = await response.json();

    expect(payload.data.enabled).toBe(true);
  });
});
