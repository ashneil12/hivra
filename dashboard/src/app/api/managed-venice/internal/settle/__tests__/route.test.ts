import { NextRequest } from "next/server";

const mockSettle = jest.fn();
const mockRelease = jest.fn();
const mockOwner = jest.fn();

jest.mock("@/lib/venice/proxy-chat-core", () => ({
  settleManagedVeniceChatUsage: (...args: unknown[]) => mockSettle(...args),
}));

jest.mock("@/lib/venice/proxy-settlement", () => ({
  releaseManagedVeniceChatReservationOrFile: (...args: unknown[]) => mockRelease(...args),
  loadManagedVeniceReservationOwner: (...args: unknown[]) => mockOwner(...args),
}));

import { POST } from "../route";

const SECRET = "test-internal-secret";
const HEADER = "x-managed-venice-internal-secret";

function makeReq(
  payload: unknown,
  opts: { secret?: string | null } = {}
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  if (secret !== null) headers[HEADER] = secret;
  return new Request("http://localhost/api/managed-venice/internal/settle", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }) as unknown as NextRequest;
}

const fullPayload = {
  userId: "user_1",
  proxyKeyId: "key_1",
  referenceId: "ref_1",
  model: "venice-uncensored-1-2",
  walletType: "hermesos",
  upstreamStatus: 200,
  usage: { prompt_tokens: 4, completion_tokens: 10 },
};

describe("/api/managed-venice/internal/settle", () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env.MANAGED_VENICE_INTERNAL_SECRET = SECRET;
    mockSettle.mockResolvedValue({ settled: true, reconciled: false });
    mockRelease.mockResolvedValue({ released: true, filed: false, failed: false });
    mockOwner.mockResolvedValue({ userId: "user_1", proxyKeyId: "key_1" });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.MANAGED_VENICE_INTERNAL_SECRET;
  });

  it("403s when the secret is missing", async () => {
    const res = await POST(makeReq(fullPayload, { secret: null }));
    expect(res.status).toBe(403);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("400s when required fields are missing", async () => {
    const res = await POST(makeReq({ userId: "user_1" }));
    expect(res.status).toBe(400);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("settles with the usage frame", async () => {
    const res = await POST(makeReq(fullPayload));
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, settled: true });
    expect(mockSettle).toHaveBeenCalledWith({
      userId: "user_1",
      proxyKeyId: "key_1",
      walletType: "hermesos",
      referenceId: "ref_1",
      model: "venice-uncensored-1-2",
      upstreamStatus: 200,
      usage: { prompt_tokens: 4, completion_tokens: 10 },
    });
  });

  it("settles with usage:null when no usage frame was seen", async () => {
    mockSettle.mockResolvedValueOnce({ settled: false, reconciled: true });
    const { usage: _omit, ...noUsage } = fullPayload;
    const res = await POST(makeReq(noUsage));
    expect(res.status).toBe(200);
    expect(mockSettle).toHaveBeenCalledWith(
      expect.objectContaining({ referenceId: "ref_1", usage: null })
    );
  });

  it("defaults walletType to hermesos for unknown values", async () => {
    await POST(makeReq({ ...fullPayload, walletType: "bogus" }));
    expect(mockSettle).toHaveBeenCalledWith(
      expect.objectContaining({ walletType: "hermesos" })
    );
  });

  it("releases the reservation on outcome=release (upstream failed)", async () => {
    const res = await POST(
      makeReq({ outcome: "release", userId: "user_1", referenceId: "ref_1" })
    );
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, released: true });
    expect(mockRelease).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", referenceId: "ref_1", cause: "worker_release" })
    );
    expect(mockOwner).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("400s a release missing referenceId", async () => {
    const res = await POST(makeReq({ outcome: "release", userId: "user_1" }));
    expect(res.status).toBe(400);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  // #167 review: a Worker whose authorize response was lost knows only the
  // reference it chose, and the hold it paid for used to sit until the sweep
  // charged it.
  it("releases by reference alone, finding the hold's owner", async () => {
    const res = await POST(makeReq({ outcome: "release", referenceId: "ref_lost", cause: "authorize_response_unreadable" }));
    expect(res.status).toBe(200);
    expect(mockOwner).toHaveBeenCalledWith("ref_lost");
    expect(mockRelease).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", proxyKeyId: "key_1", referenceId: "ref_lost", cause: "authorize_response_unreadable" })
    );
  });

  // #167 second review: an authorize whose connection reset can still commit
  // its hold after the Worker's release arrives. Answering 200 ended the
  // Worker's retries, and the sweep charged the hold's estimate for a request
  // that was never forwarded. A 5xx keeps the Worker retrying while the hold
  // may still land.
  it("answers 5xx, so the Worker retries, when no hold has that reference yet", async () => {
    mockOwner.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ outcome: "release", referenceId: "ref_not_yet_reserved" }));
    expect(res.status).toBe(503);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("answers 5xx, so the Worker retries, when the release could neither land nor be filed", async () => {
    mockRelease.mockResolvedValueOnce({ released: false, filed: false, failed: true });
    const res = await POST(makeReq({ outcome: "release", userId: "user_1", referenceId: "ref_1" }));
    expect(res.status).toBe(503);
  });

  it("passes the Worker's observed output and cause to settlement", async () => {
    await POST(makeReq({ ...fullPayload, usage: null, observedOutputTokens: 1_234, cause: "client_cancelled" }));
    expect(mockSettle).toHaveBeenCalledWith(
      expect.objectContaining({ usage: null, observedOutputTokens: 1_234, cause: "client_cancelled" })
    );
  });
});
