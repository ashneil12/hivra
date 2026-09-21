export interface Provider {
  id: string;
  name: string;
  desc: string;
  hint: string;
  keyLabel?: string;
  hidden?: boolean;
  models: { value: string; label: string }[];
}

export const FEATURED_PROVIDER_ID = "venice";

const QUICK_SELECT_PROVIDER_IDS = [
  "opengateway",
  "bankr",
  "openrouter",
  "nous",
  "codex",
  "crof",
] as const;

function isProviderVisible(provider: Provider): boolean {
  return !provider.hidden;
}

export function getFeaturedProvider(providers: Provider[]): Provider | undefined {
  return providers.find(
    (provider) => provider.id === FEATURED_PROVIDER_ID && isProviderVisible(provider),
  );
}

export function getQuickSelectProviders(providers: Provider[]): Provider[] {
  return QUICK_SELECT_PROVIDER_IDS
    .map((providerId) => providers.find((provider) => provider.id === providerId))
    .filter((provider): provider is Provider => Boolean(provider));
}

export function getOverflowProviders(providers: Provider[]): Provider[] {
  const quickSelectIds = new Set<string>(QUICK_SELECT_PROVIDER_IDS);
  return providers.filter(
    (provider) =>
      !quickSelectIds.has(provider.id)
      && provider.id !== FEATURED_PROVIDER_ID
      && !provider.hidden,
  );
}

// OpenRouter model aliases: maps legacy/wrong IDs to correct OpenRouter IDs
const OPENROUTER_MODEL_ALIASES: Record<string, string> = {
  'google/gemma-4-26b-it': 'google/gemma-4-26b-a4b-it',
  // Legacy naming conventions
  'google/gemini-3-flash': 'google/gemini-3-flash-preview',
  'deepseek/deepseek-reasoner': 'deepseek/deepseek-chat',
  'x-ai/grok-4.1-fast-reasoning': 'x-ai/grok-4.1-fast',
  'x-ai/grok-4.1-fast-non-reasoning': 'x-ai/grok-4-fast',
  'nvidia/nemotron-3-super-120b': 'nvidia/nemotron-3-super-120b-a12b',
  // Zhipu -> Z.ai provider migration
  'zhipu/glm-5.1': 'z-ai/glm-5.1',
  'zhipu/glm-5v-turbo': 'z-ai/glm-5v-turbo',
};

const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  // Snapshot-style IDs briefly leaked into the picker; normalize them back to the
  // current direct Anthropic IDs so saved configs continue to work.
  "claude-opus-4-1-20250805": "claude-opus-4-7",
  "claude-opus-4-20250514": "claude-opus-4-6",
  "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
};

const MODEL_PROVIDER_INFERENCE_PREFERENCES: Record<string, string> = {
  "kimi-k2.6": "moonshot",
};


export function normalizeModelValue(modelValue: string, provider?: string | null): string {
  const trimmed = modelValue.trim();
  if (!trimmed) return trimmed;

  if (provider === "openrouter" || trimmed in OPENROUTER_MODEL_ALIASES) {
    return OPENROUTER_MODEL_ALIASES[trimmed] ?? trimmed;
  }

  if (provider === "anthropic" || trimmed in ANTHROPIC_MODEL_ALIASES) {
    return ANTHROPIC_MODEL_ALIASES[trimmed] ?? trimmed;
  }

  return trimmed;
}

