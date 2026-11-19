import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "openbot-ai-coworkers",
  title: "OpenBot: CopilotKit's AI coworkers, hosted on a computer of their own",
  metaTitle: "OpenBot by CopilotKit: AI coworkers on a hosted computer",
  metaDescription:
    "OpenBot is CopilotKit's open-source AI coworkers, each with its own browser and files. What it needs, why it is in preview on Hivra, and how it is set up.",
  publishedDate: "2026-11-17",
  lastModified: "2026-11-17",
  readingTimeMin: 6,
  author: "Hivra Team",
  tagline: "Coworkers with their own browser and files, in a workspace you open.",
  intro:
    "OpenBot is CopilotKit's open-source take on AI coworkers: agents with their own browser and files that you work alongside in a shared workspace. Hivra can host it on a computer of its own, but it is a preview there, and it is not in the Launch list yet.",
  shortAnswer:
    "OpenBot is CopilotKit's open-source set of AI coworkers, each with its own browser and files, in OpenBot's own workspace. On Hivra it is in preview and not in the Launch list yet. It runs on a Hivra Cloud computer, needs a CopilotKit Intelligence key, and uses Hivra credits for models by default.",
  sections: [
    {
      heading: "What OpenBot is",
      paragraphs: [
        "Most AI tools are one assistant in one chat window. OpenBot is built around coworkers: several agents you can hand work to, each with a browser and a set of files of its own. You manage them from OpenBot's own workspace instead of from a terminal.",
        "It comes from CopilotKit, the team behind the CopilotKit toolkit for building agent-powered applications. OpenBot is released under the MIT license. There are other projects that use the name OpenBot, and this article is only about the CopilotKit one.",
        "The point of a hosted setup is the same as for any agent. Your agent needs computer access. It doesn't need your computer. Coworkers that browse the web and keep files are better off on a computer that is theirs, so their downloads, logins and half-finished work stay out of your own machine.",
      ],
    },
    {
      heading: "Preview, and not in the Launch list yet",
      paragraphs: [
        "OpenBot on Hivra is a preview, and it is not in the Launch list yet. That means you cannot pick it from the Launch screen today. Hivra keeps it off by default while it is checked, and it appears in the list only on a deployment where the switch for it is turned on.",
        "Say that plainly to yourself before planning around it. If you need an agent you can launch today, the ones in the Launch list are the ones to use, and the [agents page](/agents) shows what they are. This page describes what OpenBot on Hivra is designed to do, so you know what to expect when it arrives.",
        "When it is on, it runs only on Hivra Cloud, on a paid plan. A free Hivra account works with a server you connect yourself, but OpenBot is not offered there.",
      ],
    },
    {
      heading: "What you need before you open it",
      paragraphs: [
        "OpenBot will not start without a CopilotKit Intelligence key. CopilotKit has a free plan, so getting a key does not require paying CopilotKit up front, and the plan's limits are CopilotKit's to set. Check them on CopilotKit's own pages.",
        "The first time you open OpenBot on Hivra, you see a one-step page asking for that key. You paste it once. Hivra keeps the key on the computer only, in the place OpenBot reads it from, and the workspace starts once it is there.",
        "The computer needs at least 1 vCPU and 3 GB of RAM. OpenBot brings its own browser, so the computer does not run a separate one for it.",
      ],
    },
    {
      heading: "How models and billing work",
      paragraphs: [
        "Models run through Venice on Hivra credits by default. You top up credits in Hivra and OpenBot's usage draws from that balance, so there is no model provider account to set up first. If you would rather use a different provider, you change it in OpenBot's settings.",
        "Three separate things can cost money, and it helps to keep them apart. The Hivra Cloud computer is a paid plan. Model usage is credits, or your own provider's bill if you switch. The CopilotKit key is governed by CopilotKit's plan. Coworkers that browse and work in loops use more model time than a single chat, so start with one small job.",
        "For the general cost picture across agents, read [what it costs to run an AI agent](/blog/cost-of-running-ai-agent). Setup and status for this agent are on [the OpenBot docs page](/docs/openbot).",
      ],
    },
    {
      heading: "Updating and trying it safely",
      paragraphs: [
        "OpenBot on Hivra is CopilotKit's official OpenBot image, unmodified. Hivra pulls the latest release and runs it on the computer, then shows OpenBot's own workspace behind the Hivra sign-in. You use the real workspace, not a Hivra imitation of it.",
        "You update it with the Update button. It pulls the latest image from upstream, and if the new one does not start, Hivra puts the previous image and its database back, so a bad release does not leave you with a broken workspace. That is a protection for the update step, not a promise about your data in general: Hivra does not guarantee backups, so keep copies of anything you cannot recreate.",
        "Start with coworkers on low-stakes work, such as researching a topic or tidying a set of notes. Do not log them into accounts you cannot afford to have mistaken actions in. Credentials may be stored on the agent computer, and Hivra administrators retain infrastructure access on Hivra-managed computers.",
      ],
    },
    {
      heading: "Who it is for",
      paragraphs: [
        "OpenBot suits developers and AI power users who like the idea of delegating to several agents at once and want a workspace for it. It is a young project, and the preview label on Hivra reflects that.",
        "If you want one general agent that takes a goal and works through it, [Agent Zero](/blog/what-is-agent-zero) is available now. Hivra is an independent hosting service and is not affiliated with or endorsed by CopilotKit.",
      ],
    },
  ],
  faqs: [
    {
      q: "Can I launch OpenBot on Hivra today?",
      a: "Not from the Launch list. OpenBot is in preview on Hivra and is not in the Launch list yet. It appears only on a deployment where Hivra has turned it on.",
    },
    {
      q: "What do I need to run OpenBot?",
      a: "A CopilotKit Intelligence key, which you paste once on the first open. CopilotKit has a free plan. You also need a Hivra Cloud computer, which needs a paid plan, with at least 1 vCPU and 3 GB of RAM.",
    },
    {
      q: "Which models does OpenBot use on Hivra?",
      a: "Models run through Venice on Hivra credits by default. You can change the provider in OpenBot's settings.",
    },
    {
      q: "How do I update OpenBot?",
      a: "Use the Update button. It pulls the latest upstream image, and puts the previous image and database back if the new one does not start.",
    },
    {
      q: "Is Hivra affiliated with CopilotKit?",
      a: "No. Hivra is an independent hosting service and is not affiliated with or endorsed by CopilotKit.",
    },
  ],
  relatedArticles: [
    { slug: "multi-agent-systems-explained", title: "Multi-agent AI systems in 2026" },
    { slug: "run-managed-agents-on-your-own-computer", title: "Run managed agents on your own computer" },
    { slug: "cost-of-running-ai-agent", title: "What it costs to run an AI agent" },
    { slug: "what-is-an-ai-agent", title: "What is an AI agent?" },
  ],
};
