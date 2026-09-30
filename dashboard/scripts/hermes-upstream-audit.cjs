#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

process.env.TS_NODE_TRANSPILE_ONLY = "true";
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});

require("ts-node/register/transpile-only");

const {
  extractContractsFromSource,
  extractVersionFromPyproject,
  renderHermesAuditMarkdown,
  scanApiSurface,
} = require("../src/lib/hermes-upstream-audit");

const execFileAsync = promisify(execFile);

const DEFAULT_OUTPUT = "dashboard/hermes_upstream_audit.md";
const CONTRACT_FILES = [
  "dashboard/src/app/api/instances/[id]/skills/route.ts",
  "dashboard/src/app/api/instances/[id]/oauth/providers/route.ts",
  "dashboard/src/app/api/instances/[id]/oauth/providers/[provider]/start/route.ts",
  "dashboard/src/app/api/instances/[id]/oauth/providers/[provider]/poll/[sessionId]/route.ts",
  "dashboard/src/app/api/instances/[id]/profiles/[name]/route.ts",
  "dashboard/src/app/api/instances/[id]/send-stream/route.ts",
  "dashboard/src/lib/responses-proxy-request.ts",
];
const SUPPORT_FILES = [
  "dashboard/src/lib/services/hetzner-instance-builders.ts",
  "dashboard/src/lib/services/hetzner-instance-service.ts",
  "dashboard/src/lib/services/provider-config.ts",
  "dashboard/src/app/api/instances/[id]/route.ts",
  "dashboard/src/app/api/instances/[id]/oauth/providers/route.ts",
  "dashboard/src/app/api/instances/[id]/oauth/providers/[provider]/start/route.ts",
  "dashboard/src/app/api/instances/[id]/oauth/providers/[provider]/poll/[sessionId]/route.ts",
  "dashboard/src/app/api/instances/[id]/oauth/providers/nous/status/route.ts",
  "dashboard/src/app/api/instances/[id]/skills/route.ts",
  "dashboard/src/lib/launch/runtime-requests.ts",
  "dashboard/src/app/dashboard/instances/[id]/console/tabs/AgentConfigurationTab.tsx",
  "dashboard/src/app/dashboard/instances/[id]/console/tabs/config-sections/NousToolGatewayBlock.tsx",
  "dashboard/src/components/chat/AgentProfileSettingsPanel.tsx",
  "dashboard/src/components/chat/NousPortalOAuthModal.tsx",
  "dashboard/src/app/dashboard/instances/[id]/console/tabs/config-sections/SearchProviderBlock.tsx",
  "dashboard/src/app/dashboard/instances/[id]/console/tabs/config-sections/BrowserEnvironmentBlock.tsx",
  "dashboard/src/components/TerminalPanel.tsx",
  "dashboard/src/components/NativeTuiPanel.tsx",
  "dashboard/src/components/chat/ChatInput.tsx",
  "dashboard/src/components/chat/ChatInput.module.css",
  "dashboard/src/data/slash-commands.ts",
  "dashboard/src/app/dashboard/skills/page.tsx",
  "dashboard/src/components/skills/SkillDiscoveryPanel.tsx",
  "dashboard/src/data/curated-skills.ts",
  "dashboard/src/app/api/instances/[id]/browser-stream/route.ts",
  "dashboard/src/app/api/instances/[id]/browser-sessions/route.ts",
];

