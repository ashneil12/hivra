import { BlogArticle } from "../types";

export const article: BlogArticle = {
  slug: "openbot-ai-coworkers",
  title: "OpenBot: CopilotKit's AI coworkers, hosted on a computer of their own",
  metaTitle: "OpenBot by CopilotKit: AI coworkers on a hosted computer",
  metaDescription:
    "Meet CopilotKit's OpenBot AI coworkers. Learn what their browser and files are for, what key you need, and how to start with one small task.",
  publishedDate: "2026-11-17",
  lastModified: "2026-11-27",
  readingTimeMin: 6,
  author: "Hivra Team",
  tagline: "Coworkers with their own browser and files, in a workspace you open.",
  intro:
    "OpenBot is CopilotKit's open-source workspace for AI coworkers, agents with their own browser and files. If OpenBot appears in your Hivra Launch list, you can run the workspace on its own cloud computer.",
  shortAnswer:
    "OpenBot is CopilotKit's workspace for AI coworkers with their own browser and files. If it is listed in your Hivra Launch screen, it runs on a paid Hivra Cloud computer. Bring a CopilotKit Intelligence key to open the workspace. Model usage draws from Hivra credits by default.",
  sections: [
    {
      heading: "What OpenBot is",
      paragraphs: [
        "Most AI tools are one assistant in one chat window. OpenBot is built around coworkers: several agents you can hand work to, each with a browser and a set of files of its own. You manage them from OpenBot's own workspace instead of from a terminal.",
        "It comes from CopilotKit, the team behind the CopilotKit toolkit for building agent-powered applications. OpenBot is open source. There are other projects that use the name OpenBot, and this article is only about the CopilotKit one.",
        "The point of a hosted setup is the same as for any agent. Your agent needs computer access. It doesn't need your computer. Coworkers that browse the web and keep files are better off on a computer that is theirs, so their downloads, logins and half-finished work stay out of your own machine.",
      ],
    },
    {
      heading: "Where OpenBot runs",
      paragraphs: [
        "OpenBot is not available on every Hivra account. Check your Launch list before planning around it. Where it is offered, it runs on a paid Hivra Cloud plan and cannot run on a connected server.",
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
        "OpenBot suits people who want to delegate to several agents in one workspace. Try one coworker on a small task first so you know what a useful result looks like.",
        "If you want one general agent that takes a goal and works through it, [Agent Zero](/blog/what-is-agent-zero) is available now. Hivra is an independent hosting service and is not affiliated with or endorsed by CopilotKit.",
      ],
    },
  ],
  faqs: [
    {
      q: "How do I know whether I can launch OpenBot on Hivra?",
      a: "Check your Hivra Launch list. If OpenBot is listed, you can run it on a paid Hivra Cloud plan, not on a connected server.",
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
