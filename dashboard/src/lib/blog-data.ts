import { BlogArticle, BlogSection } from "./blog/types";
import { getCatalogAppManifest, isCatalogAppLaunchable } from "./hivra/catalog-manifests";
import { isNuphosAgentEnabled } from "./hivra/nuphos-flag";
import { isOpenBotAgentEnabled } from "./hivra/openbot-flag";
import { article as whatIsHermesAgent } from "./blog/articles/what-is-hermes-agent";
import { article as costOfRunningAiAgent } from "./blog/articles/cost-of-running-ai-agent";
import { article as aiAgentAutomationExamples } from "./blog/articles/ai-agent-automation-examples";
import { article as selfHostingHermesGuide } from "./blog/articles/self-hosting-hermes-guide";
import { article as aiAgentVsChatbot } from "./blog/articles/ai-agent-vs-chatbot";
import { article as persistentMemoryExplained } from "./blog/articles/persistent-memory-explained";
import { article as hermesVsOpenclaw } from "./blog/articles/hermes-vs-openclaw";
import { article as howAiAgentsWork } from "./blog/articles/how-ai-agents-work";
import { article as byoApiKeyExplained } from "./blog/articles/byo-api-key-explained";
import { article as aiAgentMemorySystems } from "./blog/articles/ai-agent-memory-systems";
import { article as aiAgentApiCostOptimization } from "./blog/articles/ai-agent-api-cost-optimization";
import { article as multiAgentSystemsExplained } from "./blog/articles/multi-agent-systems-explained";
import { article as aiAgentBrowserAutomationTools } from "./blog/articles/ai-agent-browser-automation-tools";
import { article as whatIsAnAiAgent } from "./blog/articles/what-is-an-ai-agent";
import { article as howToSelfHostHermes } from "./blog/articles/how-to-self-host-hermes-agent";
import { article as howToSelfHostOpenclaw } from "./blog/articles/how-to-self-host-openclaw";
import { article as hermesAgentMemorySystem } from "./blog/articles/hermes-agent-memory-system-explained";
import { article as hermesAgentTelegramDiscord } from "./blog/articles/hermes-agent-telegram-discord-setup";
import { article as bestVpsForHermesAgent } from "./blog/articles/best-vps-for-hermes-agent";
import { article as hermesAgentSkillsGuide } from "./blog/articles/hermes-agent-skills-guide";
import { article as whatCanHermesAgentDo } from "./blog/articles/what-can-hermes-agent-actually-do";
import { article as hermesAgentVsChatgpt } from "./blog/articles/hermes-agent-vs-chatgpt";
import { article as hermesAgentCronTasks } from "./blog/articles/hermes-agent-cron-scheduled-tasks";
import { article as howToSetUpTelegram } from "./blog/articles/how-to-set-up-hermes-agent-telegram";
import { article as keepClaudeCodeRunning } from "./blog/articles/keep-claude-code-running-24-7";
import { article as runCodex247InTheCloud } from "./blog/articles/run-codex-24-7-in-the-cloud";
import { article as aiAgentHostingGuide } from "./blog/articles/ai-agent-hosting-guide";
import { article as aiAgentDiesTerminalClosesFixes } from "./blog/articles/ai-agent-dies-terminal-closes-fixes";
import { article as runAiAgents247 } from "./blog/articles/run-ai-agents-24-7";
import { article as claudeCodeVsCodex247 } from "./blog/articles/claude-code-vs-codex-24-7";
import { article as aiAgentVps } from "./blog/articles/ai-agent-vps";
import { article as managedVsSelfHostedAiAgents } from "./blog/articles/managed-vs-self-hosted-ai-agents";
import { article as agentZeroVsOpenclawHosting } from "./blog/articles/agent-zero-vs-openclaw-hosting";
import { article as deepseekHarnessCodingAgent } from "./blog/articles/deepseek-harness-coding-agent";
import { article as openbotAiCoworkers } from "./blog/articles/openbot-ai-coworkers";
import { article as nuphosClaudeCodeTeamChat } from "./blog/articles/nuphos-claude-code-team-chat";
import { article as whatIsAeonAgent } from "./blog/articles/what-is-aeon-agent";
import { article as whatIsAgentZero } from "./blog/articles/what-is-agent-zero";
import { article as whatIsZeroClaw } from "./blog/articles/what-is-zeroclaw";
import { article as ubuntuDesktopInTheCloud } from "./blog/articles/ubuntu-desktop-in-the-cloud";
import { article as openclawBrokenAfterUpdate } from "./blog/articles/openclaw-broken-after-update";
import { article as unattendedAgentSafety } from "./blog/articles/is-it-safe-to-leave-an-ai-agent-running-unattended";
import { article as aiAgentGpuRequirements } from "./blog/articles/do-you-need-a-gpu-to-run-an-ai-agent";
import { article as controlClaudeCodeFromTelegram } from "./blog/articles/control-claude-code-from-telegram";
import { article as claudeCodeRemoteControl } from "./blog/articles/claude-code-remote-control";
import { article as claudeMaxVsProForClaudeCode } from "./blog/articles/claude-max-vs-pro-for-claude-code";
import { article as claudeCodeDangerouslySkipPermissions } from "./blog/articles/claude-code-dangerously-skip-permissions";
import { article as codexPricingByChatgptPlan } from "./blog/articles/codex-pricing-by-chatgpt-plan";
import { article as codexResumeSession } from "./blog/articles/codex-resume-session";
import { article as cursorCloudAgents } from "./blog/articles/cursor-cloud-agents";
import { article as cursorVsClaudeCode } from "./blog/articles/cursor-vs-claude-code";
import { article as isOpenclawFree } from "./blog/articles/is-openclaw-free-what-it-costs-to-run";
import { article as runManagedAgentsOnYourOwnComputer } from "./blog/articles/run-managed-agents-on-your-own-computer";
import { article as hermesAgentCloud } from "./blog/articles/hermes-agent-cloud";
import { article as openrouterFreeModels } from "./blog/articles/openrouter-free-models";
import { article as bestLlmForCoding } from "./blog/articles/best-llm-for-coding";
import { codexMobile } from "./blog/articles/codex-mobile";
import { claudeCodeOnYourPhone } from "./blog/articles/claude-code-on-your-phone";
import { howToSelfHostAgentZero } from "./blog/articles/how-to-self-host-agent-zero";
import { howToInstallCodexCli } from "./blog/articles/how-to-install-codex-cli";
import { claudeCodeOnWindows } from "./blog/articles/claude-code-on-windows";
import { claudeCodeOnLinux } from "./blog/articles/claude-code-on-linux";
import { claudeCodeMcp } from "./blog/articles/claude-code-mcp";
import { codexMcp } from "./blog/articles/codex-mcp";

