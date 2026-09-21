import { GET, POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { SftpPreviewLimitError, sftpList, sftpRead, sftpReadBinary, sftpRealpath, sftpWrite } from "@/lib/hetzner/sftp";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/instance-resolvers", () => ({
  resolveInstanceIpv4: jest.fn(),
}));

jest.mock("@/lib/hetzner/sftp", () => ({
  sftpList: jest.fn(),
  sftpRead: jest.fn(),
  sftpReadBinary: jest.fn(),
  sftpRealpath: jest.fn(),
  sftpWrite: jest.fn(),
  SftpPreviewLimitError: class SftpPreviewLimitError extends Error {
    status: number;

    constructor(message: string, status = 413) {
      super(message);
      this.name = "SftpPreviewLimitError";
      this.status = status;
    }
  },
}));

describe("POST /api/instances/[id]/sftp", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedResolveIpv4 = resolveInstanceIpv4 as jest.MockedFunction<typeof resolveInstanceIpv4>;
  let consoleErrorSpy: jest.SpyInstance;

  function makeRequest(body: Record<string, unknown>) {
    return new Request("http://localhost:3000/api/instances/inst-123/sftp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedResolveIpv4.mockResolvedValue("203.0.113.4");
    (sftpRealpath as jest.Mock).mockImplementation(async (_ip: string, remotePath: string) => remotePath);

    mockedFrom.mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: { id: "inst-123", user_id: "user-123" },
            error: null,
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const getConsoleOutput = () => JSON.stringify(consoleErrorSpy.mock.calls);

  it("rejects unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);

    const res = await POST(makeRequest({ action: "list", path: "/root" }), {
      params: Promise.resolve({ id: "inst-123" }),
    });

    expect(res.status).toBe(401);
  });

  it("normalizes allowed paths before listing files", async () => {
    (sftpList as jest.Mock).mockResolvedValue([{ name: "file.txt" }]);

    const res = await POST(
      makeRequest({ action: "list", path: "/root/hermes/../config" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(sftpList).toHaveBeenCalledWith("203.0.113.4", "/root/config");
  });

  it("blocks traversal outside the allowed roots", async () => {
    const res = await POST(
      makeRequest({ action: "read", path: "/root/../../etc/passwd" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Access denied: Target path must be within /root, /opt, or /tmp");
    expect(sftpRead).not.toHaveBeenCalled();
  });

  it("blocks reads when a symlink resolves outside the allowed roots", async () => {
    (sftpRealpath as jest.Mock).mockResolvedValueOnce("/etc/passwd");

    const res = await POST(
      makeRequest({ action: "read", path: "/root/linked-passwd" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Access denied: Target path must be within /root, /opt, or /tmp");
    expect(sftpRead).not.toHaveBeenCalled();
  });

  it("blocks writes when a missing leaf would be created through a symlinked parent outside the allowed roots", async () => {
    (sftpRealpath as jest.Mock)
      .mockRejectedValueOnce(Object.assign(new Error("No such file"), { code: "ENOENT" }))
      .mockResolvedValueOnce("/etc");

    const res = await POST(
      makeRequest({ action: "write", path: "/root/redirect/new.txt", content: "hello" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Access denied: Target path must be within /root, /opt, or /tmp");
    expect(sftpWrite).not.toHaveBeenCalled();
  });

  it.each([
    "/opt/hermes/instances/inst-123/.env",
    "/opt/hermes/instances/inst-123/.env.production",
    "/opt/hermes/instances/inst-123/Caddyfile",
    "/opt/hermes/instances/inst-123/docker-compose.yml",
    "/opt/hermes/instances/inst-123/compose.yaml",
  ])("blocks writes to control-plane config file %s", async (path) => {
    const res = await POST(
      makeRequest({ action: "write", path, content: "tampered" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/control-plane/i);
    expect(sftpWrite).not.toHaveBeenCalled();
  });

  it("blocks writes to a control-plane file reached through a symlink", async () => {
    // Requested path looks innocent, but realpath resolves to the instance .env.
    (sftpRealpath as jest.Mock).mockResolvedValueOnce(
      "/opt/hermes/instances/inst-123/.env"
    );

    const res = await POST(
      makeRequest({ action: "write", path: "/tmp/link-to-env", content: "tampered" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/control-plane/i);
    expect(sftpWrite).not.toHaveBeenCalled();
  });

  it("still allows reading a control-plane config file (read is not denied)", async () => {
    (sftpRead as jest.Mock).mockResolvedValue("KEY=value");

    const res = await POST(
      makeRequest({ action: "read", path: "/opt/hermes/instances/inst-123/.env" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("allows writing a normal workspace file", async () => {
    (sftpWrite as jest.Mock).mockResolvedValue(undefined);

    const res = await POST(
      makeRequest({ action: "write", path: "/root/notes.txt", content: "hello" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(sftpWrite).toHaveBeenCalledWith("203.0.113.4", "/root/notes.txt", "hello");
  });

  it("allows host instance directories under /opt/hermes/instances", async () => {
    (sftpList as jest.Mock).mockResolvedValue([{ name: "config.yaml" }]);

    const res = await POST(
      makeRequest({ action: "list", path: "/opt/hermes/instances/inst-123/./../inst-123" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(sftpList).toHaveBeenCalledWith("203.0.113.4", "/opt/hermes/instances/inst-123");
  });

  it("allows browsing the /opt parent folder so users can move above the instance directory", async () => {
    (sftpList as jest.Mock).mockResolvedValue([{ name: "hermes", type: "directory" }]);

    const res = await POST(
      makeRequest({ action: "list", path: "/opt" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(sftpList).toHaveBeenCalledWith("203.0.113.4", "/opt");
  });

  it("returns 502 when the instance has no public IPv4", async () => {
    mockedResolveIpv4.mockResolvedValue("");

    const res = await POST(makeRequest({ action: "write", path: "/tmp/demo.txt", content: "hello" }), {
      params: Promise.resolve({ id: "inst-123" }),
    });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Server has no public IPv4");
    expect(sftpWrite).not.toHaveBeenCalled();
  });

  it("surfaces SSH timeout errors instead of a generic internal server error", async () => {
    (sftpList as jest.Mock).mockRejectedValue(new Error("Timed out while waiting for handshake: timeout-secret"));

    const res = await POST(
      makeRequest({ action: "list", path: "/opt/hermes/instances/inst-123" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(504);
    expect(body.error).toBe("SSH connection timed out");
    expect(JSON.stringify(body)).not.toContain("timeout-secret");
    expect(getConsoleOutput()).not.toContain("timeout-secret");
  });

  it("does not leak unexpected SFTP write errors to logs", async () => {
    (sftpWrite as jest.Mock).mockRejectedValueOnce(new Error("sftp-write-secret-leak"));

    const res = await POST(
      makeRequest({ action: "write", path: "/tmp/demo.txt", content: "hello" }),
      { params: Promise.resolve({ id: "inst-123" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Internal Server Error");
    expect(getConsoleOutput()).not.toContain("sftp-write-secret-leak");
  });
});

describe("GET /api/instances/[id]/sftp", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedResolveIpv4 = resolveInstanceIpv4 as jest.MockedFunction<typeof resolveInstanceIpv4>;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedResolveIpv4.mockResolvedValue("203.0.113.4");
    (sftpRealpath as jest.Mock).mockImplementation(async (_ip: string, remotePath: string) => remotePath);

    mockedFrom.mockImplementation((table: string) => {
      if (table === "hermes_instances") {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: { id: "inst-123", user_id: "user-123" },
            error: null,
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const getConsoleOutput = () => JSON.stringify(consoleErrorSpy.mock.calls);

  it("streams inline previews for supported binary file types", async () => {
    (sftpReadBinary as jest.Mock).mockResolvedValue(Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const req = new Request(
      "http://localhost:3000/api/instances/inst-123/sftp?path=/root/Manual.pdf"
    );

    const res = await GET(req, { params: Promise.resolve({ id: "inst-123" }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(sftpReadBinary).toHaveBeenCalledWith("203.0.113.4", "/root/Manual.pdf", 8 * 1024 * 1024);
  });

  it("rejects unsupported preview file types", async () => {
    const req = new Request(
      "http://localhost:3000/api/instances/inst-123/sftp?path=/root/archive.zip"
    );

    const res = await GET(req, { params: Promise.resolve({ id: "inst-123" }) });
    const body = await res.json();

    expect(res.status).toBe(415);
    expect(body.error).toBe("Preview is only available for PDFs and raster images");
    expect(sftpReadBinary).not.toHaveBeenCalled();
  });

  it("returns file downloads as attachments when download mode is requested", async () => {
    (sftpReadBinary as jest.Mock).mockResolvedValue(Buffer.from("hello"));

    const req = new Request(
      "http://localhost:3000/api/instances/inst-123/sftp?path=/root/archive.zip&download=1"
    );

    const res = await GET(req, { params: Promise.resolve({ id: "inst-123" }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain('filename="archive.zip"');
    expect(sftpReadBinary).toHaveBeenCalledWith("203.0.113.4", "/root/archive.zip");
  });

  it("blocks downloads when a symlink resolves outside the allowed roots", async () => {
    (sftpRealpath as jest.Mock).mockResolvedValueOnce("/etc/shadow");

    const req = new Request(
      "http://localhost:3000/api/instances/inst-123/sftp?path=/root/linked-shadow&download=1"
    );

    const res = await GET(req, { params: Promise.resolve({ id: "inst-123" }) });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Access denied: Target path must be within /root, /opt, or /tmp");
    expect(sftpReadBinary).not.toHaveBeenCalled();
  });

  it("does not leak preview limit stacks to logs", async () => {
    const previewError = new SftpPreviewLimitError(8 * 1024 * 1024);
    previewError.message = "File too large to preview in browser (max 8.0 MB)";
    previewError.stack = "preview-limit-stack-secret";
    (sftpReadBinary as jest.Mock).mockRejectedValueOnce(previewError);

    const req = new Request(
      "http://localhost:3000/api/instances/inst-123/sftp?path=/root/Manual.pdf"
    );

    const res = await GET(req, { params: Promise.resolve({ id: "inst-123" }) });
    const body = await res.json();

    expect(res.status).toBe(413);
    expect(body.error).toBe("File too large to preview in browser (max 8.0 MB)");
    expect(getConsoleOutput()).not.toContain("preview-limit-stack-secret");
  });

  it("does not leak download timeout details to logs", async () => {
    (sftpReadBinary as jest.Mock).mockRejectedValueOnce(new Error("Timed out while waiting for handshake: download-secret"));

    const req = new Request(
      "http://localhost:3000/api/instances/inst-123/sftp?path=/root/archive.zip&download=1"
    );

    const res = await GET(req, { params: Promise.resolve({ id: "inst-123" }) });
    const body = await res.json();

    expect(res.status).toBe(504);
    expect(body.error).toBe("SSH connection timed out");
    expect(JSON.stringify(body)).not.toContain("download-secret");
    expect(getConsoleOutput()).not.toContain("download-secret");
  });

  it("does not leak unexpected SFTP preview errors to logs", async () => {
    (sftpReadBinary as jest.Mock).mockRejectedValueOnce(new Error("sftp-preview-secret-leak"));

    const req = new Request(
      "http://localhost:3000/api/instances/inst-123/sftp?path=/root/Manual.pdf"
    );

    const res = await GET(req, { params: Promise.resolve({ id: "inst-123" }) });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Internal Server Error");
    expect(getConsoleOutput()).not.toContain("sftp-preview-secret-leak");
  });
});
