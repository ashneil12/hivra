// Personal agents: permissive OpenClaw alternatives with their own WebUI or chat surface.
import type { CatalogAppManifest } from "../schema";

export const PERSONAL_AGENT_MANIFESTS: readonly CatalogAppManifest[] = [
  {
    id: "nanobot",
    name: "Nanobot",
    vendor: "HKUDS",
    category: "agent",
    license: "MIT",
    sourceUrl: "https://github.com/HKUDS/nanobot",
    tagline: "Lightweight MIT-licensed personal AI agent with its own WebUI and messaging channels.",
    description: "A lightweight open-source personal agent with a built-in WebUI and chat channels.",
    capabilityLine: "Nanobot's own WebUI, terminal and files on its own computer.",
    badge: "Personal",
    accent: "#38bdf8",
    icon: "bot",
    jobs: ["assistant", "messages", "automation"],
    keywords: ["nanobot", "hkuds", "personal", "lightweight", "openclaw", "telegram", "whatsapp", "python", "webui"],
    talk: "In Nanobot's own WebUI, or from messaging channels you connect inside it.",
    firstTasks: [
      {
        title: "Connect a messaging channel",
        prompt: "Walk me through connecting my Telegram or WhatsApp channel so I can message you from my phone.",
      },
      {
        title: "Daily summary",
        prompt: "Set up a daily morning briefing covering <the topics I track> and save your notes in my workspace.",
      },
    ],
    minPlan: "pro",
    weight: 1,
    floor: { cpu: 1, ram: 2 },
    recommended: { cpu: 1, ram: 2 },
    candidates: [{ cpu: 2, ram: 4 }, { cpu: 1, ram: 2 }],
    cpuOptions: [1, 2, 4, 8],
    ramOptions: [2, 4, 8, 16],
    managedVenice: true,
    llm: { wire: "openai", providers: ["venice"] },
    runtime: {
      kind: "cli-web",
      installer: { method: "uv-tool", packageName: "nanobot-ai", binName: "nanobot" },
      webService: {
        args: ["webui", "--host", "127.0.0.1", "--port", "3201", "--yes"],
        hostPort: 3201,
        healthPath: "/",
        proxyMode: "standard",
      },
      modelEnv: {
        apiKeyVar: "OPENAI_API_KEY",
        baseUrlVar: "OPENAI_BASE_URL",
        modelVar: "OPENAI_MODEL",
      },
    },
    seo: {
      metaTitle: "Nanobot Hosting: Lightweight Personal Agent on a Cloud Computer",
      metaDescription: "Run HKUDS Nanobot on a managed cloud VM with its built-in WebUI, persistent files and messaging channels. From $9.99/mo.",
      summary: "Run the MIT-licensed Nanobot personal agent on a dedicated cloud computer with its official installer and built-in WebUI behind Hivra sign-in.",
    },
  },
  {
    id: "zeroclaw",
    name: "ZeroClaw",
    vendor: "ZeroClaw Labs",
    category: "agent",
    license: "MIT OR Apache-2.0",
    sourceUrl: "https://github.com/zeroclaw-labs/zeroclaw",
    tagline: "Single-binary Rust personal agent with 30+ messaging channels and low overhead.",
    description: "A fast Rust personal agent runtime with terminal access and 30+ messaging channels.",
    capabilityLine: "ZeroClaw CLI, Hivra chat, terminal and files on its own computer.",
    badge: "Rust agent",
    accent: "#f97316",
    icon: "cpu",
    jobs: ["messages", "assistant", "automation"],
    keywords: ["zeroclaw", "rust", "personal", "openclaw", "discord", "telegram", "matrix", "channels", "mcp"],
    talk: "In Hivra's chat and Terminal, or through the messaging channels you configure in ZeroClaw.",
    firstTasks: [
      {
        title: "Run quickstart",
        prompt: "Check your current ZeroClaw configuration and show me which providers and channels are ready.",
      },
      {
        title: "Configure a channel",
        prompt: "Help me configure a Discord or Telegram channel in ZeroClaw using my bot token.",
      },
    ],
    minPlan: "pro",
    weight: 1,
    floor: { cpu: 0.5, ram: 1 },
    recommended: { cpu: 1, ram: 2 },
    candidates: [{ cpu: 1, ram: 2 }, { cpu: 0.5, ram: 1 }],
    cpuOptions: [0.5, 1, 2, 4, 8],
    ramOptions: [1, 2, 4, 8, 16],
    managedVenice: true,
    llm: { wire: "openai", providers: ["venice"] },
    runtime: {
      kind: "cli-web",
      installer: {
        method: "github-release-tar",
        repo: "zeroclaw-labs/zeroclaw",
        binName: "zeroclaw",
        assetX64: "zeroclaw-x86_64-unknown-linux-gnu.tar.gz",
        assetArm64: "zeroclaw-aarch64-unknown-linux-gnu.tar.gz",
      },
      cliChat: {
        args: ["agent", "--agent", "hivra", "-m"],
        promptVia: "arg",
      },
      setup: {
        // `zeroclaw agent` requires a configured [agents.<alias>] plus resolvable
        // risk/runtime profile entries; created headlessly via `config set`
        // (quickstart is interactive-only). Provider wiring is skipped when the
        // launch picked no model.
        commands: [
          "zeroclaw agents create hivra 2>/dev/null || true",
          "zeroclaw config init risk_profiles.default",
          "zeroclaw config init runtime_profiles.default",
          'if [ -n "$OPENAI_API_KEY" ] && [ -n "$OPENAI_BASE_URL" ] && [ -n "$OPENAI_MODEL" ]; then zeroclaw config set --no-interactive providers.models.openai.default.uri "$OPENAI_BASE_URL" && zeroclaw config set --no-interactive providers.models.openai.default.model "$OPENAI_MODEL" && zeroclaw config set --no-interactive providers.models.openai.default.api_key "$OPENAI_API_KEY" && zeroclaw config set --no-interactive agents.hivra.model_provider openai.default; fi',
          "zeroclaw config set --no-interactive agents.hivra.risk_profile default",
          "zeroclaw config set --no-interactive agents.hivra.runtime_profile default",
        ],
      },
      modelEnv: {
        apiKeyVar: "OPENAI_API_KEY",
        baseUrlVar: "OPENAI_BASE_URL",
        modelVar: "OPENAI_MODEL",
      },
    },
    seo: {
      metaTitle: "ZeroClaw Hosting: Fast Rust Personal Agent in the Cloud",
      metaDescription: "Deploy the open-source ZeroClaw Rust personal agent on an isolated cloud computer with persistent config and messaging channels. From $9.99/mo.",
      summary: "Run the MIT/Apache-2.0 ZeroClaw Rust agent binary on an isolated cloud computer with terminal access and persistent workspace storage.",
    },
  },
  {
    id: "picoclaw",
    name: "PicoClaw",
    vendor: "Sipeed",
    category: "agent",
    license: "MIT",
    sourceUrl: "https://github.com/sipeed/picoclaw",
    tagline: "Ultra-lightweight Go personal agent with a built-in launcher WebUI.",
    description: "A tiny Go personal assistant with its own launcher WebUI and minimal memory footprint.",
    capabilityLine: "PicoClaw's launcher WebUI, terminal and files on its own computer.",
    badge: "Ultra-light",
    accent: "#14b8a6",
    icon: "bot",
    jobs: ["assistant", "messages"],
    keywords: ["picoclaw", "sipeed", "go", "lightweight", "openclaw", "nanobot", "personal", "webui"],
    talk: "In PicoClaw's own launcher WebUI, or from messaging channels you configure inside it.",
    firstTasks: [
      {
        title: "Check agent status",
        prompt: "Verify my configured models and tools in PicoClaw and suggest three useful routines.",
      },
      {
        title: "Automate a check",
        prompt: "Create a routine that summarizes updates from <website or feed> into a workspace note.",
      },
    ],
    minPlan: "pro",
    weight: 1,
    floor: { cpu: 0.5, ram: 1 },
    recommended: { cpu: 1, ram: 2 },
    candidates: [{ cpu: 1, ram: 2 }, { cpu: 0.5, ram: 1 }],
    cpuOptions: [0.5, 1, 2, 4, 8],
    ramOptions: [1, 2, 4, 8, 16],
    managedVenice: true,
    llm: { wire: "openai", providers: ["venice"] },
    runtime: {
      kind: "cli-web",
      installer: {
        method: "github-release-tar",
        repo: "sipeed/picoclaw",
        binName: "picoclaw",
        assetX64: "picoclaw_Linux_x86_64.tar.gz",
        assetArm64: "picoclaw_Linux_arm64.tar.gz",
      },
      webService: {
        binName: "picoclaw-launcher",
        args: ["-no-browser", "-host", "127.0.0.1", "-port", "3202"],
        hostPort: 3202,
        healthPath: "/",
        proxyMode: "standard",
      },
      setup: {
        // PicoClaw does not read OPENAI_* directly. Initialise its config,
        // then use its non-interactive OpenAI-compatible endpoint command so
        // the launcher can start the gateway with a usable default model.
        commands: [
          'if [ ! -f "$HOME/.picoclaw/config.json" ]; then picoclaw onboard; fi',
          'if [ -n "$OPENAI_API_KEY" ] && [ -n "$OPENAI_BASE_URL" ] && [ -n "$OPENAI_MODEL" ]; then picoclaw model add --api-base "$OPENAI_BASE_URL" --api-key "$OPENAI_API_KEY" --model "$OPENAI_MODEL" --name hivra; fi',
        ],
      },
      modelEnv: {
        apiKeyVar: "OPENAI_API_KEY",
        baseUrlVar: "OPENAI_BASE_URL",
        modelVar: "OPENAI_MODEL",
      },
    },
    seo: {
      metaTitle: "PicoClaw Hosting: Ultra-Light Go Personal Agent in the Cloud",
      metaDescription: "Host Sipeed's MIT-licensed PicoClaw personal agent with its launcher WebUI on a dedicated cloud computer. From $9.99/mo.",
      summary: "Run Sipeed's MIT-licensed Go personal agent PicoClaw with its official launcher WebUI behind Hivra's authenticated gateway.",
    },
  },
];