function parseArgs(argv) {
  const args = {
    repoRoot: path.resolve(__dirname, "../.."),
    output: DEFAULT_OUTPUT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      args.repoRoot = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === "--output") {
      args.output = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function gitLsRemote(repo, ref) {
  const { stdout } = await execFileAsync("git", ["ls-remote", repo, ref]);
  const firstLine = stdout.trim().split("\n")[0] || "";
  const sha = firstLine.split(/\s+/)[0];
  if (!sha) {
    throw new Error(`Unable to resolve ${ref} for ${repo}`);
  }
  return sha;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "HermesDeploy-Upstream-Audit/1.0",
      Accept: "text/plain, application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url} (HTTP ${response.status})`);
  }

  return response.text();
}

async function fetchOptionalText(url) {
  try {
    return await fetchText(url);
  } catch {
    return null;
  }
}

async function readContractFile(repoRoot, relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function uniqueSorted(items) {
  return Array.from(new Set(items)).sort((left, right) => left.localeCompare(right));
}

function uniqueInOrder(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function parseReleaseHighlights(releaseNotes) {
  if (!releaseNotes) {
    return [];
  }

  const highlights = [];
  const lines = releaseNotes.split("\n");

  for (const line of lines) {
    const match = line.match(/^- \*\*(.+?)\*\* — (.+)$/);
    if (match) {
      highlights.push(`${match[1]} — ${match[2]}`);
    }
  }

  return uniqueInOrder(highlights);
}

function buildNarrative({
  releaseNotes,
  toolGatewayDoc,
  browserDoc,
  imageGenerationDoc,
  ttsDoc,
  tuiDoc,
  cliDoc,
  pluginsDoc,
  dashboardPluginsDoc,
  upstreamWebSource,
  deploySupportSource,
}) {
  const releaseHighlights = parseReleaseHighlights(releaseNotes);

  const upstreamHasToolGateway = Boolean(
    toolGatewayDoc &&
      toolGatewayDoc.includes("use_gateway: true") &&
      toolGatewayDoc.includes("Nous Portal") &&
      toolGatewayDoc.includes("browser automation"),
  );
  const upstreamMentionsModalAddon = Boolean(
    toolGatewayDoc && toolGatewayDoc.includes("Modal (serverless terminal backend)"),
  );
  const upstreamHasNousOauthWebApi = upstreamWebSource.includes("/api/providers/oauth");
  const deploySupportsPortalInferenceEndpoint = deploySupportSource.includes("https://inference-api.nousresearch.com/v1");
  const deploySupportsUseGatewayFlags = deploySupportSource.includes("use_gateway");
  const deploySupportsOauthProviderUi =
    /\/oauth\/providers|Connect Nous Portal|Connected to Nous Portal/.test(deploySupportSource);
  const deploySkipsInteractiveSetup = deploySupportSource.includes("HERMES_SKIP_SETUP=1");
  const deploySupportsDirectSearchKeys = /tavilyApiKey|exaApiKey|firecrawlApiKey/.test(deploySupportSource);
  const deploySupportsDirectBrowserProviders = /browserProvider|browserbaseApiKey|browserUseApiKey|camofox/.test(deploySupportSource);
  const deploySupportsImageGenConfig = /image_gen:/.test(deploySupportSource);
  const deploySupportsTtsConfig = /tts:/.test(deploySupportSource);
  const deploySupportsGatewayStatusSummary =
    /PORTAL STATUS|Nous Subscription via|Connected to Nous Portal/.test(deploySupportSource);
  const deploySupportsToolGatewayEnv = /TOOL_GATEWAY_DOMAIN|TOOL_GATEWAY_SCHEME|TOOL_GATEWAY_USER_TOKEN/.test(deploySupportSource);
  const deploySupportsAdvancedFirecrawl = /FIRECRAWL_API_URL|FIRECRAWL_BROWSER_TTL/.test(deploySupportSource);
  const deploySupportsAdvancedBrowser = /BROWSERBASE_PROXIES|BROWSERBASE_ADVANCED_STEALTH|BROWSERBASE_KEEP_ALIVE|BROWSER_INACTIVITY_TIMEOUT/.test(deploySupportSource);
  const upstreamHasInkTui = Boolean(
    releaseNotes?.includes("Ink-based TUI") ||
      tuiDoc?.includes("modern front-end for Hermes") ||
      tuiDoc?.includes("Slash autocompletion opens as a floating panel"),
  );
  const upstreamHasUnifiedSlashRegistry = Boolean(
    cliDoc?.includes("Installed skills also become slash commands automatically") ||
      releaseNotes?.includes("Persistent `_SlashWorker` subprocess") ||
      releaseNotes?.includes("Slash command autocomplete via `complete.slash` RPC"),
  );
  const upstreamHasPluginCommands = Boolean(
    pluginsDoc?.includes("ctx.register_command") ||
      releaseNotes?.includes("register_command"),
  );
  const upstreamHasDashboardPlugins = Boolean(
    dashboardPluginsDoc?.includes("custom tabs") ||
      releaseNotes?.includes("Dashboard plugin system"),
  );
  const deployHasXtermTerminal = deploySupportSource.includes("TerminalPanel") && deploySupportSource.includes("@xterm/xterm");
  const deployHasNativeTuiPanel = deploySupportSource.includes("NativeTuiPanel");
  const deployHasStaticSlashCommands =
    deploySupportSource.includes("SLASH_COMMANDS") &&
    deploySupportSource.includes("@/data/slash-commands");
  const deploySlashUsesPrefixSearch = deploySupportSource.includes("startsWith(slashQuery");
  const deployHasLiveSkillsApi =
    deploySupportSource.includes('api.get("/api/skills"') ||
    deploySupportSource.includes("buildSkillCategories") ||
    deploySupportSource.includes("Agent skills request failed.");
  const deployHasPluginRegistryUi = /plugins\.enabled|plugin registry|plugin marketplace|\/api\/plugins/.test(deploySupportSource);
  const deployHasBrowserStream = deploySupportSource.includes("browser-stream") && deploySupportSource.includes("Camofox");
  const deployHasBrowserCdpConfig = deploySupportSource.includes("BROWSER_CDP_URL") || deploySupportSource.includes("cdp_url");

  const whatMatters = [];
  const interestingChanges = [];
  const communityAngles = [];
  const currentSupport = [];
  const missingSupport = [];
  const productOpportunities = [];
  const implementationPlan = [];
  const decisionsNeeded = [];
  const exposeNow = [];
  const exposeLater = [];
  const keepAdvanced = [];
  const rolloutNotes = [];

  if (upstreamHasToolGateway) {
    whatMatters.push("Upstream Hermes now has a first-class Nous Tool Gateway model for paid Nous Portal subscribers instead of the older hidden managed-tools path.");
    whatMatters.push("Tool Gateway is optional and per-tool, not global: `web`, `image_gen`, `tts`, and `browser` each opt in separately via `use_gateway: true`.");
    whatMatters.push("When `use_gateway: true` is set, upstream runtime intentionally prefers the Nous gateway over direct API keys for that tool.");
  }

  if (browserDoc && browserDoc.includes("Browserbase cloud mode") && browserDoc.includes("Browser Use cloud mode") && browserDoc.includes("Firecrawl cloud mode")) {
    interestingChanges.push("Browser support is broader than just the Nous gateway story: upstream still supports Browserbase, Browser Use, Firecrawl, Camofox, local Chrome via CDP, and local browser mode.");
  }
  if (imageGenerationDoc && imageGenerationDoc.includes("Eight models are supported out of the box")) {
    interestingChanges.push("Image generation is more substantial than a simple FAL key hookup now: upstream documents eight supported image models with persistent model selection across direct and gateway-backed paths.");
  }
  if (ttsDoc && ttsDoc.includes("OpenAI TTS is available through the **[Tool Gateway")) {
    interestingChanges.push("TTS stayed optional too: users can mix gateway-backed OpenAI TTS with direct ElevenLabs, Edge, Mistral, Gemini, or NeuTTS depending on cost and quality preferences.");
  }
  if (upstreamMentionsModalAddon) {
    interestingChanges.push("Modal is called out separately as an optional add-on through Nous subscriptions, which means it should be treated as adjacent to Tool Gateway rather than bundled into the same dashboard toggle.");
  }

  if (upstreamHasToolGateway) {
    communityAngles.push("The clearest community-facing headline is: paid Nous Portal users can now unlock web, browser, image generation, and TTS without juggling separate third-party API accounts.");
    communityAngles.push("The second useful angle is flexibility: users can mix gateway-backed tools and direct vendor keys per tool instead of committing to one global mode.");
  }
  if (upstreamMentionsModalAddon) {
    communityAngles.push("A good clarification point for posts/docs is that Modal is optional and separate; people should not assume the base Tool Gateway prompt automatically covers terminal backends.");
  }
  if (upstreamHasInkTui) {
    communityAngles.push("Upstream's TUI work is more than a terminal facelift; it is a clearer command/composer interaction model that Hermes Deploy can adapt for the browser.");
  }
  if (upstreamHasUnifiedSlashRegistry || upstreamHasPluginCommands) {
    communityAngles.push("The strongest product story for power users is discoverability: skills, plugins, quick commands, and built-in commands should feel like one searchable command system.");
  }

  if (deploySupportsPortalInferenceEndpoint) {
    currentSupport.push("Hermes Deploy already supports Nous / `nous-portal` as an OpenAI-compatible inference endpoint for the LLM provider path.");
  }
  if (deploySupportsDirectSearchKeys) {
    currentSupport.push("Hermes Deploy already supports the direct-key tool path for web search and scraping via Tavily, Exa, and Firecrawl.");
  }
  if (deploySupportsDirectBrowserProviders) {
    currentSupport.push("Hermes Deploy already supports direct browser provider selection for local browser, Browserbase, Browser Use, and Camofox.");
  }
  if (deploySupportsUseGatewayFlags) {
    currentSupport.push("Hermes Deploy already exposes per-tool `use_gateway` toggles for `web`, `browser`, `image_gen`, and `tts` across deploy and live agent settings.");
  }
  if (deploySupportsOauthProviderUi && upstreamHasNousOauthWebApi) {
    currentSupport.push("Hermes Deploy already ships a first-class Nous Portal connection flow backed by the agent's OAuth provider API.");
  }
  if (deploySupportsImageGenConfig) {
    currentSupport.push("Hermes Deploy already writes an `image_gen` config section when gateway-backed image generation is enabled.");
  }
  if (deploySupportsTtsConfig) {
    currentSupport.push("Hermes Deploy already writes a `tts` config section when gateway-backed text-to-speech is enabled.");
  }
  if (deploySupportsGatewayStatusSummary) {
    currentSupport.push("Hermes Deploy already shows, per supported tool, whether the route is a direct provider path or the Nous subscription path.");
  }
  if (deployHasXtermTerminal) {
    currentSupport.push("Hermes Deploy already has an online terminal/TUI surface through `dashboard/src/components/TerminalPanel.tsx`, backed by `/api/instances/[id]/terminal/interactive`.");
  }
  if (deployHasNativeTuiPanel) {
    currentSupport.push("Hermes Deploy already has a `NativeTuiPanel` surface, so upstream TUI ideas have a natural place to land.");
  }
  if (deployHasStaticSlashCommands) {
    currentSupport.push("Hermes Deploy already has slash command autocomplete in chat, but it is currently fed by the static `dashboard/src/data/slash-commands.ts` list.");
  }
  if (deployHasLiveSkillsApi) {
    currentSupport.push("Hermes Deploy already reads live installed skills from the agent web API and builds skill categories from that payload.");
  }
  if (deployHasBrowserStream) {
    currentSupport.push("Hermes Deploy already has browser session/stream routes for Camofox readiness and viewing.");
  }
  currentSupport.push("Hermes Deploy already moved config and skills management onto the upstream web dashboard API, which reduces dependence on fork-only gateway management routes.");

  if (!deploySupportsUseGatewayFlags) {
    missingSupport.push("Hermes Deploy does not currently expose upstream `use_gateway` toggles for `web`, `image_gen`, `tts`, or `browser`.");
  }
  if (!deploySupportsOauthProviderUi && upstreamHasNousOauthWebApi) {
    missingSupport.push("Hermes Deploy does not currently integrate the upgraded agent's `/api/providers/oauth` surface, so there is no first-class 'Connect Nous Portal' flow in the dashboard.");
  }
  if (!deploySupportsImageGenConfig) {
    missingSupport.push("Hermes Deploy does not currently write an `image_gen` config section, so gateway-backed image generation preferences are not expressed in generated config.");
  }
  if (!deploySupportsTtsConfig) {
    missingSupport.push("Hermes Deploy does not currently write a `tts` config section, so gateway-backed or direct TTS preferences are not first-class deploy settings.");
  }
  if (!deploySupportsGatewayStatusSummary) {
    missingSupport.push("Hermes Deploy does not yet show, per tool, whether Hermes is routing through a direct provider path or the Nous subscription path.");
  }
  if (upstreamHasInkTui && deployHasXtermTerminal) {
    missingSupport.push("The online TUI is still terminal-stream-first; it does not yet expose upstream-style structured overlays for command completion, model/session picking, approvals, queued input, or live tool activity outside the xterm frame.");
  }
  if (deployHasStaticSlashCommands) {
    missingSupport.push("Slash command discovery is not yet generated from the same source as live skills or upstream/plugin command registries, so it can drift and miss commands.");
  }
  if (deploySlashUsesPrefixSearch) {
    missingSupport.push("Slash search is prefix-only today; it does not support fuzzy search, category browsing, aliases, or a richer command palette.");
  }
  if (upstreamHasPluginCommands && !deployHasPluginRegistryUi) {
    missingSupport.push("Hermes Deploy does not yet have a first-class plugin registry UI or command source, so upstream plugin slash commands cannot be surfaced cleanly in the dashboard.");
  }
  if (browserDoc && browserDoc.includes("Local Chrome via CDP") && !deployHasBrowserCdpConfig) {
    missingSupport.push("Local Chrome/CDP support is upstream-visible, but Hermes Deploy does not yet expose a dashboard-native CDP connection or status flow.");
  }

  if (upstreamHasInkTui) {
    productOpportunities.push(
      "Online TUI upgrade: borrow upstream's TUI interaction model rather than copying terminal rendering wholesale. Keep xterm for the raw terminal, but add web-native overlays for command completion, model/session pickers, approval prompts, queued input, and live tool activity.",
    );
  }
  if (upstreamHasUnifiedSlashRegistry || upstreamHasPluginCommands) {
    productOpportunities.push(
      "Unified command registry: merge built-in commands, installed skills, future plugin commands, and quick commands into one dashboard command source so chat autocomplete and the skills area cannot drift apart.",
    );
  }
  if (deployHasStaticSlashCommands) {
    productOpportunities.push(
      "Slash command palette: replace the static flat picker with a category-aware, fuzzy-search palette opened by `/`, with Tab/Enter selection and clickable categories for browsing.",
    );
  }
  if (upstreamHasDashboardPlugins) {
    productOpportunities.push(
      "Skills/plugins area: treat plugins as a higher-power sibling to skills. The dashboard should explain which capabilities are prompt-only skills, executable plugin tools/hooks, dashboard tabs, or slash commands.",
    );
  }
  if (browserDoc && browserDoc.includes("Browser Use cloud mode")) {
    productOpportunities.push(
      "Browser setup: expose browser modes by user outcome, not provider name only: lowest-friction/local, cloud browser, anti-detect/persistent, Nous subscription gateway, and advanced CDP attach.",
    );
  }

  if (upstreamHasUnifiedSlashRegistry || deployHasStaticSlashCommands) {
    implementationPlan.push(
      "Phase 1 - command inventory: add a dashboard command registry API that combines static built-ins with live `/api/skills`, and leaves an extension point for upstream/plugin commands when the agent exposes them.",
    );
    implementationPlan.push(
      "Phase 2 - chat palette: refactor `ChatInput` to consume that registry, support fuzzy search, category filters, aliases, keyboard navigation, and `/` + Tab completion without relying on the generated static list alone.",
    );
  }
  if (upstreamHasInkTui) {
    implementationPlan.push(
      "Phase 3 - online TUI overlays: layer upstream-inspired web overlays on top of `TerminalPanel`/`NativeTuiPanel` for session picker, status/tool activity, approvals, and command completion while keeping raw xterm as the fallback.",
    );
  }
  if (upstreamHasPluginCommands || upstreamHasDashboardPlugins) {
    implementationPlan.push(
      "Phase 4 - skills/plugins unification: update the Skills area to show capability type, enabled state, source, category, and command trigger; plugins should appear as installable/enablable capability packs, not as unrelated plumbing.",
    );
  }
  if (browserDoc && (browserDoc.includes("Browser Use cloud mode") || browserDoc.includes("Local Chrome via CDP"))) {
    implementationPlan.push(
      "Phase 5 - browser mode polish: audit `BrowserEnvironmentBlock` against upstream browser modes, then add missing status/explanation for Browser Use, Camofox persistence, Nous gateway browser routing, and CDP/local-browser limits.",
    );
  }

  if (upstreamHasInkTui) {
    decisionsNeeded.push("Use a terminal-first online TUI with richer web overlays. Copy the upstream interaction patterns, not the whole Ink renderer.");
  }
  if (upstreamHasPluginCommands || upstreamHasDashboardPlugins) {
    decisionsNeeded.push("Keep plugins inside the existing Skills area as a capability type, with filters for skills, plugins, dashboard tabs, hooks, tools, and slash commands.");
  }
  if (deployHasStaticSlashCommands) {
    decisionsNeeded.push("Use this first command taxonomy: Session, Model & Tools, Skills, Plugins, Browser & Web, Marketing, and Quick Commands.");
  }
  if (browserDoc && browserDoc.includes("Local Chrome via CDP")) {
    decisionsNeeded.push("For local Chrome/CDP, expose status/config guidance now and defer a fuller local connector until the browser mode UI is stable.");
  }

  if (!deploySupportsUseGatewayFlags) {
    exposeNow.push("A per-tool 'Use Nous Subscription' toggle for `web`, `image_gen`, `tts`, and `browser`, backed by upstream `use_gateway: true` config.");
  }
  if (!deploySupportsOauthProviderUi && upstreamHasNousOauthWebApi) {
    exposeNow.push("A Nous Portal connection/status surface that uses the upgraded agent's OAuth provider API so users can see whether the agent actually has valid Portal auth.");
  }
  if (!deploySupportsGatewayStatusSummary) {
    exposeNow.push("A clear runtime status summary that shows, per tool, whether Hermes is using a direct vendor key or the Nous subscription path.");
  }
  if (deployHasStaticSlashCommands || upstreamHasUnifiedSlashRegistry) {
    exposeNow.push("A unified slash command palette backed by live skills plus built-in command metadata, because this is user-visible drift today and does not require waiting for the full upstream fork update.");
  }
  if (upstreamHasInkTui && deployHasXtermTerminal) {
    exposeNow.push("An online TUI discovery/design pass that maps upstream Ink TUI features onto Hermes Deploy's `TerminalPanel` and `NativeTuiPanel` surfaces before copying code.");
  }

  if (!deploySupportsAdvancedFirecrawl) {
    exposeLater.push("Advanced Firecrawl controls such as `FIRECRAWL_API_URL` and `FIRECRAWL_BROWSER_TTL`.");
  }
  if (!deploySupportsAdvancedBrowser) {
    exposeLater.push("Advanced Browserbase controls such as `BROWSERBASE_PROXIES`, `BROWSERBASE_ADVANCED_STEALTH`, `BROWSERBASE_KEEP_ALIVE`, and `BROWSER_INACTIVITY_TIMEOUT`.");
  }
  if (!deploySupportsToolGatewayEnv) {
    exposeLater.push("Advanced self-hosted gateway overrides such as `TOOL_GATEWAY_DOMAIN`, `TOOL_GATEWAY_SCHEME`, and `TOOL_GATEWAY_USER_TOKEN`.");
  }
  if (upstreamMentionsModalAddon) {
    exposeLater.push("Modal subscription-backed terminal options, but as a separate advanced track instead of bundling them into the first Tool Gateway UI pass.");
  }

  keepAdvanced.push("Low-level gateway override fields should stay in an advanced settings area rather than the main agent setup flow, because most users only need the simple 'Use Nous Subscription' choice.");
  keepAdvanced.push("Do not blur 'Nous as the LLM provider' with 'Nous Tool Gateway for tools' in the main UI; they are related but separate decisions.");

  rolloutNotes.push("The safest rollout is to add Tool Gateway as an explicit optional mode on top of the current direct-key paths, not replace the existing direct provider model.");
  rolloutNotes.push("The dashboard should treat Portal auth and per-tool gateway routing as distinct states: being able to use Nous for inference does not automatically mean the tool gateway is active.");
  rolloutNotes.push("Modal should be discussed as an optional add-on, not as part of the base Tool Gateway onboarding.");
  if (deploySkipsInteractiveSetup) {
    rolloutNotes.push("Hermes Deploy bootstraps agents with `HERMES_SKIP_SETUP=1`, so parity depends on dashboard-owned toggles and OAuth flows rather than upstream interactive setup prompts.");
  }

  return {
    releaseHighlights,
    whatMatters: uniqueInOrder(whatMatters),
    interestingChanges: uniqueInOrder(interestingChanges),
    communityAngles: uniqueInOrder(communityAngles),
    currentSupport: uniqueInOrder(currentSupport),
    missingSupport: uniqueInOrder(missingSupport),
    productOpportunities: uniqueInOrder(productOpportunities),
    implementationPlan: uniqueInOrder(implementationPlan),
    decisionsNeeded: uniqueInOrder(decisionsNeeded),
    exposeNow: uniqueInOrder(exposeNow),
    exposeLater: uniqueInOrder(exposeLater),
    keepAdvanced: uniqueInOrder(keepAdvanced),
    rolloutNotes: uniqueInOrder(rolloutNotes),
  };
}

function buildRisks({ dashboardContracts, upstreamGateway, upstreamWeb, forkGateway, upstream, fork }) {
  const high = [];
  const medium = [];
  const low = [];

  const configContracts = dashboardContracts.filter((contract) => contract.family === "config");
  const skillsContracts = dashboardContracts.filter((contract) => contract.family === "skills");
  const oauthContracts = dashboardContracts.filter((contract) => contract.family === "oauth");
  const openAiContracts = dashboardContracts.filter((contract) => contract.family === "openai");

  if (configContracts.some((contract) => !contract.viaAgentWebApi)) {
    high.push("Some config-management paths still bypass `agentWebApi`, which would break against upstream web dashboard auth.");
  }

  if (skillsContracts.some((contract) => !contract.viaAgentWebApi)) {
    high.push("Some skills-management paths still bypass `agentWebApi`, which risks reintroducing fork-only gateway dependencies.");
  }
  if (oauthContracts.some((contract) => !contract.viaAgentWebApi)) {
    high.push("Some OAuth provider flows still bypass `agentWebApi`, which would break against upstream web dashboard auth.");
  }

  if (configContracts.length > 0 && !upstreamWeb.hasGatewayConfig) {
    high.push("Upstream web_server no longer exposes `/api/config`, so dashboard config management would break.");
  }

  if (skillsContracts.length > 0 && !upstreamWeb.hasGatewaySkills) {
    high.push("Upstream web_server no longer exposes `/api/skills`, so dashboard skills management would break.");
  }
  if (oauthContracts.length > 0 && !upstreamWeb.hasProviderOAuth) {
    high.push("Upstream web_server no longer exposes `/api/providers/oauth`, so dashboard Portal auth would break.");
  }

  if (forkGateway.hasGatewayConfig && !upstreamGateway.hasGatewayConfig) {
    medium.push("The fork still exposes gateway `/api/config` while upstream gateway does not. Avoid reintroducing direct gateway config writes.");
  }

  if (forkGateway.hasGatewaySkills && !upstreamGateway.hasGatewaySkills) {
    medium.push("The fork still exposes gateway `/api/skills` while upstream gateway does not. Keep skills on the web dashboard API.");
  }

  if ((configContracts.length > 0 || skillsContracts.length > 0 || oauthContracts.length > 0) && upstreamWeb.hasSessionTokenInjection) {
    medium.push("Dashboard management still depends on upstream web dashboard session-token injection. If that bootstrap changes, `agentWebApi` must be updated.");
  }

  if (upstream.version && fork.version && upstream.version !== fork.version) {
    medium.push(`Fork version (${fork.version}) still differs from upstream (${upstream.version}).`);
  }

  if (upstreamGateway.hasRuns) {
    low.push("Upstream gateway exposes `/v1/runs`, which Hermes Deploy does not currently use.");
  }

  if (upstreamGateway.hasHealthDetailed) {
    low.push("Upstream gateway exposes `/health/detailed`, which Hermes Deploy does not currently use.");
  }

  if (openAiContracts.some((contract) => contract.endpoint === "/v1/models")) {
    low.push("`/v1/models` remains part of the dashboard contract and still appears stable across the current audit.");
  }

  return {
    high: uniqueSorted(high),
    medium: uniqueSorted(medium),
    low: uniqueSorted(low),
  };
}

async function buildAuditReport(repoRoot) {
  const upstreamRepo = "NousResearch/hermes-agent";
  const forkRepo = "ashneil12/vanilla-hermes-agent";

  const [
    upstreamRef,
    forkRef,
    upstreamPyproject,
    forkPyproject,
    upstreamGatewaySource,
    upstreamWebSource,
    forkGatewaySource,
  ] = await Promise.all([
    gitLsRemote(`https://github.com/${upstreamRepo}.git`, "refs/heads/main"),
    gitLsRemote(`https://github.com/${forkRepo}.git`, "refs/heads/main"),
    fetchText(`https://raw.githubusercontent.com/${upstreamRepo}/main/pyproject.toml`),
    fetchText(`https://raw.githubusercontent.com/${forkRepo}/main/pyproject.toml`),
    fetchText(`https://raw.githubusercontent.com/${upstreamRepo}/main/gateway/platforms/api_server.py`),
    fetchText(`https://raw.githubusercontent.com/${upstreamRepo}/main/hermes_cli/web_server.py`),
    fetchText(`https://raw.githubusercontent.com/${forkRepo}/main/gateway/platforms/api_server.py`),
  ]);

  const upstreamVersion = extractVersionFromPyproject(upstreamPyproject);
  const [
    releaseNotes,
    toolGatewayDoc,
    browserDoc,
    imageGenerationDoc,
    ttsDoc,
    tuiDoc,
    cliDoc,
    pluginsDoc,
    dashboardPluginsDoc,
  ] = await Promise.all([
    upstreamVersion
      ? fetchOptionalText(`https://raw.githubusercontent.com/${upstreamRepo}/main/RELEASE_v${upstreamVersion}.md`)
      : Promise.resolve(null),
    fetchOptionalText(`https://raw.githubusercontent.com/${upstreamRepo}/main/website/docs/user-guide/features/tool-gateway.md`),
    fetchOptionalText(`https://raw.githubusercontent.com/${upstreamRepo}/main/website/docs/user-guide/features/browser.md`),
    fetchOptionalText(`https://raw.githubusercontent.com/${upstreamRepo}/main/website/docs/user-guide/features/image-generation.md`),
    fetchOptionalText(`https://raw.githubusercontent.com/${upstreamRepo}/main/website/docs/user-guide/features/tts.md`),
    fetchOptionalText(`https://raw.githubusercontent.com/${upstreamRepo}/main/website/docs/user-guide/tui.md`),
    fetchOptionalText(`https://raw.githubusercontent.com/${upstreamRepo}/main/website/docs/user-guide/cli.md`),
    fetchOptionalText(`https://raw.githubusercontent.com/${upstreamRepo}/main/website/docs/user-guide/features/plugins.md`),
    fetchOptionalText(`https://raw.githubusercontent.com/${upstreamRepo}/main/website/docs/user-guide/features/dashboard-plugins.md`),
  ]);

  const dashboardContracts = [];
  for (const relativePath of CONTRACT_FILES) {
    const source = await readContractFile(repoRoot, relativePath);
    if (!source) continue;
    dashboardContracts.push(
      ...extractContractsFromSource(relativePath, source),
    );
  }

  const supportSources = await Promise.all(
    SUPPORT_FILES.map(async (relativePath) => {
      const source = await readContractFile(repoRoot, relativePath);
      return source ?? "";
    }),
  );
  const deploySupportSource = supportSources.join("\n");

  dashboardContracts.sort((left, right) => {
    if (left.path === right.path) {
      return left.endpoint.localeCompare(right.endpoint);
    }
    return left.path.localeCompare(right.path);
  });

  const upstream = {
    repo: upstreamRepo,
    ref: upstreamRef,
    version: upstreamVersion,
  };
  const fork = {
    repo: forkRepo,
    ref: forkRef,
    version: extractVersionFromPyproject(forkPyproject),
  };
  const upstreamGateway = scanApiSurface(upstreamGatewaySource);
  const upstreamWeb = scanApiSurface(upstreamWebSource);
  const forkGateway = scanApiSurface(forkGatewaySource);

  return {
    generatedAt: new Date().toISOString(),
    upstream,
    fork,
    upstreamGateway,
    upstreamWeb,
    forkGateway,
    dashboardContracts,
    narrative: buildNarrative({
      releaseNotes,
      toolGatewayDoc,
      browserDoc,
      imageGenerationDoc,
      ttsDoc,
      tuiDoc,
      cliDoc,
      pluginsDoc,
      dashboardPluginsDoc,
      upstreamWebSource,
      deploySupportSource,
    }),
    risks: buildRisks({
      dashboardContracts,
      upstreamGateway,
      upstreamWeb,
      forkGateway,
      upstream,
      fork,
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repoRoot);
  const outputPath = path.resolve(repoRoot, args.output);
  const report = await buildAuditReport(repoRoot);
  const markdown = renderHermesAuditMarkdown(report);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, markdown, "utf8");

  process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)}\n`);
  process.stdout.write(`Upstream ${report.upstream.ref} (${report.upstream.version ?? "unknown"})\n`);
  process.stdout.write(`Fork ${report.fork.ref} (${report.fork.version ?? "unknown"})\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
