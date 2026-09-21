import { NextRequest } from "next/server";
import { DELETE, GET, POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { encryptApiKey, formatKeyPreview } from "@/lib/crypto";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/crypto", () => ({
  encryptApiKey: jest.fn(() => "enc:key"),
  formatKeyPreview: jest.fn(() => "sk-...1234"),
}));

describe("vault route security", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedEncryptApiKey = encryptApiKey as jest.MockedFunction<typeof encryptApiKey>;
  const mockedFormatKeyPreview = formatKeyPreview as jest.MockedFunction<typeof formatKeyPreview>;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    mockedEncryptApiKey.mockReturnValue("enc:key");
    mockedFormatKeyPreview.mockReturnValue("sk-...1234");
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const getConsoleOutput = () => JSON.stringify(consoleErrorSpy.mock.calls);

  it("hides unexpected GET errors from the client", async () => {
    mockedAuth.mockRejectedValueOnce(new Error("session-secret-leak"));

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(json.error).not.toContain("session-secret-leak");
    expect(getConsoleOutput()).not.toContain("session-secret-leak");
  });

  it("does not leak raw database errors when listing API keys fails", async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'list leaked "sk-live-secret"' },
      }),
    };
    mockedFrom.mockReturnValue(query);

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to fetch API keys");
    expect(json.error).not.toContain("sk-live-secret");
    expect(getConsoleOutput()).not.toContain("sk-live-secret");
  });

  it("does not leak raw database errors when saving an API key fails", async () => {
    const query = {
      insert: jest.fn().mockReturnThis(),
      // The route now upserts on (user_id, provider) for new entries —
      // the unique constraint added in migration 20260502120200 makes
      // repeat saves rotate the existing row rather than insert a dupe.
      upsert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'duplicate key leaked "sk-live-secret"' },
      }),
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
    };
    mockedFrom.mockReturnValue(query);

    const response = await POST(
      new NextRequest("http://localhost/api/vault", {
        method: "POST",
        body: JSON.stringify({
          name: "Primary OpenAI",
          provider: "openai",
          key: "sk-live-secret",
        }),
      })
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to save API key");
    expect(json.error).not.toContain("sk-live-secret");
    expect(getConsoleOutput()).not.toContain("sk-live-secret");
  });

  it("rejects GitHub token-shaped values for OpenRouter vault keys", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/vault", {
        method: "POST",
        body: JSON.stringify({
          name: "OpenRouter",
          provider: "openrouter",
          key: "github_pat_wrong_secret",
        }),
      })
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("OpenRouter API keys must start with sk-or-.");
    expect(mockedEncryptApiKey).not.toHaveBeenCalled();
    expect(mockedFrom).not.toHaveBeenCalled();
    expect(JSON.stringify(json)).not.toContain("github_pat_wrong_secret");
    expect(getConsoleOutput()).not.toContain("github_pat_wrong_secret");
  });

  it("hides unexpected POST errors from the client and logs", async () => {
    mockedEncryptApiKey.mockImplementationOnce(() => {
      throw new Error("encrypt-secret-leak");
    });

    const response = await POST(
      new NextRequest("http://localhost/api/vault", {
        method: "POST",
        body: JSON.stringify({
          name: "Primary OpenAI",
          provider: "openai",
          key: "sk-live-secret",
        }),
      })
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(JSON.stringify(json)).not.toContain("encrypt-secret-leak");
    expect(getConsoleOutput()).not.toContain("encrypt-secret-leak");
  });

  it("hides unexpected DELETE errors from the client", async () => {
    mockedFrom.mockImplementationOnce(() => {
      throw new Error("delete-secret-leak");
    });

    const response = await DELETE(
      new NextRequest("http://localhost/api/vault?id=key-123", {
        method: "DELETE",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(json.error).not.toContain("delete-secret-leak");
    expect(getConsoleOutput()).not.toContain("delete-secret-leak");
  });

  it("does not leak raw database errors when deleting an API key fails", async () => {
    const query = {
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
    };
    query.eq.mockReturnValueOnce(query).mockResolvedValueOnce({
      error: { message: 'delete leaked "sk-live-secret"' },
    });
    mockedFrom.mockReturnValue(query);

    const response = await DELETE(
      new NextRequest("http://localhost/api/vault?id=key-123", {
        method: "DELETE",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to delete API key");
    expect(json.error).not.toContain("sk-live-secret");
    expect(getConsoleOutput()).not.toContain("sk-live-secret");
  });
});
