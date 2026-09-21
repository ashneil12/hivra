/**
 * Locks in the magic-byte check on `/api/upload-migration`.
 *
 * Filename and Content-Type can both be forged. The actual byte prefix
 * (`50 4B 03 04` = "PK\x03\x04") is what tells us the file is really a
 * zip. Without this check, an attacker can upload arbitrary binaries
 * (or polyglot HTML/JS) and hand them off to the migration consumer
 * downstream.
 */

import { POST } from "../route";

const FAKE_USER_ID = "user_zip_test";

jest.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: FAKE_USER_ID }),
}));

const uploadMock = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => uploadMock(...args),
      }),
    },
  },
}));

beforeEach(() => {
  uploadMock.mockReset();
  uploadMock.mockResolvedValue({ data: null, error: null });
});

function buildFormDataRequest(file: File): Request {
  const form = new FormData();
  form.append("file", file);
  return new Request("http://localhost/api/upload-migration", {
    method: "POST",
    body: form,
  }) as unknown as Request;
}

describe("upload-migration ZIP magic-byte", () => {
  it("rejects non-zip bytes even when filename is .zip", async () => {
    const malicious = new File(
      ["this is not a zip — it is HTML <script>alert(1)</script>"],
      "evil.zip",
      { type: "application/zip" }
    );
    const response = await POST(buildFormDataRequest(malicious) as never);
    expect(response.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("accepts a real zip (PK\\x03\\x04 prefix)", async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const real = new File([zipBytes], "good.zip", { type: "application/zip" });
    const response = await POST(buildFormDataRequest(real) as never);
    expect(response.status).toBe(200);
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated bytes (less than 4 bytes total)", async () => {
    const tiny = new File([new Uint8Array([0x50, 0x4b])], "tiny.zip", {
      type: "application/zip",
    });
    const response = await POST(buildFormDataRequest(tiny) as never);
    expect(response.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
