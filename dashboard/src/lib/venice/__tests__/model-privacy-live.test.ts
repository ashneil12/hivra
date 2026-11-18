/**
 * @jest-environment node
 */
import {
  _resetVeniceModelPrivacyCacheForTests,
  getVeniceModelPrivacyLookup,
  readStatedVenicePrivacy,
  resolveVeniceModelPrivacy,
} from "@/lib/venice/model-privacy-live";

jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

const originalFetch = global.fetch;
const originalApiKey = process.env.VENICE_API_KEY;
const originalInferenceKeys = process.env.MANAGED_VENICE_INFERENCE_KEYS;

const entry = (id: string, privacy: unknown, type = "text") => ({ id, type, model_spec: privacy === undefined ? {} : { privacy } });

function listResponse(data: unknown[], status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  _resetVeniceModelPrivacyCacheForTests();
  delete process.env.VENICE_API_KEY;
  delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.VENICE_API_KEY; else process.env.VENICE_API_KEY = originalApiKey;
  if (originalInferenceKeys === undefined) delete process.env.MANAGED_VENICE_INFERENCE_KEYS; else process.env.MANAGED_VENICE_INFERENCE_KEYS = originalInferenceKeys;
});

describe("readStatedVenicePrivacy", () => {
  it("accepts only what Venice states", () => {
    expect(readStatedVenicePrivacy("private", "kimi-k2-6")).toBe("private");
    expect(readStatedVenicePrivacy("Anonymized", "claude-opus-4-8")).toBe("anonymized");
    expect(readStatedVenicePrivacy("e2ee_private", "x")).toBe("e2ee_private");
    // Venice labels its end-to-end encrypted models "private" and marks them by id.
    expect(readStatedVenicePrivacy("private", "e2ee-glm-5-3-p")).toBe("e2ee_private");
  });

  it("never guesses: a missing or unknown value is unknown, even for an e2ee id", () => {
    expect(readStatedVenicePrivacy(undefined, "kimi-k2-6")).toBeNull();
    expect(readStatedVenicePrivacy(null, "e2ee-glm-5-3-p")).toBeNull();
    expect(readStatedVenicePrivacy("secure", "x")).toBeNull();
    expect(readStatedVenicePrivacy(true, "x")).toBeNull();
  });
});

describe("resolveVeniceModelPrivacy", () => {
  it("answers from Venice's list for every model type", async () => {
    global.fetch = jest.fn().mockResolvedValue(listResponse([
      entry("some-new-text-model", "private"),
      entry("gpt-image-2-edit", "anonymized", "inpaint"),
      entry("tts-kokoro", "private", "tts"),
      entry("upscaler", "private", "upscale"),
    ])) as unknown as typeof fetch;

    expect(await resolveVeniceModelPrivacy("some-new-text-model")).toBe("private");
    expect(await resolveVeniceModelPrivacy("gpt-image-2-edit")).toBe("anonymized");
    expect(await resolveVeniceModelPrivacy("tts-kokoro")).toBe("private");
    expect(await resolveVeniceModelPrivacy("upscaler")).toBe("private");
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain("/api/v1/models?type=all");
    // One fetch serves every lookup inside the cache window.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("lets Venice's current statement win over Hivra's catalog snapshot", async () => {
    // The catalog lists this model as private.
    global.fetch = jest.fn().mockResolvedValue(listResponse([entry("deepseek-v4-1-flash", "anonymized")])) as unknown as typeof fetch;
    expect(await resolveVeniceModelPrivacy("deepseek-v4-1-flash")).toBe("anonymized");
  });

  it("falls back to the catalog for a model Venice's list does not carry, and is unknown past that", async () => {
    global.fetch = jest.fn().mockResolvedValue(listResponse([entry("kimi-k2-6", "private")])) as unknown as typeof fetch;
    expect(await resolveVeniceModelPrivacy("deepseek-v4-1-flash")).toBe("private");
    expect(await resolveVeniceModelPrivacy("a-model-nobody-lists")).toBeNull();
    expect(await resolveVeniceModelPrivacy("  ")).toBeNull();
  });

  it("does not take a model with no stated privacy as private", async () => {
    global.fetch = jest.fn().mockResolvedValue(listResponse([
      entry("kimi-k2-6", "private"),
      entry("brand-new-model", undefined),
    ])) as unknown as typeof fetch;
    expect(await resolveVeniceModelPrivacy("brand-new-model")).toBeNull();
  });

  it("uses only the catalog while Venice cannot be reached, then recovers", async () => {
    jest.useFakeTimers();
    try {
      global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
      expect(await resolveVeniceModelPrivacy("deepseek-v4-1-flash")).toBe("private");
      expect(await resolveVeniceModelPrivacy("tts-kokoro")).toBeNull();

      global.fetch = jest.fn().mockResolvedValue(listResponse([entry("tts-kokoro", "private", "tts")])) as unknown as typeof fetch;
      // Still inside the short retry window: no new fetch yet.
      expect(await resolveVeniceModelPrivacy("tts-kokoro")).toBeNull();
      jest.advanceTimersByTime(31_000);
      expect(await resolveVeniceModelPrivacy("tts-kokoro")).toBe("private");
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps the last good list when a later refresh fails", async () => {
    jest.useFakeTimers();
    try {
      global.fetch = jest.fn().mockResolvedValue(listResponse([entry("tts-kokoro", "private", "tts")])) as unknown as typeof fetch;
      expect(await resolveVeniceModelPrivacy("tts-kokoro")).toBe("private");
      jest.advanceTimersByTime(11 * 60 * 1000);
      global.fetch = jest.fn().mockResolvedValue(listResponse([], 500)) as unknown as typeof fetch;
      expect(await resolveVeniceModelPrivacy("tts-kokoro")).toBe("private");
    } finally {
      jest.useRealTimers();
    }
  });

  it("treats a list that states no privacy at all as a failed refresh", async () => {
    global.fetch = jest.fn().mockResolvedValue(listResponse([entry("tts-kokoro", undefined, "tts")])) as unknown as typeof fetch;
    expect(await resolveVeniceModelPrivacy("tts-kokoro")).toBeNull();
    expect(await resolveVeniceModelPrivacy("deepseek-v4-1-flash")).toBe("private");
  });

  it("retries without the key when Venice refuses it", async () => {
    process.env.VENICE_API_KEY = "venice_test_key";
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(listResponse([entry("tts-kokoro", "private", "tts")]));
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await resolveVeniceModelPrivacy("tts-kokoro")).toBe("private");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer venice_test_key");
    expect((fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers.Authorization).toBeUndefined();
  });

  it("shares one fetch between lookups that start together", async () => {
    global.fetch = jest.fn().mockResolvedValue(listResponse([entry("tts-kokoro", "private", "tts")])) as unknown as typeof fetch;
    const [a, lookup] = await Promise.all([resolveVeniceModelPrivacy("tts-kokoro"), getVeniceModelPrivacyLookup()]);
    expect(a).toBe("private");
    expect(lookup("tts-kokoro")).toBe("private");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
