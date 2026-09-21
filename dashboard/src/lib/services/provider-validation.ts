const PROVIDER_ENDPOINTS: Record<string, { url: string; headers: Record<string, string> }> = {
  openrouter: {
    url: "https://openrouter.ai/api/v1/auth/key",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  bankr: {
    url: "https://llm.bankr.bot/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    headers: {
      "x-api-key": "{API_KEY}",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
  },
  nous: {
    // Must match the inference endpoint used in hetzner-instance-service.ts
    url: "https://inference-api.nousresearch.com/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  "nous-portal": {
    url: "https://inference-api.nousresearch.com/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  crof: {
    url: "https://crof.ai/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  deepseek: {
    url: "https://api.deepseek.com/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  venice: {
    url: "https://api.venice.ai/api/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  cometapi: {
    url: "https://api.cometapi.com/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  minimax: {
    url: "https://api.minimax.chat/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  groq: {
    url: "https://api.groq.com/openai/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models?key={API_KEY}",
    headers: {},
  },
  xai: {
    url: "https://api.x.ai/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  alibaba: {
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  moonshot: {
    url: "https://api.moonshot.cn/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  zhipu: {
    url: "https://open.bigmodel.cn/api/paas/v4/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  xiaomi: {
    url: "https://platform.xiaomimimo.com/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
  surplus: {
    url: "https://www.surplusintelligence.ai/api/inference/v1/models",
    headers: { Authorization: "Bearer {API_KEY}" },
  },
};

const VALIDATION_TIMEOUT_MS = 10_000;

function buildRequest(provider: string, apiKey: string): { url: string; options: RequestInit } {
  const config = PROVIDER_ENDPOINTS[provider];
  if (!config) {
    return {
      url: "https://api.openai.com/v1/models",
      options: {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      },
    };
  }

  const url = config.url.replace("{API_KEY}", apiKey);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers)) {
    headers[key] = value.replace("{API_KEY}", apiKey);
  }

  const isAnthropic = provider === "anthropic";
  const options: RequestInit = {
    method: isAnthropic ? "POST" : "GET",
    headers,
    signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
  };

  if (isAnthropic) {
    options.body = JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    });
  }

  return { url, options };
}

export async function validateProviderApiKey(
  provider: string,
  apiKey: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    const { url, options } = buildRequest(provider, apiKey);
    const response = await fetch(url, options);

    if (response.ok) {
      return { valid: true };
    }

    let errorMessage: string | undefined;
    try {
      const body = await response.json();
      errorMessage = body.error?.message || body.message || body.detail;
    } catch {
      // Body not parseable, use status-based message
    }

    if (!errorMessage) {
      switch (response.status) {
        case 401:
          errorMessage = "Invalid API key";
          break;
        case 403:
          errorMessage = "API key lacks permission";
          break;
        case 429:
          errorMessage = "Rate limited";
          break;
        default:
          errorMessage = `Provider returned HTTP ${response.status}`;
      }
    }

    return { valid: false, error: redactSensitiveCommandOutput(errorMessage, 200) };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { valid: false, error: "Request timed out — provider may be unreachable" };
    }
    return {
      valid: false,
      error: err instanceof Error
        ? redactSensitiveCommandOutput(err.message, 200)
        : "Unknown validation error",
    };
  }
}
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
