/**
 * Expo push sender tests — mocked transport, mocked DB. Locks in:
 *   - token fan-out (one message per enabled token, chunked)
 *   - the message shape (sound, title/body, data.url deep link)
 *   - ticket-level DeviceNotRegistered pruning (enabled=false, not delete)
 *   - receipt-level DeviceNotRegistered pruning via the ticket-id → token map
 *   - the never-throws contract (transport explosions → failed counts)
 *   - clean no-op when the user has no enabled tokens
 */

import type { ExpoPushMessage } from "expo-server-sdk";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

import { sendMobilePushToUser, type ExpoPushTransport } from "../expo-push";
import { supabaseAdmin } from "@/lib/supabase";

const mockedFrom = supabaseAdmin!.from as jest.Mock;

function tokensDb(tokens: string[]) {
  const pruneIn = jest.fn().mockResolvedValue({ error: null });
  const pruneUpdate = jest.fn().mockReturnValue({ in: pruneIn });
  mockedFrom.mockImplementation((table: string) => {
    if (table !== "device_tokens") throw new Error(`unexpected table ${table}`);
    return {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({
            data: tokens.map((t) => ({ expo_push_token: t })),
            error: null,
          }),
        }),
      }),
      update: pruneUpdate,
    };
  });
  return { pruneUpdate, pruneIn };
}

function fakeTransport(overrides: Partial<ExpoPushTransport> = {}): ExpoPushTransport {
  return {
    chunkPushNotifications: jest.fn((messages: ExpoPushMessage[]) => [messages]),
    sendPushNotificationsAsync: jest.fn(async (messages: ExpoPushMessage[]) =>
      messages.map((_, i) => ({ status: "ok" as const, id: `ticket-${i}` }))
    ),
    chunkPushNotificationReceiptIds: jest.fn((ids: string[]) => [ids]),
    getPushNotificationReceiptsAsync: jest.fn(async () => ({})),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("sendMobilePushToUser", () => {
  it("fans out one message per enabled token with the deep-link data payload", async () => {
    tokensDb(["ExponentPushToken[aaa]", "ExponentPushToken[bbb]"]);
    const transport = fakeTransport();

    const summary = await sendMobilePushToUser(
      {
        userId: "user_1",
        title: "Bea is ready — say hi",
        body: "Bea just finished setting up.",
        url: "hivra://chat/inst-1",
        data: { kind: "agent_ready" },
      },
      { transport }
    );

    expect(summary).toEqual({
      attempted: 2,
      sent: 2,
      failed: 0,
      pruned: 0,
      skippedNoTokens: false,
    });
    const sent = (transport.sendPushNotificationsAsync as jest.Mock).mock.calls[0][0];
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      to: "ExponentPushToken[aaa]",
      sound: "default",
      title: "Bea is ready — say hi",
      body: "Bea just finished setting up.",
      data: { url: "hivra://chat/inst-1", kind: "agent_ready" },
    });
  });

  it("is a clean no-op when the user has no enabled tokens", async () => {
    tokensDb([]);
    const transport = fakeTransport();

    const summary = await sendMobilePushToUser(
      { userId: "user_1", title: "hi" },
      { transport }
    );

    expect(summary.skippedNoTokens).toBe(true);
    expect(transport.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it("sends chunk-by-chunk and maps tickets back to the right tokens", async () => {
    tokensDb(["ExponentPushToken[aaa]", "ExponentPushToken[bbb]"]);
    const transport = fakeTransport({
      // Two chunks of one message each.
      chunkPushNotifications: jest.fn((messages: ExpoPushMessage[]) =>
        messages.map((m) => [m])
      ),
    });

    const summary = await sendMobilePushToUser(
      { userId: "user_1", title: "hi" },
      { transport }
    );

    expect(transport.sendPushNotificationsAsync).toHaveBeenCalledTimes(2);
    expect(summary.sent).toBe(2);
  });

  it("prunes a token when its TICKET reports DeviceNotRegistered", async () => {
    const { pruneUpdate, pruneIn } = tokensDb([
      "ExponentPushToken[dead]",
      "ExponentPushToken[live]",
    ]);
    const transport = fakeTransport({
      sendPushNotificationsAsync: jest.fn(async () => [
        {
          status: "error" as const,
          message: "device gone",
          details: { error: "DeviceNotRegistered" as const },
        },
        { status: "ok" as const, id: "ticket-1" },
      ]),
    });

    const summary = await sendMobilePushToUser(
      { userId: "user_1", title: "hi" },
      { transport }
    );

    expect(summary).toMatchObject({ sent: 1, failed: 1, pruned: 1 });
    // Disabled, never deleted.
    expect(pruneUpdate).toHaveBeenCalledWith({ enabled: false });
    expect(pruneIn).toHaveBeenCalledWith("expo_push_token", ["ExponentPushToken[dead]"]);
  });

  it("prunes a token when its RECEIPT reports DeviceNotRegistered", async () => {
    const { pruneIn } = tokensDb(["ExponentPushToken[stale]"]);
    const transport = fakeTransport({
      sendPushNotificationsAsync: jest.fn(async () => [
        { status: "ok" as const, id: "ticket-0" },
      ]),
      getPushNotificationReceiptsAsync: jest.fn(async () => ({
        "ticket-0": {
          status: "error" as const,
          message: "gone",
          details: { error: "DeviceNotRegistered" as const },
        },
      })),
    });

    const summary = await sendMobilePushToUser(
      { userId: "user_1", title: "hi" },
      { transport }
    );

    // The send itself was accepted; the receipt then killed the token.
    expect(summary).toMatchObject({ sent: 1, pruned: 1 });
    expect(pruneIn).toHaveBeenCalledWith("expo_push_token", ["ExponentPushToken[stale]"]);
  });

  it("never throws: a transport explosion becomes failed counts", async () => {
    tokensDb(["ExponentPushToken[aaa]"]);
    const transport = fakeTransport({
      sendPushNotificationsAsync: jest.fn(async () => {
        throw new Error("expo is down");
      }),
    });

    const summary = await sendMobilePushToUser(
      { userId: "user_1", title: "hi" },
      { transport }
    );

    expect(summary).toMatchObject({ attempted: 1, sent: 0, failed: 1 });
  });

  it("treats a receipt-fetch failure as advisory (send counts stand)", async () => {
    tokensDb(["ExponentPushToken[aaa]"]);
    const transport = fakeTransport({
      getPushNotificationReceiptsAsync: jest.fn(async () => {
        throw new Error("receipts down");
      }),
    });

    const summary = await sendMobilePushToUser(
      { userId: "user_1", title: "hi" },
      { transport }
    );

    expect(summary).toMatchObject({ sent: 1, failed: 0, pruned: 0 });
  });

  it("never throws: a token lookup error skips the send", async () => {
    mockedFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ data: null, error: { message: "db down" } }),
        }),
      }),
    }));
    const transport = fakeTransport();

    const summary = await sendMobilePushToUser(
      { userId: "user_1", title: "hi" },
      { transport }
    );

    expect(summary.skippedNoTokens).toBe(true);
    expect(transport.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });
});
