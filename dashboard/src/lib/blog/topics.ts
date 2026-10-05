// Topic hubs for the blog index. Every article belongs to exactly one topic (a test enforces it), listed in the order a
// newcomer should read it. The index renders one section per topic, and each section has an anchor (#topic-<slug>) that
// article pages link back to, so posts on one subject point at each other through a real hub.

export type BlogTopic = {
  slug: string;
  title: string;
  /** One or two plain sentences: who this topic is for and what they will learn. */
  blurb: string;
  /** Article slugs, in reading order. */
  articles: readonly string[];
};

export const BLOG_TOPICS: readonly BlogTopic[] = [
  {
    slug: "keep-agents-running",
    title: "Keep an agent running",
    blurb: "Closing the laptop on a coding agent: what happens to it, which fixes work, and how to leave one running safely.",
    articles: [
      "keep-claude-code-running-24-7",
      "claude-code-remote-control",
      "run-codex-24-7-in-the-cloud",
      "claude-code-vs-codex-24-7",
      "ai-agent-dies-terminal-closes-fixes",
      "run-ai-agents-24-7",
      "control-claude-code-from-telegram",
      "is-it-safe-to-leave-an-ai-agent-running-unattended",
      "claude-code-dangerously-skip-permissions",
      "codex-resume-session",
    ],
  },
  {
    slug: "hosting-and-costs",
    title: "Where to host agents, and what it costs",
    blurb: "Your own server, a VPS or a managed computer. How to pick between them, what each needs, and what an agent costs to run.",
    articles: [
      "ai-agent-hosting-guide",
      "managed-vs-self-hosted-ai-agents",
      "ai-agent-vps",
      "best-vps-for-hermes-agent",
      "do-you-need-a-gpu-to-run-an-ai-agent",
      "cost-of-running-ai-agent",
      "claude-max-vs-pro-for-claude-code",
      "codex-pricing-by-chatgpt-plan",
      "ai-agent-api-cost-optimization",
      "byo-api-key-explained",
    ],
  },
  {
    slug: "hermes-agent",
    title: "Hermes Agent",
    blurb: "What Hermes Agent is, how to run it yourself, and how to use its memory, skills, schedules and chat apps.",
    articles: [
      "what-is-hermes-agent",
      "how-to-self-host-hermes-agent",
      "self-hosting-hermes-guide",
      "what-can-hermes-agent-actually-do",
      "hermes-agent-skills-guide",
      "hermes-agent-memory-system-explained",
      "hermes-agent-cron-scheduled-tasks",
      "hermes-agent-telegram-discord-setup",
      "how-to-set-up-hermes-agent-telegram",
      "hermes-agent-vs-chatgpt",
    ],
  },
  {
    slug: "openclaw-and-agent-zero",
    title: "OpenClaw and Agent Zero",
    blurb: "How to run OpenClaw and Agent Zero, what to do when one breaks, and how they compare with Hermes.",
    articles: [
      "how-to-self-host-openclaw",
      "openclaw-broken-after-update",
      "agent-zero-vs-openclaw-hosting",
      "hermes-vs-openclaw",
    ],
  },
  {
    slug: "how-agents-work",
    title: "How AI agents work",
    blurb: "Start here if agents are new to you. What an agent is, how it remembers, what it can automate, and where several agents fit.",
    articles: [
      "what-is-an-ai-agent",
      "how-ai-agents-work",
      "ai-agent-vs-chatbot",
      "persistent-memory-explained",
      "ai-agent-memory-systems",
      "multi-agent-systems-explained",
      "ai-agent-automation-examples",
      "ai-agent-browser-automation-tools",
    ],
  },
];

/** The topic an article belongs to. */
export function topicForArticle(slug: string): BlogTopic | undefined {
  return BLOG_TOPICS.find((topic) => topic.articles.includes(slug));
}

export function topicAnchor(topic: BlogTopic): string {
  return `topic-${topic.slug}`;
}
