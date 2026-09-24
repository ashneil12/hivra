import { BlogArticle } from "../types";

// SCRIPTURE_ANCHOR: blog-teach | Deuteronomy 6:7 | Verse: You shall teach them diligently to your children, and shall talk of them when you sit in your house.
export const article: BlogArticle = {
  slug: "what-is-hermes-agent",
  title: "What is Hermes Agent? A plain-English explanation",
  metaDescription:
    "Hermes Agent is an open-source autonomous AI agent from Nous Research. Here's what it actually does, how it differs from ChatGPT, and what makes it worth running on a server.",
  publishedDate: "2026-03-10",
  lastModified: "2026-09-24",
  readingTimeMin: 8,
  author: "Hivra team",
  tagline: "Not a chatbot. Not a wrapper. Something different.",
  intro:
    "Hermes Agent is an open-source autonomous AI agent released by Nous Research in early 2026. It is not a chatbot, and the difference between the two categories matters more than it sounds.",
  sections: [
    {
      heading: "Start with what it is not",
      paragraphs: [
        "Most AI products you have used — ChatGPT, Claude.ai, Gemini — are chatbots. You write a message, they generate a response, the session ends. The next time you open the app, the model has no memory of what you discussed. It does not take actions on your behalf. It does not run while you are asleep.",
        "Hermes Agent operates differently. It runs continuously on a server. It maintains memory across sessions — not just a short context window but a real, searchable store of what it knows about you, your projects, and the work it has done. And it can take actions: run code, browse websites, manage files, call APIs, send emails, and execute multi-step tasks without you narrating each step.",
      ],
    },
    {
      heading: "Where it comes from",
      paragraphs: [
        "Nous Research is an AI research group that has been building and releasing open-weight models since 2023, known particularly for the Hermes model series — fine-tuned versions of base models (Llama, Mistral, and others) optimized for function calling, tool use, and instruction following. These models consistently score well on agentic benchmarks.",
        "Hermes Agent is the framework built on top of that work — designed for long-running tasks, real tool execution, and persistent memory. Released under the MIT license in February 2026, meaning you can run it yourself, modify it, or build on top of it. The MIT license creates two classes of users: those who run Hermes on their own hardware, and those who want the capabilities without the infrastructure overhead. That second group is what Hivra exists to serve.",
      ],
    },
    {
      heading: "What Hermes Agent can do",
      paragraphs: [
        "The core capabilities in v0.5.0: web browsing via a real headless browser (Browserbase, Browser Use cloud, local Chrome via CDP, or local Chromium — you pick the backend), sandboxed terminal execution across five environments (local, Docker, SSH, Singularity, Modal), file system read/write, external API calls, voice mode, multimodal vision, image generation, and text-to-speech. Gateway connects to Telegram, Discord, Slack, WhatsApp, Signal, and email through a single process that installs as a systemd service.",
        "Example: tell Hermes to monitor a competitor's pricing page every Monday, compare it to a stored baseline, and send you a Telegram message if anything changed. You set that up once. The agent runs it every week without you touching it again. v0.5.0 also introduces checkpoint and rollback — before making any file changes, the agent snapshots the working directory, so you can run `/rollback` if something goes wrong.",
        "The 40+ built-in tools cover most of what a developer or technical operator needs. Custom skills from agentskills.io — searchable markdown files encoding how to approach specific task types — install via a single command and are available community-wide.",
      ],
    },
    {
      heading: "Persistent memory: how it actually works",
      paragraphs: [
        "Hermes uses a layered memory architecture. Short-term context works like any language model — a window of recent conversation and task history the model can see during a session. The longer-term memory is different. Skill Documents are structured summaries of how to approach a class of task, built from the agent's experience doing that task. When Hermes successfully writes a web scraper for a particular kind of site, it synthesizes what it learned into a Skill Document it references on the next similar task. Over time, the agent gets faster and requires less handholding on familiar problem types.",
        "The user model is a separate layer: a structured representation of who you are, your technical background, your preferred communication style, and context about your projects. This is what lets the agent respond appropriately without you re-explaining yourself every session. None of this persists if the agent has nowhere to store it — running locally ties memory to your machine. Running on a managed server means the memory persists independently of your local environment.",
      ],
    },
    {
      heading: "The infrastructure problem",
      paragraphs: [
        "Hermes is designed to run on a server — a VPS, a dedicated machine, a Docker container, or a cloud VM. The installation requires Linux familiarity, Docker, and some comfort configuring networking. On Hetzner's CX23 at €5.49/month (excluding VAT), it is technically cheap. But it takes 4-8 hours to set up correctly the first time and requires maintenance when updates break things. This is not a criticism — Hermes is an open-source tool built for developers, and the infrastructure complexity is appropriate for what it is.",
        "Hivra fills that gap by handling server provisioning, the container setup, networking, and SSL termination, and it restarts the agent if it crashes; backups are not guaranteed. Launch Hermes from the dashboard, add your AI provider key, and use it from chat and an admin dashboard in the browser, with nothing to install.",
      ],
    },
    {
      heading: "Model agnosticism is worth noting",
      paragraphs: [
        "Despite the name, the framework is not tied to Nous Research's models. It supports 400+ models through providers including OpenRouter (300+ models from 60+ providers), Anthropic (Claude Haiku 4.5, Sonnet 4.6, Opus 4.6), OpenAI (GPT-5, GPT-5.4, GPT-5 mini), and Ollama for local models. The Hermes model family is trained specifically for tool-calling accuracy and is a strong default — but Claude Sonnet 4.6 and GPT-5.4 are both in regular community use. You bring your API key, point the agent at your preferred model, and the framework handles the rest.",
      ],
    },
    {
      heading: "Who should use it",
      paragraphs: [
        "Technical founders, developers, and researchers who have repetitive work they want to offload — monitoring tasks, research tasks, coding tasks following consistent patterns. The key requirement: comfort defining tasks precisely enough for an agent to execute autonomously.",
        "Not the right tool for someone who wants a polished no-code product. Setup requires technical comfort and reliable automation requires writing good initial instructions. The ceiling is high: once configured well, Hermes genuinely produces useful work without ongoing supervision. If you have thought about hiring a virtual assistant for operational work and resisted because of coordination overhead, Hermes is worth looking at seriously.",
      ],
    },
  ],
  faqs: [
    {
      q: "Is Hermes Agent free?",
      a: "The Hermes Agent framework is free and open-source (MIT license). You can run it yourself for the cost of the server — Hetzner's cheapest VPS that can run it, the CX23, is €5.49/month excluding VAT. Hosting services like Hivra charge for the managed infrastructure on top of that.",
    },
    {
      q: "Do I need coding skills to use Hermes Agent?",
      a: "To self-host it, yes — you need to be comfortable in a Linux terminal. With a managed hosting service like Hivra, you do not need to touch a terminal. You still need to be comfortable writing clear task instructions for the agent.",
    },
    {
      q: "What AI models does Hermes Agent support?",
      a: "The default is the Hermes model family from Nous Research, but the agent supports 400+ models through OpenRouter, plus direct API connections to Anthropic, OpenAI, and local models via Ollama.",
    },
    {
      q: "How does Hermes differ from OpenClaw?",
      a: "Both are open-source agent frameworks with comparable capabilities. OpenClaw runs primarily as a desktop application. Hermes is designed from the start to run as a server process with persistent memory and a multi-platform communication gateway. Hermes also has a more stable release cadence and a built-in `hermes claw migrate` tool for OpenClaw users.",
    },
  ],
  relatedArticles: [
    { slug: "ai-agent-vs-chatbot", title: "AI agents vs chatbots: the difference that actually matters" },
    { slug: "persistent-memory-explained", title: "How persistent memory works in AI agents" },
    { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent (and why most people bail)" },
    { slug: "hermes-vs-openclaw", title: "Hermes Agent vs OpenClaw: an honest comparison" },
  ],
  relatedFeatures: [
    { slug: "persistent-memory", title: "Persistent Memory" },
    { slug: "browser-automation", title: "Browser Automation" },
  ],
};
