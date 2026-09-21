import type { NextRequest } from "next/server";

import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";

import {
  enforceAuthenticatedRouteRateLimit,
} from "@/lib/authenticated-rate-limit";
import { decryptApiKey } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/authenticated-rate-limit", () => ({
  RATE_LIMIT_PRESETS: {
    uploadWrite: { limit: 10, windowMs: 300000 },
  },
  enforceAuthenticatedRouteRateLimit: jest.fn(),
}));

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

describe("POST /api/openai/transcriptions", () => {
  const originalTranscriptionApiKeyEnv = process.env.VOICE_TRANSCRIPTION_OPENAI_API_KEY;
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedDecryptApiKey = decryptApiKey as jest.MockedFunction<
    typeof decryptApiKey
  >;
  const mockedRateLimit = enforceAuthenticatedRouteRateLimit as jest.MockedFunction<
    typeof enforceAuthenticatedRouteRateLimit
  >;
  const mockedFrom = (supabaseAdmin as NonNullable<typeof supabaseAdmin>).from as jest.Mock;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let consoleErrorSpy: jest.SpyInstance;

  function buildRequest(formData: FormData) {
    return {
      formData: jest.fn().mockResolvedValue(formData),
    } as unknown as NextRequest;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.VOICE_TRANSCRIPTION_OPENAI_API_KEY;
    mockedRateLimit.mockReturnValue(null);
    fetchMock = jest.spyOn(global, "fetch");
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalTranscriptionApiKeyEnv === undefined) {
      delete process.env.VOICE_TRANSCRIPTION_OPENAI_API_KEY;
    } else {
      process.env.VOICE_TRANSCRIPTION_OPENAI_API_KEY = originalTranscriptionApiKeyEnv;
    }
    fetchMock.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);

    const response = await POST(buildRequest(new FormData()));

    expect(response.status).toBe(401);
  });

  it("uses the server transcription key for non-openai instances when configured", async () => {
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    process.env.VOICE_TRANSCRIPTION_OPENAI_API_KEY = "vercel-fallback-openai-key";

    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      single: jest.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.single.mockResolvedValue({
      data: { provider: "openrouter", api_key_encrypted: "enc" },
      error: null,
    });
    mockedFrom.mockReturnValue(query);
    fetchMock.mockResolvedValue(
      new Response("transcribed text", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const formData = new FormData();
    formData.set("instanceId", "inst_123");
    formData.set("file", new File(["audio"], "recording.webm", { type: "audio/webm" }));

    const response = await POST(buildRequest(formData));

    expect(response.status).toBe(200);
    expect(mockedDecryptApiKey).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer vercel-fallback-openai-key",
        }),
      })
    );
  });

  it("falls back to the instance OpenAI key when no server transcription key is configured", async () => {
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);

    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      single: jest.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.single.mockResolvedValue({
      data: { provider: "openai", api_key_encrypted: "enc-openai-key" },
      error: null,
    });
    mockedFrom.mockReturnValue(query);
    mockedDecryptApiKey.mockReturnValue("resolved-openai-key");
    fetchMock.mockResolvedValue(
      new Response("transcribed text", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const formData = new FormData();
    formData.set("instanceId", "inst_123");
    formData.set("file", new File(["audio"], "recording.webm", { type: "audio/webm" }));

    const response = await POST(buildRequest(formData));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mockedDecryptApiKey).toHaveBeenCalledWith("enc-openai-key");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer resolved-openai-key",
        }),
        body: expect.any(FormData),
      })
    );
    expect(json.data).toEqual({
      model: "gpt-4o-transcribe",
      text: "transcribed text",
    });
  });

  it("prefers the server transcription key over the instance OpenAI key", async () => {
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    process.env.VOICE_TRANSCRIPTION_OPENAI_API_KEY = "vercel-fallback-openai-key";

    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      single: jest.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.single.mockResolvedValue({
      data: { provider: "openai", api_key_encrypted: null },
      error: null,
    });
    mockedFrom.mockReturnValue(query);
    fetchMock.mockResolvedValue(
      new Response("transcribed text", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const formData = new FormData();
    formData.set("instanceId", "inst_123");
    formData.set("file", new File(["audio"], "recording.webm", { type: "audio/webm" }));

    const response = await POST(buildRequest(formData));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mockedDecryptApiKey).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer vercel-fallback-openai-key",
        }),
      })
    );
    expect(json.data).toEqual({
      model: "gpt-4o-transcribe",
      text: "transcribed text",
    });
  });

  it("returns 400 when no instance key or server transcription key is configured", async () => {
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);

    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      single: jest.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.single.mockResolvedValue({
      data: { provider: "openrouter", api_key_encrypted: "enc-openrouter-key" },
      error: null,
    });
    mockedFrom.mockReturnValue(query);

    const formData = new FormData();
    formData.set("instanceId", "inst_123");
    formData.set("file", new File(["audio"], "recording.webm", { type: "audio/webm" }));

    const response = await POST(buildRequest(formData));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Voice transcription is not configured for this instance.");
    // Public-facing error must not name the platform env var — that hint
    // helps an attacker fingerprint our deployment surface.
    expect(json.error).not.toContain("VOICE_TRANSCRIPTION_OPENAI_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not leak upstream OpenAI failures to the client or logs", async () => {
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);

    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      single: jest.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.single.mockResolvedValue({
      data: { provider: "openai", api_key_encrypted: "enc-openai-key" },
      error: null,
    });
    mockedFrom.mockReturnValue(query);
    mockedDecryptApiKey.mockReturnValue("resolved-openai-key");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "upstream-secret-leak" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const formData = new FormData();
    formData.set("instanceId", "inst_123");
    formData.set("file", new File(["audio"], "recording.webm", { type: "audio/webm" }));

    const response = await POST(buildRequest(formData));
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe(
      "OpenAI rejected the transcription request. Check the configured OpenAI API key."
    );
    expect(JSON.stringify(json)).not.toContain("upstream-secret-leak");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("upstream-secret-leak");
  });
});
