import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "what-is-agent-zero",
  title: "What is Agent Zero? And how to run it on a computer of its own",
  metaTitle: "What is Agent Zero? How to run it on its own computer",
  metaDescription:
    "Agent Zero is an open-source autonomous agent with its own dashboard, browser and computer. What it does, what it needs, and how to run it on Hivra.",
  publishedDate: "2026-11-17",
  lastModified: "2026-11-17",
  readingTimeMin: 7,
  author: "Hivra Team",
  tagline: "Give it a goal. It plans, runs code, browses and reports back.",
  intro:
    "Agent Zero is an open-source autonomous agent that you hand a goal to instead of a question. It plans the steps, uses tools, browses the web and runs code in its own environment. Here is what that means in practice, and how to run it without exposing a dashboard to the internet.",
  shortAnswer:
    "Agent Zero is an open-source autonomous agent with its own web dashboard, browser and computer tools. You give it a goal and it plans, runs code, browses and reports back. On Hivra it runs in a container on a Hivra Cloud computer of its own, behind a sign-in, and that computer needs a paid plan.",
  sections: [
    {
      heading: "What Agent Zero is",
      paragraphs: [
        "A chatbot answers a message and stops. [Agent Zero](https://github.com/agent0ai/agent-zero) is built for broader work. You give it a goal, such as researching a topic, building and testing a small script, or analyzing a folder of files, and it works out the steps. It can write and run code, use a browser to look things up, and keep going until it has something to report.",
        "It comes with its own web dashboard. There you chat with it, watch what it is doing, and see the browser and computer it is using. The browser and computer tools ship inside its container, so they are part of the project, not something you wire up.",
        "If the idea of an agent is new, [what is an AI agent](/blog/what-is-an-ai-agent) covers the basics. The short version here: Agent Zero is at its best on self-contained, multi-step tasks where you want one agent to plan, do and check the work.",
      ],
    },
    {
      heading: "Why it needs a computer of its own",
      paragraphs: [
        "Your agent needs computer access. It doesn't need your computer. An agent that runs code and browses the web is doing real work on a real machine, and running it on your own laptop puts that work next to your files, logins and everything else.",
        "A computer of its own keeps the two apart. Agent Zero's files, downloads and tools live on a private virtual machine, and your laptop stays out of it. That is separation, not safety: an agent can still misread an instruction, follow bad content from a web page, or misuse a credential you gave it. Hivra administrators also retain infrastructure access on Hivra-managed computers. Give it tightly scoped accounts and check sensitive actions.",
        "A long goal also needs a machine that stays on. A task that takes an hour cannot rely on a laptop lid staying open.",
      ],
    },
    {
      heading: "How it runs on Hivra",
      paragraphs: [
        "Hivra runs the open-source Agent Zero stack in a container on a Hivra Cloud computer. You do not prepare a VPS, install Docker or expose a port yourself. The dashboard is reached only through Hivra's authenticated gateway, and Agent Zero's own login is set up for you when the computer is created.",
        "The minimum is 1 vCPU and 2 GB of RAM. The project's own guidance recommends 2 vCPU and 4 GB for comfortable use, which is the size of the entry plan: " + ENTRY_PLAN_PRICE + " a month for " + ENTRY_PLAN_SIZE + ". Browser use and heavy tasks can grow what it needs.",
        "Every Hivra Cloud computer needs a paid plan, and paid computers are not paused for inactivity. Agent Zero also runs on a Proxmox server if your account is eligible to connect it.",
        "For a side-by-side with another popular open-source agent, see [Agent Zero vs OpenClaw hosting](/blog/agent-zero-vs-openclaw-hosting). The setup steps are in [the Agent Zero docs](/docs/agent-zero), and [the Agent Zero page](/agents/agent-zero) shows how to launch it.",
      ],
    },
    {
      heading: "Models and what they cost",
      paragraphs: [
        "Agent Zero needs a model to think with, and model usage is a cost separate from the computer. On Hivra you have two routes. You can pay with Hivra credits, which reach models through Venice. Or you can configure your own provider in Agent Zero's Settings, and usage then bills through that provider with no Hivra markup on your own key.",
        "Set the model before you hand it a job. An agent that plans and loops makes many model calls, so a single large goal can use more than you expect. Start with something small and watch the usage. [What it costs to run an AI agent](/blog/cost-of-running-ai-agent) breaks down the numbers.",
      ],
    },
    {
      heading: "A good first task",
      paragraphs: [
        "Open the dashboard, pick a model in Settings, and give it a task you can review: summarize a topic from a few sources, write a small script and test it, or organize a folder. Watch the steps it takes, read the result, and only then think about giving it access to anything that matters.",
        "Keep credentials narrow. If a task needs a token, create one just for that task. Anything you put on the agent computer should be something you could revoke without a fuss.",
        "Closing your laptop does not close the agent's computer. A task already running in Agent Zero's process can continue, but whether it finishes still depends on the model, the tools and any errors, so check on long jobs.",
      ],
    },
    {
      heading: "Self-host it or use Hivra",
      paragraphs: [
        "Agent Zero is open source. If you are comfortable running Docker on your own VPS, you can host it yourself, control its updates and decide exactly how its network access works. The cost is that you also run and secure the server.",
        "Hivra takes on the setup, the access layer and keeping the service running. You still choose the model, decide which tools and accounts the agent can reach, and answer for the work you ask it to do. Hivra is an independent hosting service and is not affiliated with or endorsed by the Agent Zero project.",
      ],
    },
  ],
  faqs: [
    {
      q: "Is Agent Zero free?",
      a: "The Agent Zero project is open source, so you can run it yourself for the cost of a server. On Hivra, every Hivra Cloud computer needs a paid plan, and model usage is separate, whether you use Hivra credits or your own provider.",
    },
    {
      q: "Does Agent Zero include a browser?",
      a: "Yes. It comes with its own browser and computer tools inside its container, and you can watch them in its dashboard.",
    },
    {
      q: "What size computer does it need?",
      a: "At least 1 vCPU and 2 GB of RAM on Hivra. The project recommends 2 vCPU and 4 GB, and heavier browser use can need more.",
    },
    {
      q: "Can I use my own model provider?",
      a: "Yes. Configure a supported provider in Agent Zero's Settings, or pay with Hivra credits. Provider costs and limits are separate from hosting.",
    },
    {
      q: "Is Hivra affiliated with Agent Zero?",
      a: "No. Hivra is an independent hosting service and is not affiliated with or endorsed by the Agent Zero project.",
    },
  ],
  relatedArticles: [
    { slug: "agent-zero-vs-openclaw-hosting", title: "Agent Zero vs OpenClaw hosting" },
    { slug: "what-is-an-ai-agent", title: "What is an AI agent?" },
    { slug: "cost-of-running-ai-agent", title: "What it costs to run an AI agent" },
    { slug: "is-it-safe-to-leave-an-ai-agent-running-unattended", title: "Is it safe to leave an AI agent running unattended?" },
  ],
};
