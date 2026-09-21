import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

jest.mock("uuid", () => ({
  v4: jest.fn(() => "avatar-upload-id"),
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: jest.fn(),
  RATE_LIMIT_PRESETS: {
    uploadWrite: {},
  },
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    storage: {
      listBuckets: jest.fn(),
      createBucket: jest.fn(),
      from: jest.fn(),
    },
  },
}));

describe("POST /api/upload-avatar", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedRateLimit = enforceAuthenticatedRouteRateLimit as jest.MockedFunction<
    typeof enforceAuthenticatedRouteRateLimit
  >;
  const mockedStorage = supabaseAdmin!.storage as unknown as {
    listBuckets: jest.Mock;
    createBucket: jest.Mock;
    from: jest.Mock;
  };
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockedRateLimit.mockReturnValue(null);
    mockedStorage.listBuckets.mockResolvedValue({
      data: [{ name: "avatars" }],
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const getConsoleOutput = () => JSON.stringify(consoleErrorSpy.mock.calls);

  // 8-byte PNG signature + a few zero bytes so the buffer is long enough
  // for the magic-byte check (which requires at least 12 bytes).
  const PNG_SIGNATURE = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 0,
  ]);

  it("does not expose unexpected upload failures to the client or logs", async () => {
    mockedStorage.from.mockReturnValue({
      upload: jest.fn().mockResolvedValue({
        error: new Error("avatar-storage-secret-leak"),
      }),
      getPublicUrl: jest.fn(),
    });

    const formData = new FormData();
    formData.set("file", new File([PNG_SIGNATURE], "avatar.png", { type: "image/png" }));

    const response = await POST({
      formData: jest.fn().mockResolvedValue(formData),
    } as unknown as Request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to upload avatar");
    expect(body.error).not.toContain("avatar-storage-secret-leak");
    expect(getConsoleOutput()).not.toContain("avatar-storage-secret-leak");
  });

  it("rejects an upload whose bytes don't match the claimed image type (forged Content-Type)", async () => {
    // Filename + Content-Type both pretend to be a GIF, but the bytes are
    // actually plain text — exactly the polyglot abuse the magic check
    // is meant to catch.
    const fakeGif = new File(
      ["this is not a gif <script>alert(1)</script>"],
      "evil.gif",
      { type: "image/gif" }
    );

    const formData = new FormData();
    formData.set("file", fakeGif);

    const uploadMock = jest.fn();
    mockedStorage.from.mockReturnValue({
      upload: uploadMock,
      getPublicUrl: jest.fn(),
    });

    const response = await POST({
      formData: jest.fn().mockResolvedValue(formData),
    } as unknown as Request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Unsupported avatar file type");
    // Critical: the malicious file must not have been written.
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the 'file' field is not a real File (e.g. a string)", async () => {
    // A forged/malformed multipart body can deliver `file` as a string.
    // It's truthy, so the old `as File` cast let it through and then
    // `file.size` blew up downstream. The instanceof guard must reject it
    // with a clear 400 and never touch storage.
    const uploadMock = jest.fn();
    mockedStorage.from.mockReturnValue({
      upload: uploadMock,
      getPublicUrl: jest.fn(),
    });

    const formData = new FormData();
    formData.set("file", "not-a-file");

    const response = await POST({
      formData: jest.fn().mockResolvedValue(formData),
    } as unknown as Request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe("No file provided");
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("stores the magic-byte-detected MIME type, not the client-supplied one", async () => {
    const uploadMock = jest.fn().mockResolvedValue({ error: null });
    mockedStorage.from.mockReturnValue({
      upload: uploadMock,
      getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: "https://example/x.png" } }),
    });

    const formData = new FormData();
    // Client claims "image/jpeg" but ships PNG bytes — we trust the bytes.
    formData.set("file", new File([PNG_SIGNATURE], "lying.png", { type: "image/jpeg" }));

    const response = await POST({
      formData: jest.fn().mockResolvedValue(formData),
    } as unknown as Request);

    expect(response.status).toBe(200);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const uploadOptions = uploadMock.mock.calls[0]?.[2];
    expect(uploadOptions?.contentType).toBe("image/png");
  });
});
