/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

const mockValidateConsoleAccess = jest.fn();
const mockSshExec = jest.fn();
const mockEligible = jest.fn();

jest.mock("@/lib/services/console-helpers", () => ({
  validateConsoleAccess: (...args: unknown[]) => mockValidateConsoleAccess(...args),
}));
jest.mock("@/lib/hetzner/ssh", () => ({
  sshExec: (...args: unknown[]) => mockSshExec(...args),
}));
jest.mock("@/app/api/instances/[id]/route", () => ({
  isAdvancedCloudAccessEligible: (...args: unknown[]) => mockEligible(...args),
}));
jest.mock("@/lib/logger", () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { POST } from "../route";

const INSTANCE = { id: "inst-1", host_id: "shared-host", hetzner_server_id: 42 };

function post(enabled: boolean) {
  return POST(
    new NextRequest("http://localhost/api/instances/inst-1/elevated-mode", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
    { params: Promise.resolve({ id: "inst-1" }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateConsoleAccess.mockResolvedValue({
    id: "inst-1",
    userId: "user_1",
    instance: INSTANCE,
    hostIp: "10.0.0.5",
    errorResponse: null,
  });
  mockSshExec.mockResolvedValue({ ok: true, stdout: "", stderr: "" });
});

describe("elevated-mode isolation gate", () => {
  it("refuses to enable passwordless sudo on a layout that is not an isolated customer VM", async () => {
    mockEligible.mockReturnValue(false);
    const res = await post(true);
    expect(res.status).toBe(403);
    expect(mockEligible).toHaveBeenCalledWith(INSTANCE);
    expect(mockSshExec).not.toHaveBeenCalled();
  });

  it("enables on an isolated customer VM", async () => {
    mockEligible.mockReturnValue(true);
    const res = await post(true);
    expect(res.status).toBe(200);
    expect(mockSshExec).toHaveBeenCalledTimes(1);
  });

  it("always allows disabling, even where enabling is refused", async () => {
    mockEligible.mockReturnValue(false);
    const res = await post(false);
    expect(res.status).toBe(200);
    expect(mockSshExec).toHaveBeenCalledTimes(1);
  });
});
