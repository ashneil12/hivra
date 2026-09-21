// Curated TOOLS catalog — modular agent add-ons (Wave 6).
//
// A "tool" is the join of three axes that already ship separately on a Hivra CLI
// box: an MCP server (the capability), the credentials that MCP server needs, and
// optionally the curated skills + a soul fragment that teach the agent to USE it.
// Installing a tool is one action; under the hood it fans out to the existing
// MCP-add and skill-install plumbing (see lib/hivra/tool-install.ts).
//
// WHY A SEPARATE OBJECT FROM SKILLS: a skill is markdown with no credentials; an
// MCP server is a capability with credentials but no curation. Neither alone is
// "give my agent crypto research". A ToolEntry is the curated bundle.
//
// SCOPE (v1): stdio MCP servers only (command + args + env). The credential rides
// the MCP server's OWN per-server `env` block — NOT a box-side env file — because
// the box's chat server sources `~/.hivra/bankr.env` by filename only and never
// echoes an MCP server's env back through GET /api/mcp (verified against
// hivra-chat/server.js on 2026-07-23). That makes tool credentials safe (0600 in
// the box home, never returned to the dashboard) and needs ZERO box-code change.
//
// Forward-compat fields (`requires`, http/sse transport) are typed but NOT
// implemented in v1 — a non-stdio entry is rejected at install time with a clear
// error rather than silently mis-installed. See isInstallableToolEntry.

interface ToolMcpSpec {
  /**
   * stdio  — a local process (npx/uvx). Works on claude-code AND codex.
   * http   — a hosted remote MCP endpoint (url + auth headers). claude-code ONLY:
   *          codex's TOML has no settled remote-server shape, so http tools are
   *          skipped with reason "unsupported-on-codex" rather than mis-written.
   */
  transport?: "stdio" | "http";
  /** The MCP server name as it appears in the box config. [A-Za-z0-9_-]{1,40}. */
  name: string;
  /** stdio: the executable (e.g. "npx", "uvx"). */
  command?: string;
  /**
   * stdio: args (e.g. ["-y", "mcp-searxng"]). May contain `{ENV_KEY}` placeholders
   * which are substituted with the user's value for that declared env field — for
   * tools that only accept credentials as CLI flags (e.g. `--key {GOPLUS_KEY}`).
   * NOTE: a substituted secret is visible in the box's own process list. Only use
   * arg placeholders when the tool offers no env-var alternative.
   */
  args?: string[];
  /** http: the remote endpoint. */
  url?: string;
  /**
   * http: auth headers. Values may contain `{ENV_KEY}` placeholders substituted
   * with the user's declared env values (e.g. {"NANSEN-API-KEY": "{NANSEN_API_KEY}"}).
   * Headers are written into the box config only — never echoed back by /api/mcp.
   */
  headers?: Record<string, string>;
}

interface ToolEnvField {
  /** The env var the MCP server reads (e.g. "SEARXNG_URL", "API_KEY"). */
  key: string;
  /** Human label for the install form. */
  label: string;
  /** Redact in the form + never log the value. */
  secret: boolean;
  /** Block install until provided. Optional-with-default fields set false. */
  required: boolean;
  /** Prefilled default (e.g. a public SearXNG URL). Never a secret's value. */
  placeholder?: string;
}

export interface ToolEntry {
  id: string;
  name: string;
  description: string;
  category: string; // research | crypto | outreach | data | devops
  trust: "builtin" | "trusted" | "community";

  /** The capability. Installed via `claude mcp add` / codex TOML. */
  mcp: ToolMcpSpec;

  /** Credentials the MCP server needs, collected in the install form. */
  env?: ToolEnvField[];

  /** Curated skill ids (src/data/curated-skills.ts) that teach the tool's use. */
  skillIds?: string[];

  /** Appended to SOUL.md under a removable fenced marker — never replaces it. */
  promptFragment?: string;

