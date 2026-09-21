import { log } from "../logger";
import { reportOpsEvent } from "../ops-events";

jest.mock("../ops-events", () => {
  const actual = jest.requireActual("../ops-events");
  return {
    ...actual,
    reportOpsEvent: jest.fn().mockResolvedValue(null),
  };
});

describe("structured logger", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("can write an error log without creating a second ops event", async () => {
    log.error("client ops event received", new Error("client_reported_error"), {
      source: "client-runtime",
      route: "/dashboard/chat",
      requestId: "req_123",
      userId: "user_123",
      failureType: "client_ops_event",
      reportOpsEvent: false,
    });

    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).toContain("client ops event received");
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });
});
