import { NextRequest } from "next/server";

import { GET } from "../route";
import { syncClerkUsersToAnnouncementAudience } from "@/lib/email/resend-announcement-sync";

jest.mock("@/lib/email/resend-announcement-sync", () => ({
  syncClerkUsersToAnnouncementAudience: jest.fn(),
}));

describe("GET /api/cron/resend-announcement-audience", () => {
  const originalEnv = process.env;
  const mockedSync = syncClerkUsersToAnnouncementAudience as jest.MockedFunction<
    typeof syncClerkUsersToAnnouncementAudience
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeRequest = (authorization?: string) =>
    new NextRequest("http://localhost/api/cron/resend-announcement-audience", {
      headers: authorization ? { authorization } : {},
    });

  it("rejects requests without the cron secret", async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("runs the full Resend audience sync", async () => {
    mockedSync.mockResolvedValue({
      clerkUsersFound: 159,
      recipients: 159,
      created: 1,
      updated: 158,
      unsubscribed: 0,
      skipped: 0,
      pruned: 0,
      segmentId: "segment_123",
      topicId: "topic_123",
      timedOut: false,
      recipientsProcessed: 159,
    });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mockedSync).toHaveBeenCalledTimes(1);
    // The route passes a wall-clock budget so the sync can stop cleanly under
    // maxDuration instead of being SIGKILLed.
    expect(mockedSync).toHaveBeenCalledWith(
      expect.objectContaining({ timeBudgetMs: expect.any(Number) }),
    );
    expect(json.data).toEqual({
      clerkUsersFound: 159,
      recipients: 159,
      created: 1,
      updated: 158,
      unsubscribed: 0,
      skipped: 0,
      pruned: 0,
      segmentId: "segment_123",
      topicId: "topic_123",
      timedOut: false,
      recipientsProcessed: 159,
    });
  });

  it("still returns 200 and a partial result when the sync times out", async () => {
    mockedSync.mockResolvedValue({
      clerkUsersFound: 500,
      recipients: 500,
      created: 0,
      updated: 120,
      unsubscribed: 0,
      skipped: 0,
      pruned: 0,
      segmentId: "segment_123",
      topicId: "topic_123",
      timedOut: true,
      recipientsProcessed: 120,
    });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.timedOut).toBe(true);
    expect(json.data.recipientsProcessed).toBe(120);
  });

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(makeRequest("Bearer cron-secret"));

    expect(response.status).toBe(500);
    expect(mockedSync).not.toHaveBeenCalled();
  });
});