export const PROVIDERS: Provider[] = [
  {
    id: "opengateway",
    name: "OpenGateway",
    desc: "gitlawb's open LLM gateway (any key works)",
    hint: "gitlawb.com",
    keyLabel: "OpenGateway Token (any placeholder while partnership window is open)",
    models: [
      { value: "mimo-v2.5-pro", label: "MiMo v2.5 Pro (Default)" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    desc: "Claude Fable 5, Opus 4.8 & Legacy",
    hint: "console.anthropic.com",
    models: [
      // Fable 5 (GA 2026-06-09) is Anthropic's most capable widely released
      // model — a Mythos-class model with always-on adaptive thinking. High-risk
      // queries (cyber/bio/distillation) auto-fall back to Opus 4.8 upstream.
      { value: "claude-fable-5", label: "Claude Fable 5 (Flagship)" },
      // Opus 4.8 (GA 2026-05-28) — current Opus tier, same $5/$25 price as 4.7
      // but materially better at agentic coding; the zero-config deploy default.
      { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 (Fast)" },
      { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (Legacy)" },
      { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku (Legacy)" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    desc: "All providers, one key",
    hint: "openrouter.ai",
models: [
      // OpenAI
      { value: 'openai/gpt-5.4-pro', label: 'GPT-5.4 Pro' },
      { value: 'openai/gpt-5.4', label: 'GPT-5.4 (Flagship)' },
      { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { value: 'openai/gpt-5.4-nano', label: 'GPT-5.4 Nano' },
      { value: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { value: 'openai/gpt-5.2-codex', label: 'GPT-5.2 Codex' },
      { value: 'openai/gpt-oss-120b', label: 'GPT OSS 120B' },
      // Anthropic
      { value: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7' },
      { value: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6' },
      { value: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
      { value: 'anthropic/claude-opus-4.5', label: 'Claude Opus 4.5' },
      { value: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      // Google
      { value: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
      { value: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
      { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (Stable)' },
      { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { value: 'google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B' },
      { value: 'google/gemma-4-31b-it', label: 'Gemma 4 31B' },
      { value: 'google/gemma-3-27b-it', label: 'Gemma 3 27B' },
      // DeepSeek
      { value: 'deepseek/deepseek-chat', label: 'DeepSeek V3.2 Chat' },
      { value: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2 (Latest)' },
      // xAI Grok
      { value: 'x-ai/grok-4.1-fast', label: 'Grok 4.1 Fast' },
      { value: 'x-ai/grok-4-fast', label: 'Grok 4 Fast' },
      { value: 'x-ai/grok-4.20', label: 'Grok 4.20' },
      { value: 'x-ai/grok-4.20-multi-agent', label: 'Grok 4.20 Multi-Agent' },
      // Qwen
      { value: 'qwen/qwen3.6-plus', label: 'Qwen 3.6 Plus' },
      { value: 'qwen/qwen3.5-plus-02-15', label: 'Qwen 3.5 Plus' },
      { value: 'qwen/qwen3.5-397b-a17b', label: 'Qwen 3.5 397B' },
      { value: 'qwen/qwen3-max-thinking', label: 'Qwen3 Max Thinking' },
      { value: 'qwen/qwen3-coder-plus', label: 'Qwen3 Coder Plus' },
      // NVIDIA
      { value: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B' },
      // Moonshot
      { value: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
      { value: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5' },
      // Z.ai (Zhipu via OpenRouter)
      { value: 'z-ai/glm-5.1', label: 'GLM-5.1' },
      { value: 'z-ai/glm-5v-turbo', label: 'GLM-5V-Turbo' },
      { value: 'z-ai/glm-5-turbo', label: 'GLM-5 Turbo' },
      // MiniMax
      { value: 'minimax/minimax-m2.7', label: 'MiniMax M2.7 (Agentic)' },
      { value: 'minimax/minimax-m2.5', label: 'MiniMax M2.5' },
      // Mistral
      { value: 'mistralai/mistral-small-2603', label: 'Mistral Small 4' },
    ],
  },
  {
    id: "crof",
    name: "CrofAI",
    desc: "OpenAI-Compatible Gateway",
    hint: "crof.ai",
    keyLabel: "CrofAI API Key",
    models: [
      { value: "glm-5.1", label: "GLM-5.1" },
      { value: "glm-5.1-precision", label: "GLM-5.1 Precision" },
      { value: "greg", label: "Greg" },
      { value: "kimi-k2.6", label: "Kimi K2.6 (Regular)" },
      { value: "kimi-k2.6-precision", label: "Kimi K2.6 (Precision)" },
      { value: "kimi-k2.5", label: "Kimi K2.5" },
      { value: "kimi-k2.5-lightning", label: "Kimi K2.5 Lightning" },
      { value: "glm-5", label: "GLM-5" },
      { value: "glm-4.7", label: "GLM-4.7" },
      { value: "glm-4.7-flash", label: "GLM-4.7 Flash" },
      { value: "gemma-4-31b-it", label: "Gemma 4 31B It" },
      { value: "minimax-m2.5", label: "MiniMax M2.5" },
      { value: "qwen3.5-397b-a17b", label: "Qwen 3.5 397B" },
      { value: "qwen3.5-9b", label: "Qwen 3.5 9B" },
      { value: "qwen3.5-9b-chat", label: "Qwen 3.5 9B Chat" },
      { value: "deepseek-v3.2", label: "DeepSeek V3.2" },
    ],
  },
  {
    id: "nous",
    name: "Nous Portal",
    desc: "Hermes + routed model catalog",
    hint: "portal.nousresearch.com",
    keyLabel: "Nous Portal API Key",
    models: [
      { value: "nousresearch/hermes-4-405b", label: "Hermes 4 405B" },
      { value: "nousresearch/hermes-4-70b", label: "Hermes 4 70B" },
      { value: "nousresearch/hermes-3-llama-3.1-405b", label: "Hermes 3 405B" },
      { value: "nousresearch/hermes-3-llama-3.1-405b:free", label: "Hermes 3 405B (Free)" },
      { value: "nousresearch/hermes-3-llama-3.1-70b", label: "Hermes 3 70B" },
      { value: "nousresearch/hermes-2-pro-llama-3-8b", label: "Hermes 2 Pro 8B" },
    ],
  },
  {
    id: "codex",
    name: "ChatGPT OAuth",
    desc: "ChatGPT Plus via OAuth",
    hint: "Connect via Dashboard after deployment",
    keyLabel: "Codex Token",
    models: [
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
      { value: "gpt-5.3-chat-latest", label: "GPT-5.3-Codex" },
      { value: "gpt-5.2", label: "GPT-5.2" },
    ],
  },
  {
    id: "venice",
    name: "Venice AI",
    desc: "OpenAI-compatible Venice models",
    hint: "venice.ai",
    keyLabel: "Venice API Key",
    models: [
      // Venice defaults & top recommendations
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash (via Venice · recommended)' },
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro (via Venice)' },
      { value: 'deepseek-v3.2', label: 'DeepSeek V3.2 (via Venice)' },
      { value: 'kimi-k2-6', label: 'Kimi K2.6 (via Venice)' },
      { value: 'zai-org-glm-4.7', label: 'GLM 4.7 (via Venice)' },
      { value: 'zai-org-glm-5-1', label: 'GLM 5.1 (via Venice · code-optimized)' },
      { value: 'zai-org-glm-5', label: 'GLM 5 (via Venice)' },
      { value: 'claude-fable-5', label: 'Claude Fable 5 (via Venice)' },
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8 (via Venice)' },
      { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (via Venice)' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (via Venice)' },
      { value: 'openai-gpt-55', label: 'GPT-5.5 (via Venice)' },
      { value: 'grok-4-3', label: 'Grok 4.3 (via Venice)' },
      { value: 'minimax-m27', label: 'MiniMax M2.7 (via Venice)' },
      // Task-specific defaults
      { value: 'qwen3-235b-a22b-thinking-2507', label: 'Qwen3 235B Thinking (via Venice · reasoning)' },
      { value: 'qwen3-coder-480b-a35b-instruct-turbo', label: 'Qwen3 Coder 480B Turbo (via Venice · code)' },
      { value: 'qwen3-vl-235b-a22b', label: 'Qwen3 VL 235B (via Venice · vision)' },
      // Anthropic family
      { value: 'claude-opus-4-6', label: 'Claude Opus 4.6 (via Venice)' },
      { value: 'claude-opus-4-6-fast', label: 'Claude Opus 4.6 Fast (via Venice)' },
      { value: 'claude-opus-4-5', label: 'Claude Opus 4.5 (via Venice)' },
      { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (via Venice)' },
      // OpenAI family
      { value: 'openai-gpt-55-pro', label: 'GPT-5.5 Pro (via Venice)' },
      { value: 'openai-gpt-52', label: 'GPT-5.2 (via Venice)' },
      { value: 'openai-gpt-oss-120b', label: 'GPT OSS 120B (via Venice)' },
      // Google family
      { value: 'gemini-3-1-pro-preview', label: 'Gemini 3.1 Pro Preview (via Venice)' },
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview (via Venice)' },
      { value: 'google-gemma-4-31b-it', label: 'Gemma 4 31B (via Venice)' },
      { value: 'google-gemma-4-26b-a4b-it', label: 'Gemma 4 26B (via Venice)' },
      // xAI Grok
      { value: 'grok-4-20', label: 'Grok 4.20 (via Venice)' },
      { value: 'grok-4-20-multi-agent', label: 'Grok 4.20 Multi-Agent (via Venice)' },
      // Moonshot
      { value: 'kimi-k2-5', label: 'Kimi K2.5 (via Venice)' },
      // GLM variants
      { value: 'z-ai-glm-5v-turbo', label: 'GLM 5V Turbo (via Venice · multimodal)' },
      { value: 'z-ai-glm-5-turbo', label: 'GLM 5 Turbo (via Venice · code)' },
      { value: 'zai-org-glm-4.7-flash', label: 'GLM 4.7 Flash (via Venice)' },
      // Specialty
      { value: 'arcee-trinity-large-thinking', label: 'Trinity Large Thinking (via Venice)' },
      { value: 'qwen-3-6-plus', label: 'Qwen 3.6 Plus Uncensored (via Venice · recommended)' },
      // Uncensored (Venice-native)
      { value: 'venice-uncensored-1-2', label: 'Venice Uncensored 1.2 (most uncensored)' },
      { value: 'venice-uncensored-role-play', label: 'Venice Uncensored Role-Play' },
      { value: 'olafangensan-glm-4.7-flash-heretic', label: 'GLM 4.7 Flash Heretic (via Venice · uncensored)' },
      { value: 'gemma-4-uncensored', label: 'Gemma 4 Uncensored (via Venice)' },
      // E2EE (end-to-end encrypted via Venice)
      { value: 'e2ee-glm-5-1', label: 'GLM 5.1 E2EE (encrypted via Venice)' },
      { value: 'e2ee-gpt-oss-120b-p', label: 'GPT OSS 120B E2EE (encrypted via Venice)' },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    desc: "V3.2 Chat & Reasoner",
    hint: "platform.deepseek.com",
    models: [
      { value: "deepseek-chat", label: "DeepSeek V3.2 (Chat, Fast)" },
      { value: "deepseek-reasoner", label: "DeepSeek V3.2 (Reasoner, CoT)" },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    desc: "M2.7, M2.5 & M1",
    hint: "minimaxi.com/platform",
    keyLabel: "MiniMax API Key",
    models: [
      { value: "minimax-m2.7", label: "MiniMax M2.7 (Agentic, Mar 2026)" },
      { value: "minimax-m2.7-highspeed", label: "MiniMax M2.7 Highspeed" },
      { value: "minimax-m2.5", label: "MiniMax M2.5 (Productivity, Feb 2026)" },
      { value: "minimax-m1-80k", label: "MiniMax M1 80K (1M ctx, Reasoning)" },
    ],
  },
  {
    id: "openai",
    name: "ChatGPT (API)",
    desc: "GPT-5.5 soon, GPT-5.4, Codex, OSS",
    hint: "platform.openai.com",
    models: [
      { value: "gpt-5.5", label: "GPT-5.5 (API soon)" },
      { value: "gpt-5.5-pro", label: "GPT-5.5 Pro (API soon)" },
      { value: "gpt-5.4-thinking", label: "GPT-5.4 Thinking" },
      { value: "gpt-5.4-pro", label: "GPT-5.4 Pro" },
      { value: "gpt-5.4", label: "GPT-5.4 (Flagship)" },
      { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      { value: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex (Coding)" },
      { value: "gpt-oss-120b", label: "GPT OSS 120B (Open Weight)" },
      { value: "gpt-oss-20b", label: "GPT OSS 20B (Lightweight)" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    desc: "Ultra-fast LPU inference",
    hint: "console.groq.com",
    models: [
      { value: "openai/gpt-oss-120b", label: "GPT OSS 120B (via Groq)" },
      { value: "openai/gpt-oss-20b", label: "GPT OSS 20B (via Groq)" },
      { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B" },
      { value: "qwen/qwen3-32b", label: "Qwen3 32B" },
      { value: "whisper-large-v3", label: "Whisper Large V3" },
    ],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    desc: "Grok 4.20 & 4.1",
    hint: "x.ai/api",
    keyLabel: "xAI API Key",
    models: [
      { value: "grok-4.20-0309-reasoning", label: "Grok 4.20 Reasoning (Mar 2026)" },
      { value: "grok-4.20-0309-non-reasoning", label: "Grok 4.20 Non-Reasoning (Mar 2026)" },
      { value: "grok-4.20-multi-agent-0309", label: "Grok 4.20 Multi-Agent (Mar 2026)" },
      { value: "grok-4-1-fast-reasoning", label: "Grok 4.1 Fast Reasoning" },
      { value: "grok-4-1-fast-non-reasoning", label: "Grok 4.1 Fast Non-Reasoning" },
      { value: "grok-3", label: "Grok 3 (Stable)" },
    ],
  },
  {
    id: "xai-oauth",
    name: "xAI Grok (SuperGrok OAuth)",
    desc: "Grok 4.3 via your SuperGrok subscription",
    hint: "Sign in via Hermes WebUI after deployment",
    keyLabel: "SuperGrok OAuth Session",
    models: [
      { value: "grok-4.3", label: "Grok 4.3 (Default)" },
      { value: "grok-4.20-0309-reasoning", label: "Grok 4.20 Reasoning" },
      { value: "grok-4.20-0309-non-reasoning", label: "Grok 4.20 Non-Reasoning" },
      { value: "grok-4.20-multi-agent-0309", label: "Grok 4.20 Multi-Agent" },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    desc: "Gemini 3.5 Flash, 3.1 Pro & 2.5 Stable",
    hint: "aistudio.google.com",
    keyLabel: "Google AI Studio API Key",
    models: [
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash (Default)" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Stable)" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Stable)" },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot AI",
    desc: "Kimi K2.6, K2.5 & K2",
    hint: "platform.moonshot.cn",
    keyLabel: "Moonshot API Key",
    models: [
      { value: "kimi-k2.6", label: "Kimi K2.6 (Flagship, Apr 2026)" },
      { value: "kimi-k2.5", label: "Kimi K2.5 (Flagship, Jan 2026)" },
      { value: "kimi-k2-thinking", label: "Kimi K2 Thinking" },
      { value: "kimi-k2-0905-Preview", label: "Kimi K2 Preview (256K Ctx)" },
    ],
  },
  {
    id: "zhipu",
    name: "Zhipu AI",
    desc: "GLM-5.1 & GLM-5V",
    hint: "open.bigmodel.cn",
    keyLabel: "Zhipu (BigModel) API Key",
    models: [
      { value: "glm-5.1", label: "GLM-5.1 (Flagship, Apr 2026)" },
      { value: "glm-5v-turbo", label: "GLM-5V-Turbo (Multimodal)" },
      { value: "glm-5", label: "GLM-5 (Agentic flagship, Feb 2026)" },
      { value: "glm-4.7-flash", label: "GLM-4.7 Flash" },
      { value: "glm-4-assistant", label: "GLM-4 Assistant" },
    ],
  },
  {
    id: "alibaba",
    name: "Alibaba Cloud",
    desc: "Qwen 3.6 & 3.5 Series",
    hint: "dashscope.aliyun.com",
    keyLabel: "DashScope API Key",
    models: [
      { value: "qwen3.6-max-preview", label: "Qwen 3.6 Max Preview" },
      { value: "qwen3.6-plus", label: "Qwen 3.6 Plus (Apr 2026)" },
      { value: "qwen3.6-flash", label: "Qwen 3.6 Flash" },
      { value: "qwen3.6-35b-a3b", label: "Qwen 3.6 35B A3B" },
      { value: "qwen3.5-plus", label: "Qwen 3.5 Plus (Coding Plan)" },
      { value: "qwen3-max-2026-01-23", label: "Qwen3 Max (Jan 2026)" },
      { value: "qwen3-coder-next", label: "Qwen3 Coder Next" },
    ],
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    desc: "MiMo v2 Pro & Flash",
    hint: "platform.xiaomimimo.com",
    keyLabel: "Xiaomi MiMo API Key",
    models: [
      { value: "mimo-v2-pro", label: "MiMo v2 Pro" },
      { value: "mimo-v2-flash", label: "MiMo v2 Flash" },
      { value: "mimo-v2-omni", label: "MiMo v2 Omni" },
    ],
  },
  {
    id: "bankr",
    name: "Bankr LLM Gateway",
    desc: "Claude, GPT, Gemini & more",
    hint: "bankr.bot/api",
    keyLabel: "Bankr LLM Key",
    models: [
      { value: "claude-opus-4.7", label: "Claude Opus 4.7" },
      { value: "claude-opus-4.6", label: "Claude Opus 4.6" },
      { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
      { value: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
      { value: "gemini-3-flash", label: "Gemini 3 Flash" },
      { value: "gemma-4-31b-it", label: "Gemma 4 31B" },
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
      { value: "grok-4.20", label: "Grok 4.20" },
      { value: "glm-5.1", label: "GLM-5.1" },
      { value: "deepseek-v3.2", label: "DeepSeek V3.2" },
      { value: "minimax-m2.7", label: "MiniMax M2.7" },
      { value: "kimi-k2.6", label: "Kimi K2.6" },
      { value: "qwen3-coder", label: "Qwen3 Coder" },
      { value: "qwen3.5-plus", label: "Qwen3.5 Plus" },
    ],
  },
  {
    id: "surplus",
    name: "Surplus Intelligence",
    desc: "Open market — routes to the cheapest seller",
    hint: "surplusintelligence.ai",
    keyLabel: "Surplus Intelligence Key (inf_...)",
    // Surplus is a marketplace: live discovery (PROVIDER_MODEL_ENDPOINTS) fills
    // the real, seller-backed catalog once a key is present. This static seed is
    // just the documented chat models so the picker isn't empty pre-key.
    models: [
      { value: "claude-opus-4.6", label: "Claude Opus 4.6" },
      { value: "llama-3.3-70b", label: "Llama 3.3 70B" },
    ],
  },
  {
    id: "cometapi",
    name: "CometAPI",
    desc: "OpenAI-compatible multi-model gateway",
    hint: "api.cometapi.com",
    keyLabel: "CometAPI Key",
    hidden: true,
    models: [
      { value: "gpt-5.5-all", label: "GPT-5.5 All" },
      { value: "gpt-5.5-medium-all", label: "GPT-5.5 Medium All" },
      { value: "gpt-5.5-high-all", label: "GPT-5.5 High All" },
      { value: "gpt-5.5-xhigh-all", label: "GPT-5.5 XHigh All" },
      { value: "gpt-5.5-low-all", label: "GPT-5.5 Low All" },
      { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "gpt-5.4-pro", label: "GPT-5.4 Pro" },
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "qwen3-max-2026-01-23", label: "Qwen3 Max" },
      { value: "kimi-k2.5", label: "Kimi K2.5" },
      { value: "glm-5", label: "GLM-5" },
      { value: "minimax-m2.5", label: "MiniMax M2.5" },
    ],
  },
  {
    id: "custom_llm",
    name: "Custom LLM Provider",
    desc: "Bring Your Own OpenAI Compatible API",
    hint: "e.g., vLLM, LM Studio, Ollama, self-hosted API",
    keyLabel: "API Key (Optional if local)",
    models: [
      { value: "custom", label: "Custom Model" },
    ],
  },
];

export function inferProviderFromModel(modelValue: string, providerList: Provider[] = PROVIDERS): string | null {
  const normalizedModelValue = normalizeModelValue(modelValue);
  const preferredProviderId = MODEL_PROVIDER_INFERENCE_PREFERENCES[normalizedModelValue];

  if (preferredProviderId) {
    const preferredProvider = providerList.find((provider) => provider.id === preferredProviderId);
    if (preferredProvider?.models.some((model) => model.value === normalizedModelValue)) {
      return preferredProvider.id;
    }
  }

  for (const provider of providerList) {
    if (provider.models.some((m) => m.value === normalizedModelValue)) {
      return provider.id;
    }
  }
  return null;
}

export const VISIBLE_PROVIDERS = PROVIDERS.filter(isProviderVisible);

export function isModelValidForProvider(
  modelValue: string,
  providerId: string,
  providerList: Provider[] = PROVIDERS,
): boolean {
  const provider = providerList.find((candidate) => candidate.id === providerId);
  if (!provider) return false;
  const normalized = normalizeModelValue(modelValue, providerId);
  return provider.models.some((model) => model.value === normalized);
}

// Repair a stranded model/provider pairing. The model is the anchor: if the
// given provider cannot serve it but the model unambiguously belongs to another
// provider's catalog, return that provider instead. Unknown/BYOK providers and
// unknown models are left untouched so we never hijack a model we cannot
// validate. This is what stops a provider auto-switch from stranding e.g.
// `gpt-5.5` on `xai-oauth` (a 404-guaranteed pair).
export function reconcileModelProvider(
  modelValue: string,
  providerId: string,
  providerList: Provider[] = PROVIDERS,
): string {
  const provider = providerList.find((candidate) => candidate.id === providerId);
  if (!provider || provider.id === "custom_llm") return providerId;
  if (isModelValidForProvider(modelValue, providerId, providerList)) return providerId;
  const inferred = inferProviderFromModel(modelValue, providerList);
  return inferred && inferred !== providerId ? inferred : providerId;
}
