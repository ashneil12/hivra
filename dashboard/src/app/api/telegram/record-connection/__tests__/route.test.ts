/** @jest-environment node */
import { NextRequest } from "next/server";

import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { posthogClient } from "@/lib/posthog";
import { makeJsonRequest } from "@/test-utils/request";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/posthog", () => ({
  posthogClient: { capture: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());;

// Chainable Supabase builder whose terminal results are configurable per-test.
let ownershipResult: { data: unknown } = { data: { id: "agent-1" } };
let upsertResult: { error: unknown } = { error: null };
const upsertSpy = jest.fn();

jest.mock("@/lib/supabase", () => {
  const builder: Record<string, unknown> = {};
  builder.select = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.neq = jest.fn(() => builder);
  builder.maybeSingle = jest.fn(async () => ownershipResult);
  builder.upsert = jest.fn(async (...args: unknown[]) => {
    upsertSpy(...args);
    return upsertResult;
  });
  return { supabaseAdmin: { from: jest.fn(() => builder) } };
});

function postBody(body: unknown): NextRequest {
  return makeJsonRequest("http://localhost/api/telegram/record-connection", body, { method: "POST" });
}

describe("POST /api/telegram/record-connection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ownershipResult = { data: { id: "agent-1" } };
    upsertResult = { error: null };
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user-1" });
  });

  it("401s without a session", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const res = await POST(postBody({ channel: "telegram", targetKind: "hivra", targetId: "agent-1" }));
    expect(res.status).toBe(401);
  });

  it("400s on an unsupported channel", async () => {
    const res = await POST(postBody({ channel: "carrier-pigeon", targetKind: "hivra", targetId: "agent-1" }));
    expect(res.status).toBe(400);
  });

  it("400s on an invalid target id", async () => {
    const res = await POST(postBody({ channel: "telegram", targetKind: "hivra", targetId: "../etc/passwd" }));
    expect(res.status).toBe(400);
  });

  it("404s when the user does not own the target", async () => {
    ownershipResult = { data: null };
    const res = await POST(postBody({ channel: "telegram", targetKind: "hermes", targetId: "inst-9" }));
    expect(res.status).toBe(404);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("records the connection and emits a deduped event on success", async () => {
    const res = await POST(postBody({ channel: "telegram", targetKind: "hivra", targetId: "agent-1" }));
    expect(res.status).toBe(200);

    expect(supabaseAdmin!.from).toHaveBeenCalledWith("channel_connections");
    const [row, opts] = upsertSpy.mock.calls[0];
    expect(row).toMatchObject({ user_id: "user-1", channel: "telegram", target_kind: "hivra", target_id: "agent-1" });
    expect(row.last_connected_at).toEqual(expect.any(String));
    expect(row.connected_at).toBeUndefined(); // preserved by DB default on conflict
    expect(opts).toEqual({ onConflict: "user_id,channel,target_kind,target_id" });

    expect((posthogClient.capture as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "user-1",
        event: "telegram_connected",
        properties: expect.objectContaining({ $insert_id: "telegram_connected_user-1_hivra_agent-1" }),
      }),
    );
  });

  it("500s when the upsert fails", async () => {
    upsertResult = { error: { message: "boom" } };
    const res = await POST(postBody({ channel: "telegram", targetKind: "hivra", targetId: "agent-1" }));
    expect(res.status).toBe(500);
  });
});
