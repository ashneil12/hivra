import { BlogArticle } from "../types";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "do-you-need-a-gpu-to-run-an-ai-agent",
  title: "Do you need a GPU to run an AI agent? Usually, no",
  metaTitle: "Do You Need a GPU to Run an AI Agent?",
  metaDescription:
    "Most AI agents need no local GPU because the model runs through a cloud API. When a GPU matters, what hardware you actually need, and how to choose.",
  publishedDate: "2026-09-01",
  lastModified: "2026-09-24",
  readingTimeMin: 9,
  author: "Hivra team",
  tagline: "The model may need a GPU. The machine running your agent often does not.",
  intro:
    "You usually do not need a GPU to run an AI agent. If the agent calls a model through Anthropic, OpenAI, Google, OpenRouter, or another cloud API, the provider runs the model on its hardware. Your machine only runs the agent, its tools, and any browser or code processes it starts.",
  sections: [
    {
      heading: "The short answer",
      paragraphs: [
        "A GPU is optional for most AI agents. The deciding question is where model inference happens. Inference is the work of turning your prompt and context into the model's next response. If that happens in a provider's datacenter, your agent does not need a graphics card. A small laptop, home server, virtual private server, or cloud VM can run the surrounding agent loop.",
        "You need a capable GPU when you want the model itself to run locally. That includes agents connected to local models through tools such as Ollama, llama.cpp, or vLLM. In that setup, the machine must hold model weights in memory and perform the calculations for every generated token. The hardware requirement belongs to the model, not to the fact that the software is an agent.",
        "This distinction explains why a terminal agent such as [Codex](/agents/codex) or Claude Code can run on a modest remote box while a local Llama model may need an expensive workstation. Both are AI systems. Only one is doing inference on that machine.",
      ],
    },
    {
      heading: "Two AI agent setups that look similar but need different hardware",
      paragraphs: [
        "An API-based agent has a lightweight local loop. It collects your request, sends context to a model provider, receives a tool call, runs that tool, and sends the result back. The local machine handles files, shell commands, memory, scheduling, and network traffic. The provider handles the matrix calculations that benefit from GPUs.",
        "A local-model agent keeps the same loop but also runs the language model. That changes the hardware profile completely. Model weights must fit in RAM or GPU memory. Larger context windows use more memory. Faster generation needs more memory bandwidth and compute. A GPU is not technically mandatory because many models can run on a CPU, but CPU-only inference can be too slow for an agent that needs dozens of model turns to finish one task.",
        "The practical split is simple:\n\n| Agent setup | GPU required? | What the local machine does |\n|---|---|---|\n| Claude Code or Codex with a subscription login | No | Runs the CLI, repository tools, and shell commands |\n| Agent using an Anthropic, OpenAI, Gemini, or OpenRouter API | No | Runs the agent loop and sends inference requests |\n| Agent with browser automation | Usually no | Runs the agent plus Chromium, which mainly needs RAM and CPU |\n| Agent using a small Ollama model on CPU | No, but often slow | Runs both the agent and local inference |\n| Agent using a medium or large local model at useful speed | Usually yes | Runs the agent and GPU-accelerated inference |",
      ],
    },
    {
      heading: "What hardware does an API-based AI agent need?",
      paragraphs: [
        "For a single terminal-based agent that calls a cloud model, start with 2 vCPU, 4 GB of RAM, and roughly 40 GB of SSD storage. The agent process itself may use less. The extra room covers package installation, code builds, logs, Docker, and the operating system. A 1 vCPU, 2 GB box can work for light tasks, but it has little margin when a build or dependency install spikes memory use.",
        "Browser automation changes the recommendation more than the agent does. Chromium can open several renderer processes, and modern pages are heavy. Give a browser-driving agent at least 4 GB of RAM, with 8 GB more comfortable for multiple tabs or larger web apps. A GPU can help render graphics, but it is not required for normal browser research, form filling, screenshots, or Playwright tasks.",
        "Disk and reliability also matter. Agent sessions, repositories, browser downloads, container layers, and logs accumulate. SSD storage makes those operations feel faster. If the agent runs unattended, a process supervisor and basic monitoring are more useful than a graphics card. The [AI agent VPS guide](/blog/ai-agent-vps) covers sizing, security, and restart setup in detail.",
      ],
    },
    {
      heading: "When a GPU is worth it",
      paragraphs: [
        "A GPU makes sense when local inference is a deliberate requirement. You may want private processing, no per-token API bill, operation without an internet connection, control over a specific open model, or very high sustained usage where owned hardware is cheaper over time. Those are valid reasons. They also come with more setup and capacity planning.",
        "Start from the model you intend to run, then choose hardware. A small quantized model may fit in 8 GB of system memory and run on a CPU for experimentation. Larger models need much more memory, and GPU memory is usually the limiting number. If the full model does not fit, software may split work between GPU and system RAM, but generation slows. Context length, quantization, concurrent agents, and tool-call frequency all affect the real requirement.",
        "Do not buy a GPU based only on a model's parameter count or a single benchmark. Check the exact model file size, required context, expected tokens per second, and whether the runtime supports your operating system and GPU. Then test the model on rented hardware before buying a workstation. A short rental is cheaper than discovering that a new card cannot hold your chosen model.",
      ],
    },
    {
      heading: "Why agents can feel slow even without local inference",
      paragraphs: [
        "A slow API-based agent does not automatically need a GPU. Its waiting time is usually elsewhere: model-provider latency, a large prompt, a slow web page, package installation, a code build, network round trips, or a tool that is waiting for another service. A graphics card on the agent machine will not speed up a model running in someone else's datacenter.",
        "Measure before changing hardware. Watch CPU, memory, disk pressure, and network activity during the slow step. If CPU is idle while the agent waits for a response, local compute is not the bottleneck. If the machine swaps heavily while Chromium is open, add RAM. If a TypeScript build pins every core, add CPU. If Ollama is generating one token every few seconds, then local inference hardware is the issue and a GPU may help.",
        "This is also why a remote agent can work well on a modest cloud VM. It needs enough capacity for the tools it operates, not enough capacity to train or serve the cloud model. The [AI agent hosting guide](/blog/ai-agent-hosting-guide) compares home hardware, a raw VPS, serverless jobs, and managed hosting using this same distinction.",
      ],
    },
    {
      heading: "A decision checklist before you buy anything",
      paragraphs: [
        "Answer these questions in order:\n\n1. **Will the model run locally or through an API?** An API means no local inference GPU.\n2. **What tools will the agent run?** Browsers, builds, Docker, and data processing determine CPU and RAM needs.\n3. **Does the workload need to stay private or offline?** If yes, local inference may justify the hardware.\n4. **Which exact model and context length will you use?** Size hardware for that combination, not for the phrase AI agent.\n5. **How many agents or model requests run at once?** Concurrency raises memory and compute needs.\n6. **Have you tested on rented hardware?** Validate speed and memory before buying a GPU.",
        "For most people starting with an agent, the sensible route is an API-based setup on hardware they already own or a small remote machine. Learn which tasks are valuable first. Move to local inference only when privacy, offline operation, or usage economics make the extra complexity worthwhile.",
      ],
    },
    {
      heading: "Run the agent without buying a GPU",
      paragraphs: [
        "If you want an always-on agent but do not want another machine at home, [Hivra](/) runs agents on private cloud VMs. The official [Codex](/agents/codex) and [Claude Code](/agents/claude-code) CLIs use your own subscription sign-in, so their models still run through the provider. [Hermes](/agents/hermes) can use cloud model providers while its tools, memory, and schedules run on the VM.",
        `Plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, and they come with a ${MONEY_BACK_GUARANTEE}, so you can try one agent without buying hardware. Compare the plans on the [pricing page](/pricing). No GPU purchase is needed for these cloud-model setups. The better first investment is enough RAM for the tools your agent actually uses.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Do I need a GPU to run an AI agent?",
      a: "Usually not. Agents that call cloud models from Anthropic, OpenAI, Google, OpenRouter, or similar providers only need local CPU, RAM, disk, and network capacity for the agent loop and its tools. A GPU matters when the language model itself runs locally.",
    },
    {
      q: "Can I run an AI agent on a normal laptop?",
      a: "Yes. A normal laptop can run an API-based agent such as Codex, Claude Code, or Hermes. The laptop must stay awake while the process runs. For unattended work, move the same setup to an always-on desktop, home server, VPS, or managed VM.",
    },
    {
      q: "How much RAM does an AI agent need?",
      a: "For one API-based terminal agent, 2 GB is a workable minimum and 4 GB is a more comfortable starting point. Browser automation and large code builds can justify 8 GB. Local models need additional memory based on model size, quantization, context length, and concurrency.",
    },
    {
      q: "Does browser automation need a GPU?",
      a: "Not for ordinary agent tasks. Chromium uses CPU and RAM for most research, navigation, screenshots, and form work. More RAM usually helps more than a GPU. Graphics-heavy sites or video processing are separate workloads and may benefit from acceleration.",
    },
    {
      q: "Can an AI agent run a local model without a GPU?",
      a: "Yes. Small quantized models can run on a CPU through tools such as Ollama or llama.cpp. The trade-off is speed. An agent may call the model many times per task, so slow CPU generation can make the full workflow impractical.",
    },
    {
      q: "Should I buy a GPU or use a cloud model API?",
      a: "Start with a cloud API unless you already have a clear need for private, offline, or high-volume local inference. It is easier to validate the agent's value first. If local inference becomes justified, rent the intended GPU briefly and test the exact model before buying hardware.",
    },
  ],
  relatedArticles: [
    {
      slug: "ai-agent-vps",
      title: "AI agent VPS guide: specs, providers, and setup that actually works",
    },
    {
      slug: "ai-agent-hosting-guide",
      title: "AI agent hosting: home hardware, VPS, serverless, and managed",
    },
    {
      slug: "cost-of-running-ai-agent",
      title: "The real cost of running a persistent AI agent",
    },
    {
      slug: "run-ai-agents-24-7",
      title: "How to run AI agents 24/7",
    },
    {
      slug: "what-is-an-ai-agent",
      title: "What is an AI agent?",
    },
  ],
  relatedFeatures: [
    { slug: "browser-automation", title: "Browser automation" },
    { slug: "persistent-memory", title: "Persistent memory" },
    { slug: "scheduled-tasks", title: "Scheduled tasks" },
  ],
};