  /** Optional link to the underlying open-source GitHub repository for credit. */
  repoUrl?: string;

  /**
   * Forward-compat: tools that need more than an MCP server (a box container, an
   * apt package). NOT implemented in v1 — an entry that sets this is non-installable
   * until the box-side capability lands. Kept in the type so the catalog can be
   * authored ahead of the runtime.
   */
  requires?: { apt?: string[]; docker?: { image: string; port: number } };
}

// v1 catalog. Deliberately additive — every entry gives the agent a power it does
// NOT already have natively (the CLI agents already do web fetch/search + a
// preinstalled browser, so generic research tools are excluded). Crypto/on-chain
// is the focus; Scrapling adds adaptive anti-bot scraping beyond the native
// browser. Boxes have both `npx` (node) and `uvx` (python), so both runtimes are
// one-click. Every package below is published + verified to exist. See
// HIVRA_TOOL_MARKETPLACE_PLAN.md.
export const CURATED_TOOLS: ToolEntry[] = [
  {
    id: "crypto-trading-agents",
    name: "TradingAgents",
    description:
      "Multi-agent financial trading & market analysis framework. Evaluates fundamentals, technical indicators (RSI, MACD, Bollinger Bands), order books, and market sentiment for automated trading.",
    category: "crypto",
    trust: "trusted",
    repoUrl: "https://github.com/TauricResearch/TradingAgents",
    mcp: {
      transport: "stdio",
      name: "tradingagents",
      command: "npx",
      args: ["-y", "@mcpfun/mcp-server-ccxt"],
    },
  },
  {
    id: "research-agent-reach",
    name: "Agent Reach",
    description:
      "Social media intelligence, X/Twitter/Reddit research, viral reach tracking, and community trend mining for AI agents.",
    category: "research",
    trust: "trusted",
    repoUrl: "https://github.com/Panniantong/Agent-Reach",
    mcp: {
      transport: "stdio",
      name: "agentreach",
      command: "npx",
      args: ["-y", "@apify/actors-mcp-server"],
    },
    env: [
      {
        key: "APIFY_TOKEN",
        label: "Apify API token",
        secret: true,
        required: false,
        placeholder: "(optional — apify_api_…)",
      },
    ],
  },
  {
    id: "crypto-vibe-trading",
    name: "Vibe Trading",
    description:
      "Multi-agent LLM financial trading framework from HKU Data Intelligence Lab. Macro sentiment scoring, FRED economic feeds, yield metrics, and market vibe analysis.",
    category: "crypto",
    trust: "trusted",
    repoUrl: "https://github.com/HKUDS/Vibe-Trading",
    mcp: {
      transport: "stdio",
      name: "vibetrading",
      command: "npx",
      args: ["-y", "fred-mcp-server"],
    },
  },
  {
    id: "research-tavily-search",
    name: "Tavily AI Search",
    description:
      "Real-time web search, deep research crawling, and clean markdown content extraction tailored for LLM reasoning and RAG workflows.",
    category: "research",
    trust: "trusted",
    repoUrl: "https://github.com/tavily-ai/tavily-mcp",
    mcp: {
      transport: "stdio",
      name: "tavily",
      command: "npx",
      args: ["-y", "@tavily/mcp"],
    },
    env: [
      {
        key: "TAVILY_API_KEY",
        label: "Tavily API key",
        secret: true,
        required: true,
        placeholder: "tvly-…",
      },
    ],
  },
  {
    id: "research-exa-search",
    name: "Exa Deep Search",
    description:
      "Neural web search, code search, company intelligence, and semantic similarity search for deep research agents.",
    category: "research",
    trust: "trusted",
    repoUrl: "https://github.com/exa-labs/exa-mcp-server",
    mcp: {
      transport: "stdio",
      name: "exa",
      command: "npx",
      args: ["-y", "exa-mcp-server"],
    },
    env: [
      {
        key: "EXA_API_KEY",
        label: "Exa API key",
        secret: true,
        required: true,
      },
    ],
  },
  {
    id: "data-posthog-analytics",
    name: "PostHog Analytics",
    description:
      "Query product analytics events, inspect user funnels, triage errors, and manage feature flags directly within agent workflows.",
    category: "data",
    trust: "trusted",
    repoUrl: "https://github.com/PostHog/mcp",
    mcp: {
      transport: "stdio",
      name: "posthog",
      command: "npx",
      args: ["-y", "@posthog/mcp-server-posthog"],
    },
    env: [
      {
        key: "POSTHOG_API_KEY",
        label: "PostHog Personal API key",
        secret: true,
        required: true,
      },
    ],
  },
  {
    id: "data-supabase-backend",
    name: "Supabase",
    description:
      "Manage PostgreSQL schemas, execute database queries, inspect RLS security policies, and manage Supabase storage/auth.",
    category: "data",
    trust: "trusted",
    repoUrl: "https://github.com/supabase/mcp",
    mcp: {
      transport: "stdio",
      name: "supabase",
      command: "npx",
      args: ["-y", "@supabase/mcp-server-supabase"],
    },
    env: [
      {
        key: "SUPABASE_ACCESS_TOKEN",
        label: "Supabase Access token",
        secret: true,
        required: true,
      },
    ],
  },
  {
    id: "research-knowledge-memory",
    name: "Memory Knowledge Graph",
    description:
      "Persistent graph-based memory for agents — track user preferences, entities, relationships, and context across long-running sessions.",
    category: "research",
    trust: "trusted",
    repoUrl: "https://github.com/modelcontextprotocol/servers",
    mcp: {
      transport: "stdio",
      name: "memory",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
  },
  {
    id: "crypto-evm-onchain",
    name: "On-chain Explorer (EVM)",
    description:
      "Read transactions, balances, tokens, NFTs and ENS across 30+ EVM chains including Base — no key needed (public RPC). The 'check this wallet / this tx' tool.",
    category: "crypto",
    trust: "trusted",
    repoUrl: "https://github.com/mcpdotdirect/evm-mcp-server",
    mcp: {
      transport: "stdio",
      name: "evm",
      command: "npx",
      args: ["-y", "@mcpdotdirect/evm-mcp-server"],
    },
  },
  {
    id: "crypto-research-coingecko",
    name: "Crypto Prices (CoinGecko)",
    description:
      "Live token prices, market data and on-chain metrics via the official CoinGecko MCP server. Free public tier works with no key.",
    category: "crypto",
    trust: "trusted",
    repoUrl: "https://github.com/coingecko/coingecko-mcp",
    mcp: {
      transport: "stdio",
      name: "coingecko",
      command: "npx",
      args: ["-y", "@coingecko/coingecko-mcp"],
    },
    env: [
      {
        key: "COINGECKO_PRO_API_KEY",
        label: "CoinGecko API key",
        secret: true,
        required: false,
        placeholder: "(optional — omit for the free public tier)",
      },
    ],
  },
  {
    id: "crypto-coinmarketcap",
    name: "Crypto Prices (CoinMarketCap)",
    description:
      "Prices, market cap, rankings and metadata from CoinMarketCap. An alternative/second source to CoinGecko.",
    category: "crypto",
    trust: "trusted",
    mcp: {
      transport: "stdio",
      name: "coinmarketcap",
      command: "npx",
      args: ["-y", "coinmarketcap-mcp"],
    },
    env: [
      {
        key: "COINMARKETCAP_API_KEY",
        label: "CoinMarketCap API key",
        secret: true,
        required: true,
        placeholder: "CMC-…",
      },
    ],
  },
  {
    id: "crypto-bankless-onchain",
    name: "On-chain Data (Bankless)",
    description:
      "Contract reads, event logs, ABIs, proxy resolution and token/price data via the Bankless on-chain API. Deeper than an explorer for reading contract state.",
    category: "crypto",
    trust: "trusted",
    mcp: {
      transport: "stdio",
      name: "bankless",
      command: "npx",
      args: ["-y", "@bankless/onchain-mcp"],
    },
    env: [
      {
        key: "BANKLESS_API_TOKEN",
        label: "Bankless API token",
        secret: true,
        required: true,
        placeholder: "bankless_…",
      },
    ],
  },
  // ---- v1.1: hosted (http) + higher-leverage tools -------------------------
  // Deliberately NO SaaS-app aggregators — the Composio Connect integration
  // (lib/composio) already covers 500+ apps with managed OAuth. These add powers
  // Composio does NOT: crypto intel, scraping at scale, and media generation.
  {
    id: "crypto-hive-intelligence",
    name: "Hive Intelligence (350+ crypto tools)",
    description:
      "One connection, 350+ crypto tools normalized behind a single hosted MCP — DefiLlama, GoPlus, Helius, CCXT, LunarCrush, GeckoTerminal, DeBank and more. The highest-leverage crypto install: replaces a dozen separate integrations.",
    category: "crypto",
    trust: "community",
    mcp: {
      transport: "http",
      name: "hive",
      url: "https://mcp.hiveintelligence.xyz/mcp",
      headers: { Authorization: "Bearer {HIVE_API_KEY}" },
    },
    env: [
      { key: "HIVE_API_KEY", label: "Hive API key", secret: true, required: true, placeholder: "hive_live_…" },
    ],
  },
  {
    id: "crypto-nansen",
    name: "Nansen (smart-money labels)",
    description:
      "Nansen's Smart Money wallet labels across 25+ chains — see which named funds and whales are accumulating a token before the crowd. Labels you cannot derive from raw RPC.",
    category: "crypto",
    trust: "trusted",
    mcp: {
      transport: "http",
      name: "nansen",
      url: "https://mcp.nansen.ai/ra/mcp",
      headers: { "NANSEN-API-KEY": "{NANSEN_API_KEY}" },
    },
    env: [
      { key: "NANSEN_API_KEY", label: "Nansen API key", secret: true, required: true },
    ],
  },
  {
    id: "crypto-goplus-security",
    name: "GoPlus Security (rug / honeypot check)",
    description:
      "Pre-trade safety oracle across 40+ EVM chains, Solana and Sui: honeypot detection, hidden-mint and tax flags, LP-lock and holder-concentration checks, malicious-address screening. The 'is this a scam' gate before any swap.",
    category: "crypto",
    trust: "trusted",
    repoUrl: "https://github.com/GoPlusSecurity/goplus-mcp",
    mcp: { transport: "stdio", name: "goplus", command: "npx", args: ["-y", "goplus-mcp@latest"] },
    env: [
      { key: "GOPLUS_API_KEY", label: "GoPlus app key", secret: true, required: true },
      { key: "GOPLUS_API_SECRET", label: "GoPlus app secret", secret: true, required: true },
    ],
  },
  {
    id: "crypto-ccxt-exchanges",
    name: "CCXT (100+ exchanges)",
    description:
      "Unified market data across 100+ centralized exchanges via the battle-tested CCXT library — order books, funding rates, OHLCV, tickers. Public market data needs no key.",
    category: "crypto",
    trust: "trusted",
    repoUrl: "https://github.com/ccxt/ccxt",
    mcp: { transport: "stdio", name: "ccxt", command: "npx", args: ["-y", "@mcpfun/mcp-server-ccxt"] },
  },
  {
    id: "scraping-apify",
    name: "Apify Actors (6,000+ scrapers)",
    description:
      "One connection unlocks thousands of ready-made scrapers the agent discovers and runs as tools — Google Maps reviews, Instagram, TikTok, Amazon, Trustpilot, LinkedIn and more. An entire scraping app-store.",
    category: "research",
    trust: "trusted",
    repoUrl: "https://github.com/apify/apify-sdk-js",
    mcp: { transport: "stdio", name: "apify", command: "npx", args: ["-y", "@apify/actors-mcp-server"] },
    env: [
      { key: "APIFY_TOKEN", label: "Apify API token", secret: true, required: true, placeholder: "apify_api_…" },
    ],
  },
  {
    id: "scraping-brightdata",
    name: "Bright Data (never get blocked)",
    description:
      "Web Unlocker-grade fetching with anti-bot and CAPTCHA handling, plus SERP-as-data. For sites that defeat ordinary scraping.",
    category: "research",
    trust: "trusted",
    repoUrl: "https://github.com/bright-data/mcp",
    mcp: { transport: "stdio", name: "brightdata", command: "npx", args: ["-y", "@brightdata/mcp"] },
    env: [
      { key: "API_TOKEN", label: "Bright Data API token", secret: true, required: true },
    ],
  },
  {
    id: "media-elevenlabs",
    name: "ElevenLabs (voice)",
    description:
      "Studio-grade text-to-speech, voice cloning, speech-to-text and dubbing across many languages. Let the agent speak in a brand voice or dub a video.",
    category: "media",
    trust: "trusted",
    repoUrl: "https://github.com/elevenlabs/elevenlabs-mcp",
    mcp: { transport: "stdio", name: "elevenlabs", command: "uvx", args: ["elevenlabs-mcp"] },
    env: [
      { key: "ELEVENLABS_API_KEY", label: "ElevenLabs API key", secret: true, required: true },
    ],
  },
  {
    id: "media-fal",
    name: "fal.ai (image + video generation)",
    description:
      "600+ media models on fast serverless GPUs — FLUX/SDXL images plus text-to-video. New models appear without reinstalling.",
    category: "media",
    trust: "trusted",
    repoUrl: "https://github.com/fal-ai/fal-mcp-server",
    mcp: { transport: "stdio", name: "fal", command: "uvx", args: ["--from", "fal-mcp-server", "fal-mcp"] },
    env: [
      { key: "FAL_KEY", label: "fal.ai API key", secret: true, required: true },
    ],
  },
  {
    id: "scrapling-fetch",
    name: "Scrapling (stealth scraping)",
    description:
      "Adaptive, anti-bot web scraping — fetch pages that block ordinary requests, with session handling. Goes beyond the agent's built-in fetch. Runs via uvx (Python).",
    category: "research",
    trust: "trusted",
    repoUrl: "https://github.com/D4Vinci/Scrapling",
    mcp: {
      transport: "stdio",
      name: "scrapling",
      command: "uvx",
      args: ["scrapling-fetch-mcp"],
    },
  },
];

const TOOL_BY_ID = new Map<string, ToolEntry>(CURATED_TOOLS.map((t) => [t.id, t]));

export function getToolById(id: string): ToolEntry | undefined {
  return TOOL_BY_ID.get(id);
}

/**
 * v1 install eligibility: a stdio MCP server with a valid box-safe name and a
 * command. http/sse transports and `requires`-gated tools are typed but not yet
 * runnable, so they are NOT installable and the picker/installer must skip them.
 */
export const TOOL_MCP_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function isInstallableToolEntry(t: ToolEntry): boolean {
  if (t.requires) return false; // box-side capability not built yet
  const m = t.mcp;
  if (!TOOL_MCP_NAME_RE.test(m.name)) return false;
  const transport = m.transport ?? "stdio";
  if (transport === "stdio") {
    return Boolean(m.command && m.command.trim() && !m.command.startsWith("-"));
  }
  if (transport === "http") {
    return Boolean(m.url && /^https:\/\//.test(m.url));
  }
  return false;
}

/** http tools are claude-code only (codex has no settled remote-server shape). */
export function isToolSupportedOnKind(t: ToolEntry, kind: "claude" | "codex"): boolean {
  if ((t.mcp.transport ?? "stdio") === "http") return kind === "claude";
  return true;
}
