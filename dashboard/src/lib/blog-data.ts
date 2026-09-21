import { BlogArticle, BlogSection } from "./blog/types";
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
};

export const BLOG_ARTICLES_LIST: BlogArticle[] = Object.values(BLOG_ARTICLES).sort(
  (a, b) => new Date(b.publishedDate).getTime() - new Date(a.publishedDate).getTime()
);

export type { BlogArticle, BlogSection };
