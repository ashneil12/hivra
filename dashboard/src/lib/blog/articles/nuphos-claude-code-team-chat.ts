import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "nuphos-claude-code-team-chat",
  title: "Nuphos: Claude Code your team chats with, on a hosted computer",
  metaTitle: "Nuphos: Claude Code your team chats with from an app",
  metaDescription:
    "Nuphos lets your team chat with a Claude Code agent from its app. Learn how the hosted runtime connects and which accounts you need.",
  publishedDate: "2026-11-17",
  lastModified: "2026-11-27",
  readingTimeMin: 6,
  author: "Hivra Team",
  tagline: "A Claude Code agent on a computer of its own, reached from a chat app.",
  intro:
    "Nuphos lets a team chat with Claude Code without sharing one person's terminal. If Nuphos appears in your Hivra Launch list, you can run its runtime on a separate cloud computer and connect it to the Nuphos app.",
  shortAnswer:
    "Nuphos lets your team chat with Claude Code from the Nuphos app. If it is listed in your Hivra Launch screen, a paid Hivra Cloud plan covers the computer that runs the Nuphos runtime. You bring your own Nuphos account and Claude sign-in; model access is separate.",
  sections: [
    {
      heading: "What Nuphos is",
      paragraphs: [
        "Claude Code is a coding agent that lives in a terminal. That works well for one developer at one keyboard, and less well for a team that wants to ask the same agent questions, hand it tasks and see what it did. Nuphos puts a chat app in front of it. The agent runs on a computer, and your team talks to it from the Nuphos app on Mac, iPhone or Android.",
        "The part that runs on a computer is Nuphos's runtime. Hivra hosts its official runtime image, the Claude Code variant, which Nuphos publishes as open source. The runtime has its own console, and Nuphos's servers reach it so the app can talk to the agent.",
        "Your agent needs computer access. It doesn't need your computer. A runtime that stays on a computer of its own means the team can reach the agent without anyone's laptop being open.",
      ],
    },
    {
      heading: "Where Nuphos runs",
      paragraphs: [
        "Nuphos is not available on every Hivra account. Check your Launch list before planning around it. Where it is offered, it runs only on a paid Hivra Cloud plan, with at least 1 vCPU and 3 GB of RAM.",
      ],
    },
    {
      heading: "Whose accounts it uses",
      paragraphs: [
        "This is the part to read carefully. Hivra provides the computer, not the model. There are no Hivra credits and no model picker for Nuphos. The agent inside it signs in to your own Claude account, and the Nuphos app signs in with your own Nuphos account.",
        "That has two consequences. First, Claude usage is governed by your Claude subscription and its limits, the same as using Claude Code anywhere else. Hivra does not mark up or resell it. Second, Nuphos itself is a separate product with its own account and terms, so what it costs and what it allows is between you and Nuphos.",
        "For the cost of the Claude side, [Claude Max vs Pro for Claude Code](/blog/claude-max-vs-pro-for-claude-code) walks through how plan limits affect a coding agent that runs all day.",
      ],
    },
    {
      heading: "How you set it up",
      paragraphs: [
        "When Nuphos is available to you, the steps are short. Launch it on a Hivra Cloud computer. Open its console, which Hivra serves behind the Hivra sign-in. Set a password for the console. Press Connect to Nuphos, then open the Nuphos app and chat with the agent using your own Nuphos account and Claude sign-in.",
        "Nuphos's servers reach the runtime at its /acp address, which the runtime guards with each connected team's key. That is how the app and the agent find each other without you opening the computer to the internet yourself.",
        "You update it with the Update button, which pulls Nuphos's latest release. Hivra runs the runtime image unmodified.",
      ],
    },
    {
      heading: "What to think about before a team uses it",
      paragraphs: [
        "A coding agent that a team can message is powerful, and it is worth deciding some rules first. Who is allowed to connect? What repositories does the agent have access to? Credentials may be stored on the agent computer, and Hivra administrators retain infrastructure access on Hivra-managed computers, so give the agent tokens that are scoped to what it needs and nothing more.",
        "Remember that the agent's work happens on a computer that is separate from yours. That keeps its files and tools off your laptop, but it does not make its actions safe. Review the changes it makes before they reach anything that matters, the same way you would review a teammate's pull request. If you want more on that, read [whether it is safe to leave an AI agent running unattended](/blog/is-it-safe-to-leave-an-ai-agent-running-unattended).",
        "Because Hivra runs Claude Code here, the usual line applies: Hivra is an independent hosting service and is not affiliated with Anthropic or Nuphos, and does not endorse them or speak for them.",
      ],
    },
    {
      heading: "Who it is for",
      paragraphs: [
        "Nuphos suits small teams of developers who already pay for Claude, want to share one agent through a chat app, and would rather not keep a laptop running for it. If you work alone, the Claude Code agent with its own interface is simpler, and [how to keep Claude Code running around the clock](/blog/keep-claude-code-running-24-7) covers that setup.",
      ],
    },
  ],
  faqs: [
    {
      q: "How do I know whether I can launch Nuphos on Hivra?",
      a: "Check your Hivra Launch list. If Nuphos is listed, you can run it on a paid Hivra Cloud plan, not on a connected server.",
    },
    {
      q: "Does Hivra provide the model for Nuphos?",
      a: "No. Hivra provides the computer, not the model. You use your own Nuphos account and your own Claude sign-in, and there are no Hivra credits for it.",
    },
    {
      q: "Which apps can my team chat from?",
      a: "The Nuphos app on Mac, iPhone and Android, signed in with your own Nuphos account.",
    },
    {
      q: "Does it need a paid plan?",
      a: "Yes. Nuphos requires a paid Hivra Cloud plan and at least 1 vCPU and 3 GB of RAM.",
    },
    {
      q: "Is Hivra affiliated with Nuphos or Anthropic?",
      a: "No. Hivra is an independent hosting service and is not affiliated with or endorsed by Nuphos or Anthropic.",
    },
  ],
  relatedArticles: [
    { slug: "keep-claude-code-running-24-7", title: "Keep Claude Code running 24/7" },
    { slug: "claude-max-vs-pro-for-claude-code", title: "Claude Max vs Pro for Claude Code" },
    { slug: "is-it-safe-to-leave-an-ai-agent-running-unattended", title: "Is it safe to leave an AI agent running unattended?" },
    { slug: "multi-agent-systems-explained", title: "Multi-agent AI systems in 2026" },
  ],
};