// SCRIPTURE_ANCHOR: blog-store | Psalm 78:4 | Verse: We will tell the generation to come the praises of Yahweh, his strength, and his wondrous works.
export const BLOG_ARTICLES: Record<string, BlogArticle> = {
  "what-is-hermes-agent": whatIsHermesAgent,
  "cost-of-running-ai-agent": costOfRunningAiAgent,
  "ai-agent-automation-examples": aiAgentAutomationExamples,
  "self-hosting-hermes-guide": selfHostingHermesGuide,
  "ai-agent-vs-chatbot": aiAgentVsChatbot,
  "persistent-memory-explained": persistentMemoryExplained,
  "hermes-vs-openclaw": hermesVsOpenclaw,
  "how-ai-agents-work": howAiAgentsWork,
  "byo-api-key-explained": byoApiKeyExplained,
  "ai-agent-memory-systems": aiAgentMemorySystems,
  "ai-agent-api-cost-optimization": aiAgentApiCostOptimization,
  "multi-agent-systems-explained": multiAgentSystemsExplained,
  "ai-agent-browser-automation-tools": aiAgentBrowserAutomationTools,
  "what-is-an-ai-agent": whatIsAnAiAgent,
  "how-to-self-host-hermes-agent": howToSelfHostHermes,
  "how-to-self-host-openclaw": howToSelfHostOpenclaw,
  "hermes-agent-memory-system-explained": hermesAgentMemorySystem,
  "hermes-agent-telegram-discord-setup": hermesAgentTelegramDiscord,
  "best-vps-for-hermes-agent": bestVpsForHermesAgent,
  "hermes-agent-skills-guide": hermesAgentSkillsGuide,
  "what-can-hermes-agent-actually-do": whatCanHermesAgentDo,
  "hermes-agent-vs-chatgpt": hermesAgentVsChatgpt,
  "hermes-agent-cron-scheduled-tasks": hermesAgentCronTasks,
  "how-to-set-up-hermes-agent-telegram": howToSetUpTelegram,
  "keep-claude-code-running-24-7": keepClaudeCodeRunning,
  "run-codex-24-7-in-the-cloud": runCodex247InTheCloud,
  "ai-agent-hosting-guide": aiAgentHostingGuide,
  "ai-agent-dies-terminal-closes-fixes": aiAgentDiesTerminalClosesFixes,
  "run-ai-agents-24-7": runAiAgents247,
  "claude-code-vs-codex-24-7": claudeCodeVsCodex247,
  "ai-agent-vps": aiAgentVps,
  "managed-vs-self-hosted-ai-agents": managedVsSelfHostedAiAgents,
  "agent-zero-vs-openclaw-hosting": agentZeroVsOpenclawHosting,
  "openclaw-broken-after-update": openclawBrokenAfterUpdate,
  "is-it-safe-to-leave-an-ai-agent-running-unattended": unattendedAgentSafety,
  "do-you-need-a-gpu-to-run-an-ai-agent": aiAgentGpuRequirements,
  "control-claude-code-from-telegram": controlClaudeCodeFromTelegram,
  "claude-code-remote-control": claudeCodeRemoteControl,
  "claude-max-vs-pro-for-claude-code": claudeMaxVsProForClaudeCode,
  "claude-code-dangerously-skip-permissions": claudeCodeDangerouslySkipPermissions,
  "codex-pricing-by-chatgpt-plan": codexPricingByChatgptPlan,
  "codex-resume-session": codexResumeSession,
  "cursor-cloud-agents": cursorCloudAgents,
  "cursor-vs-claude-code": cursorVsClaudeCode,
  "is-openclaw-free-what-it-costs-to-run": isOpenclawFree,
  "run-managed-agents-on-your-own-computer": runManagedAgentsOnYourOwnComputer,
  "deepseek-harness-coding-agent": deepseekHarnessCodingAgent,
  "openbot-ai-coworkers": openbotAiCoworkers,
  "nuphos-claude-code-team-chat": nuphosClaudeCodeTeamChat,
  "what-is-aeon-agent": whatIsAeonAgent,
  "what-is-agent-zero": whatIsAgentZero,
  "what-is-zeroclaw": whatIsZeroClaw,
  "ubuntu-desktop-in-the-cloud": ubuntuDesktopInTheCloud,
  "hermes-agent-cloud": hermesAgentCloud,
  "openrouter-free-models": openrouterFreeModels,
  "best-llm-for-coding": bestLlmForCoding,
  "codex-mobile": codexMobile,
  "claude-code-on-your-phone": claudeCodeOnYourPhone,
  "how-to-self-host-agent-zero": howToSelfHostAgentZero,
  "how-to-install-codex-cli": howToInstallCodexCli,
  "claude-code-on-windows": claudeCodeOnWindows,
  "claude-code-on-linux": claudeCodeOnLinux,
  "claude-code-mcp": claudeCodeMcp,
  "codex-mcp": codexMcp,
};

export const BLOG_ARTICLES_LIST: BlogArticle[] = Object.values(BLOG_ARTICLES).sort(
  (a, b) => new Date(b.publishedDate).getTime() - new Date(a.publishedDate).getTime()
);

export function getPublicBlogArticle(slug: string): BlogArticle | undefined {
  if (!Object.hasOwn(BLOG_ARTICLES, slug)) return undefined;
  if (slug === openbotAiCoworkers.slug && !isOpenBotAgentEnabled()) return undefined;
  if (slug === nuphosClaudeCodeTeamChat.slug && !isNuphosAgentEnabled()) return undefined;
  if (slug === whatIsZeroClaw.slug) {
    const manifest = getCatalogAppManifest("zeroclaw");
    if (!manifest || !isCatalogAppLaunchable(manifest)) return undefined;
  }
  return BLOG_ARTICLES[slug];
}

export function getPublicBlogArticles(): BlogArticle[] {
  return BLOG_ARTICLES_LIST.filter(({ slug }) => getPublicBlogArticle(slug));
}

export type { BlogArticle, BlogSection };
