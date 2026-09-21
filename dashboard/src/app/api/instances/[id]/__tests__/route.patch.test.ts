/**
 * PATCH /api/instances/[id] — launch-personalization persistence (Wave 1.2).
 *
 * Locks in that the captured goal / first_task / context land on the dedicated
 * hermes_instances columns (Phase 0 added them) when the welcome flow PATCHes
 * them, that lengths are clamped, that blank values write NULL, and that an
 * unrelated PATCH never clobbers a previously-captured value.
 *
 * The instance under test is stopped + non-webui so the `apply:true` path lands
 * in the "saved but not applied yet" branch — no gateway/SSH/WebUI calls — which
 * keeps this test focused on the DB write the welcome flow depends on.
 */

import { NextRequest } from "next/server";

import { PATCH } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn((value: string) => value),
  encryptApiKey: jest.fn((value: string) => `enc:${value}`),
}));

// Fire-and-forget activity stamp — keep it from touching the mock DB.
jest.mock("@/lib/instance-activity", () => ({
  recordInstanceUserActivity: jest.fn().mockResolvedValue(undefined),
}));

const BASE_INSTANCE = {
  id: "inst-123",
  user_id: "user_123",
  name: "Scout",
  provider: "openai",
  status: "stopped",
  backend: "gateway",
  config: { model: "gpt-test" },
  api_key_encrypted: "enc:existing",
  honcho_api_key_encrypted: null,
  lifecycle_state: "active",
  created_at: "2026-06-09T10:00:00.000Z",
};

function patchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/instances/inst-123", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Wire the supabase mock so getInstanceOrError returns BASE_INSTANCE and the
 * hermes_instances update echoes the payload back. Returns the update spy so the
 * test can assert exactly which columns were written.
 */
function mockDb(instanceOverrides: Record<string, unknown> = {}) {
  const instance = { ...BASE_INSTANCE, ...instanceOverrides };
  const updateMock = jest.fn();

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table !== "hermes_instances") {
      throw new Error(`Unexpected table ${table}`);
    }
    return {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            neq: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: instance, error: null }),
            }),
          }),
        }),
      }),
      update: updateMock.mockImplementation((payload: Record<string, unknown>) => ({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest
                .fn()
                .mockResolvedValue({ data: { ...instance, ...payload }, error: null }),
            }),
          }),
        }),
      })),
    };
  });

  return { updateMock };
}

function lastUpdatePayload(updateMock: jest.Mock): Record<string, unknown> {
  return updateMock.mock.calls[updateMock.mock.calls.length - 1][0];
}

describe("PATCH /api/instances/[id] launch personalization (Wave 1.2)", () => {
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("persists goal / first_task / context to the dedicated columns", async () => {
    const { updateMock } = mockDb();

    const res = await PATCH(
      patchRequest({
        apply: true,
        agentSettings: { systemPrompt: "You are Scout." },
        goal: "research",
        firstTask: "Compare three CRMs.",
        context: "Solo founder, B2B SaaS.",
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    expect(res.status).toBe(200);
    const payload = lastUpdatePayload(updateMock);
    expect(payload).toMatchObject({
      goal: "research",
      first_task: "Compare three CRMs.",
      context: "Solo founder, B2B SaaS.",
    });
    // The PATCH still rebuilds the stored config (the systemPrompt path is
    // unchanged by Wave 1.2 — these columns are additive).
    expect(payload.config).toBeDefined();
  });

  it("clamps over-long capture fields", async () => {
    const { updateMock } = mockDb();

    await PATCH(
      patchRequest({
        apply: true,
        goal: "x".repeat(200),
        firstTask: "t".repeat(2000),
        context: "c".repeat(5000),
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    const payload = lastUpdatePayload(updateMock);
    expect((payload.goal as string).length).toBe(64);
    expect((payload.first_task as string).length).toBe(700);
    expect((payload.context as string).length).toBe(2000);
  });

  it("writes NULL for blank capture fields instead of empty strings", async () => {
    const { updateMock } = mockDb();

    await PATCH(
      patchRequest({
        apply: true,
        goal: "   ",
        firstTask: "",
        context: "   ",
      }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    const payload = lastUpdatePayload(updateMock);
    expect(payload.goal).toBeNull();
    expect(payload.first_task).toBeNull();
    expect(payload.context).toBeNull();
  });

  it("leaves the capture columns untouched on an unrelated PATCH", async () => {
    const { updateMock } = mockDb();

    await PATCH(
      patchRequest({ apply: true, agentSettings: { maxIterations: 50 } }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    const payload = lastUpdatePayload(updateMock);
    expect(payload).not.toHaveProperty("goal");
    expect(payload).not.toHaveProperty("first_task");
    expect(payload).not.toHaveProperty("context");
  });

  it("writes only the capture fields present in the request", async () => {
    const { updateMock } = mockDb();

    await PATCH(
      patchRequest({ apply: true, goal: "build" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );

    const payload = lastUpdatePayload(updateMock);
    expect(payload.goal).toBe("build");
    expect(payload).not.toHaveProperty("first_task");
    expect(payload).not.toHaveProperty("context");
  });
});
