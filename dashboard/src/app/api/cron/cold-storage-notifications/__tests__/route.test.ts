import { NextRequest } from "next/server";

import { GET } from "../route";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { supabaseAdmin } from "@/lib/supabase";
import {
  sendColdArchivedEmail,
  sendColdDeletedEmail,
  sendColdPendingDeletionEmail,
} from "@/lib/email/cold-storage";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@/lib/bearer-auth", () => ({ verifyBearerHeader: jest.fn() }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/email/cold-storage", () => ({
  sendColdArchivedEmail: jest.fn(),
  sendColdDeletedEmail: jest.fn(),
  sendColdPendingDeletionEmail: jest.fn(),
}));

const chain: Record<string, jest.Mock> = {};
for (const m of ["select", "in", "not", "or", "order", "update", "eq"]) {
  chain[m] = jest.fn(() => chain);
}
let candidateRows: unknown[] = [];
let updateError: { message: string } | null = null;
// The data read ends at .limit(); marker writes end at .eq(). Both are
// awaitable endpoints on one shared chain.
chain.limit = jest.fn(() => Promise.resolve({ data: candidateRows, error: null }));
chain.eq = jest.fn(() => Promise.resolve({ error: updateError }));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: jest.fn(() => chain) },
}));

const sent = { sent: true, id: "msg-1" };
function clerkOk(id: string) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        id,
        first_name: "Test",
        email_addresses: [
          { id: "e1", email_address: "test@example.com", verification: { status: "verified" } },
        ],
        primary_email_address_id: "e1",
      }),
  } as unknown as Response);
}

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: `user-${id}`,
    name: `agent-${id}`,
    agent_type: "webui",
    resource_tier: "standard",
    lifecycle_state: "cold_archived",
    archived_at: "2026-10-01T00:00:00.000Z",
    archive_uri: "s3://archive/x",
    scheduled_deletion_at: null,
    notifications_sent: null,
    deleted_at: null,
    ...overrides,
  };
}

function req(): NextRequest {
  return { url: "https://x/api/cron/cold-storage-notifications" } as unknown as NextRequest;
}

describe("GET /api/cron/cold-storage-notifications", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    candidateRows = [];
    updateError = null;
    (verifyBearerHeader as jest.Mock).mockReturnValue(true);
    (process.env as Record<string, string>).CRON_SECRET = "test-cron-secret";
    (process.env as Record<string, string>).CLERK_SECRET_KEY = "sk_test_x";
    (sendColdArchivedEmail as jest.Mock).mockResolvedValue(sent);
    (sendColdDeletedEmail as jest.Mock).mockResolvedValue(sent);
    (sendColdPendingDeletionEmail as jest.Mock).mockResolvedValue(sent);
    global.fetch = jest.fn((url: unknown) => clerkOk(String(url)));
  });

  it("401 when the cron bearer is invalid", async () => {
    (verifyBearerHeader as jest.Mock).mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("dry-run counts each kind without sending", async () => {
    delete (process.env as Record<string, string>).COLD_STORAGE_NOTIFICATIONS_ENABLED;
    candidateRows = [
      row("a1"),
      row("a2", { lifecycle_state: "deleted", deleted_at: "2026-10-20T00:00:00.000Z" }),
    ];
    const res = await GET(req());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.mode).toBe("dry_run");
    expect(json.data.archived_sent).toBe(1);
    expect(json.data.deleted_sent).toBe(1);
    expect(sendColdArchivedEmail).not.toHaveBeenCalled();
    expect(sendColdDeletedEmail).not.toHaveBeenCalled();
  });

  it("sends enabled notifications and counts them per kind", async () => {
    (process.env as Record<string, string>).COLD_STORAGE_NOTIFICATIONS_ENABLED = "true";
    candidateRows = [
      row("a1"),
      row("a2", { lifecycle_state: "deleted", deleted_at: "2026-10-20T00:00:00.000Z" }),
    ];
    const res = await GET(req());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.archived_sent).toBe(1);
    expect(json.data.deleted_sent).toBe(1);
    expect(sendColdArchivedEmail).toHaveBeenCalledTimes(1);
    expect(sendColdDeletedEmail).toHaveBeenCalledTimes(1);
    expect(sendColdArchivedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "test@example.com" }),
    );
  });

  it("skips rows whose notification was already sent", async () => {
    (process.env as Record<string, string>).COLD_STORAGE_NOTIFICATIONS_ENABLED = "true";
    candidateRows = [
      row("a1", { notifications_sent: { cold_archived: "2026-10-02T00:00:00.000Z" } }),
    ];
    const res = await GET(req());
    const json = await res.json();
    expect(json.data.skipped_already_sent).toBe(1);
    expect(sendColdArchivedEmail).not.toHaveBeenCalled();
  });

  it("fans out Clerk fetches with bounded concurrency", async () => {
    (process.env as Record<string, string>).COLD_STORAGE_NOTIFICATIONS_ENABLED = "true";
    candidateRows = Array.from({ length: 12 }, (_, i) => row(`a${i}`));
    let inFlight = 0;
    let maxInFlight = 0;
    (global.fetch as jest.Mock).mockImplementation(
      (url: unknown) =>
        new Promise((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setImmediate(() => {
            inFlight -= 1;
            resolve(clerkOk(String(url)));
          });
        }),
    );
    const res = await GET(req());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.archived_sent).toBe(12);
    expect(maxInFlight).toBeGreaterThan(1); // parallel, not one serial fetch per row
    expect(maxInFlight).toBeLessThanOrEqual(8); // SEND_CONCURRENCY bound
  });

  it("counts a Clerk failure without aborting the rest of the batch", async () => {
    (process.env as Record<string, string>).COLD_STORAGE_NOTIFICATIONS_ENABLED = "true";
    candidateRows = [row("a1"), row("a2"), row("a3")];
    (global.fetch as jest.Mock).mockImplementation((url: unknown) => {
      if (String(url).includes("user-a2")) {
        return Promise.resolve({ ok: false, status: 500 } as unknown as Response);
      }
      return clerkOk(String(url));
    });
    const res = await GET(req());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.failed).toBe(1);
    expect(json.data.archived_sent).toBe(2);
    expect(sendColdArchivedEmail).toHaveBeenCalledTimes(2);
    expect(reportOpsEvent).toHaveBeenCalled();
  });
});
