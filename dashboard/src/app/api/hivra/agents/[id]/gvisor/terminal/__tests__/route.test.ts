import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { GvisorComputerError, openClaudeSandboxTerminal } from "@/lib/hivra/gvisor-computer-service";
import { POST } from "../route";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: () => null }));
jest.mock("@/lib/hivra/gvisor-computer-service", () => ({
  GvisorComputerError: class extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  },
  openClaudeSandboxTerminal: jest.fn(),
}));

const dashboard = "https://dashboard.example.test";
const terminal = "https://terminal.example.test";
const context = { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };

function request(origin = dashboard, query = "") {
  return new NextRequest(`${dashboard}/api/hivra/agents/fixture/gvisor/terminal${query}`, {
    method: "POST", headers: { origin, "sec-fetch-site": "same-origin" },
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_test" });
});

it("requires Hivra sign-in and an exact same-origin POST with no URL credentials", async () => {
  (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
  expect((await POST(request(), context)).status).toBe(401);
  expect((await POST(request(terminal), context)).status).toBe(403);
  expect((await POST(request(dashboard, "?destination=other"), context)).status).toBe(403);
  expect(openClaudeSandboxTerminal).not.toHaveBeenCalled();
});

it("does not issue a bootstrap form if the verified sandbox is stopped or not owned", async () => {
  (openClaudeSandboxTerminal as jest.Mock).mockRejectedValueOnce(new GvisorComputerError("not_ready", "Start this sandbox first."));
  expect((await POST(request(), context)).status).toBe(409);
  (openClaudeSandboxTerminal as jest.Mock).mockRejectedValueOnce(new GvisorComputerError("not_found", "Not found."));
  expect((await POST(request(), context)).status).toBe(404);
});

it("posts the one-use grant to the verified dedicated origin without a cache or URL token", async () => {
  (openClaudeSandboxTerminal as jest.Mock).mockResolvedValueOnce({ origin: terminal, token: "v1.fixture-proof" });
  const response = await POST(request(), context);
  expect(openClaudeSandboxTerminal).toHaveBeenCalledWith("user_test", (await context.params).id);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Security-Policy")).toContain(`form-action ${terminal}; frame-ancestors 'none'`);
  const body = await response.text();
  expect(body).toContain(`method="post" action="${terminal}/auth/bootstrap"`);
  expect(body).toContain('name="token" value="v1.fixture-proof"');
  expect(body).not.toContain("?token=");
});
