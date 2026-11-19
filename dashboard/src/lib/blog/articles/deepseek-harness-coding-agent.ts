import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "deepseek-harness-coding-agent",
  title: "DeepSeek Harness: DeepSeek's coding agent on a computer of its own",
  metaTitle: "DeepSeek Harness: a coding agent on its own computer",
  metaDescription:
    "DeepSeek Harness runs DeepSeek's coding agent on its own cloud computer, in its own interface. What alpha means, which model it uses and how you pay.",
  publishedDate: "2026-11-17",
  lastModified: "2026-11-17",
  readingTimeMin: 6,
  author: "Hivra Team",
  tagline: "A coding agent that works on a computer of its own, not yours.",
  intro:
    "DeepSeek makes a coding agent that works in its own interface. DeepSeek Harness is how you run it on Hivra: a computer of its own in the cloud, a model chosen at launch, and an agent you open in the browser. It is an alpha, and this article says what that means.",
  shortAnswer:
    "DeepSeek Harness is DeepSeek's coding agent running on a Hivra Cloud computer, in its own interface behind Hivra's sign-in. It is an alpha. It runs DeepSeek V4.1 Flash, paid with Hivra credits or your own Venice API key. It runs only on Hivra Cloud, which needs a paid plan.",
  sections: [
    {
      heading: "What DeepSeek Harness is",
      paragraphs: [
        "A coding agent reads a codebase, edits files, runs commands and checks its own work. DeepSeek ships one of its own, with its own interface for talking to it and watching what it does. DeepSeek Harness is that agent, installed on a Hivra computer and opened through Hivra's authenticated gateway.",
        "Your agent needs computer access. It doesn't need your computer. The agent gets a computer of its own: a private virtual machine with its own files and terminal tools, separate from your laptop and your other work. You open the agent's interface in a browser tab, give it a task and read what it did.",
        "You are not using a Hivra-built chat that happens to call a DeepSeek model. The interface you open is the one DeepSeek's agent brings with it. Hivra provides the computer, the sign-in in front of it and the model connection.",
      ],
    },
    {
      heading: "Why it is labelled alpha",
      paragraphs: [
        "Hivra labels DeepSeek Harness alpha because the upstream version it runs is pinned at an alpha release. That is DeepSeek's own stage for the agent, and Hivra does not hide it behind a nicer label. Expect rough edges, and expect behavior to change when the pinned version moves.",
        "Treat it as something to try on work you can review, not as the agent your release depends on. Point it at a scratch repository or a branch, read the diff, and keep anything important under version control where you can undo it.",
        "Alpha also describes where it can run. DeepSeek Harness launches on Hivra Cloud only. A server you connected yourself and a computer in your own cloud cannot run it, so it does not appear as a choice there.",
      ],
    },
    {
      heading: "Which model it uses and how you pay",
      paragraphs: [
        "DeepSeek Harness runs DeepSeek V4.1 Flash. You pick how it reaches the model when you launch it, and there are two ways.",
        "**Hivra credits.** This is the default. Hivra credits reach models through Venice, so you top up credits in Hivra and the agent's usage draws from that balance. There is no provider account to create first.",
        "**Your own Venice API key.** If you already have a Venice account, paste its key at launch. Usage then bills through Venice, and Hivra adds no markup on your own key.",
        "Why choose at launch instead of inside the agent? DeepSeek's own settings refuse a key entered from a remote browser, so the model connection is set up when the computer is created. The agent opens with a model ready.",
        "Model usage is a separate cost from the computer. A coding agent that reads a lot of files and runs many steps spends more than one that answers short questions, so start with a small task and watch the balance. For the wider picture on spend, see [the cost of running an AI agent](/blog/cost-of-running-ai-agent) and [how bring-your-own-key billing works](/blog/byo-api-key-explained).",
      ],
    },
    {
      heading: "What it needs from the computer",
      paragraphs: [
        "DeepSeek Harness needs at least 2 vCPU and 3 GB of RAM. Every Hivra Cloud computer needs a paid plan, and the entry plan is " + ENTRY_PLAN_PRICE + " a month for " + ENTRY_PLAN_SIZE + ". That covers the agent's minimum with some room left, but a heavy build or a large test suite can use all of it.",
        "The computer has no browser set up for the agent. DeepSeek Harness is for working on code and files in a terminal-style environment, so do not plan on it driving websites. If a task needs a browser, pick an agent that ships one. [Agent Zero](/blog/what-is-agent-zero) brings its own.",
        "A free Hivra account is enough to look around, but launching this agent runs a Hivra Cloud computer, and that needs a paid plan. The details are on [the DeepSeek Harness docs page](/docs/deepseek-harness).",
      ],
    },
    {
      heading: "A sensible first session",
      paragraphs: [
        "Open the agent from your dashboard, wait for its interface to load, and start with a task that has a clear finish: add a test for one function, rename a module, or explain how a part of the codebase works. Small tasks show you how it plans and where it needs correcting.",
        "Give it a copy of the code, not your only copy. Clone a repository onto the computer, let it work on a branch, and review the changes before you merge anything. If you store a token for a git host on the computer, scope it to that one repository.",
        "Credentials may be stored on the agent computer, and Hivra administrators retain infrastructure access on Hivra-managed computers. Use narrowly scoped keys and keep secrets you would not hand to a contractor out of it.",
        "Because the computer is separate from yours, closing your laptop does not close the agent's environment. How a given task ends still depends on the model, the tools and any errors, so check on long jobs rather than assuming they finished.",
      ],
    },
    {
      heading: "Who it is for",
      paragraphs: [
        "DeepSeek Harness suits developers who want to try DeepSeek's coding agent without installing it, and who prefer an agent that works on a computer that is not their own. It also suits people who want a low-cost model behind a coding agent and are happy to accept alpha software to get it.",
        "If you want a mature coding agent with vendor sign-in, the other coding agents on Hivra are better fits, and [the guide to running managed agents on your own computer](/blog/run-managed-agents-on-your-own-computer) shows how the options differ. Hivra is an independent hosting service and is not affiliated with or endorsed by DeepSeek.",
      ],
    },
  ],
  faqs: [
    {
      q: "Is DeepSeek Harness stable?",
      a: "No. It is an alpha because the upstream version Hivra runs is pinned at an alpha release. Use it on work you can review and undo, and expect behavior to change between versions.",
    },
    {
      q: "Which model does DeepSeek Harness use?",
      a: "DeepSeek V4.1 Flash. You choose at launch whether it reaches the model through Hivra credits or your own Venice API key.",
    },
    {
      q: "Can I run DeepSeek Harness on my own server?",
      a: "No. It runs on Hivra Cloud only. A server you connected yourself and a computer in your own cloud cannot run it.",
    },
    {
      q: "Does it need a paid plan?",
      a: "Yes. A Hivra account is free, but every Hivra Cloud computer needs a paid plan. The agent's minimum is 2 vCPU and 3 GB of RAM.",
    },
    {
      q: "Is Hivra affiliated with DeepSeek?",
      a: "No. Hivra is an independent hosting service and is not affiliated with or endorsed by DeepSeek.",
    },
  ],
  relatedArticles: [
    { slug: "run-managed-agents-on-your-own-computer", title: "Run managed agents on your own computer" },
    { slug: "byo-api-key-explained", title: "Bring your own API key, explained" },
    { slug: "cost-of-running-ai-agent", title: "What it costs to run an AI agent" },
    { slug: "what-is-an-ai-agent", title: "What is an AI agent?" },
  ],
};
