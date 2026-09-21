import { NextRequest } from "next/server";
import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn(),
    },
  },
}));

describe("POST /api/upload-migration", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedStorage = supabaseAdmin!.storage as unknown as {
    from: jest.Mock;
  };
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("hides unexpected upload errors from the client", async () => {
    mockedAuth.mockRejectedValueOnce(new Error("upload-secret-leak"));

    const response = await POST(
      new NextRequest("http://localhost/api/upload-migration", {
        method: "POST",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(json.error).not.toContain("upload-secret-leak");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("upload-secret-leak");
  });

  it("does not leak storage upload failures to the client or logs", async () => {
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockedStorage.from.mockReturnValue({
      upload: jest.fn().mockResolvedValue({
        error: { message: "upload-storage-secret-leak" },
      }),
    });

    const formData = new FormData();
    // Real PKZip prefix so the route's magic-byte check passes and we
    // exercise the storage-upload error path the test cares about.
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    formData.set("file", new File([zipBytes], "migration.zip", { type: "application/zip" }));

    // Use a real NextRequest (so the route's per-user rate-limit check can read
    // headers via getIP) but stub formData to return our test payload.
    const req = new NextRequest("http://localhost/api/upload-migration", {
      method: "POST",
    });
    (req as unknown as { formData: jest.Mock }).formData = jest
      .fn()
      .mockResolvedValue(formData);

    const response = await POST(req);
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to upload to storage");
    expect(JSON.stringify(json)).not.toContain("upload-storage-secret-leak");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("upload-storage-secret-leak");
  });
});
