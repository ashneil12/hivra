import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "agent-zero-vs-openclaw-hosting",
  title: "Agent Zero vs OpenClaw hosting: requirements, costs, and which to run",
  metaTitle: "Agent Zero vs OpenClaw hosting: specs and costs",
  metaDescription:
    "Agent Zero and OpenClaw make different demands on a server. Real hosting requirements, security exposure, and monthly costs, with honest DIY numbers.",
  publishedDate: "2026-07-16",
  lastModified: "2026-09-24",
  readingTimeMin: 9,
  author: "Hivra team",
  tagline: "One agent lives in a dashboard. The other lives in your messages. Both need a box.",
  intro:
    "Agent Zero and OpenClaw are two of the most popular open-source agents you can self-host, and they are built for different jobs. This comparison focuses on the part most write-ups skip: what each one actually demands from a server, what hosting costs, and what can go wrong when you expose them to the internet.",
  sections: [
    {
      heading: "Two different agents, one hosting problem",
      paragraphs: [
        "[Agent Zero](https://github.com/agent0ai/agent-zero) is a general autonomous agent with its own web dashboard. You type a goal, and it plans the steps, writes and runs code, browses with a browser it ships inside its own container, and reports back. The whole stack runs in Docker on your machine.\n\n[OpenClaw](https://github.com/openclaw/openclaw) is an agent you message like a contact. It runs a persistent daemon with a heartbeat scheduler, connects to Telegram, WhatsApp, or Signal, and fires routines on time whether you are online or not. You do not open a dashboard to use it day to day; you text it.",
        "Different interaction models, same infrastructure problem. Both only make sense on a machine that stays on. Agent Zero working through a long goal cannot survive your laptop lid closing, and OpenClaw's heartbeat scheduler is pointless on a machine that is off at 3 a.m. Choosing between them means answering two things: which agent fits your work, and where it should run. This article covers both.",
      ],
    },
    {
      heading: "How you use each one day to day",
      paragraphs: [
        "**Agent Zero** is goal-driven. Its web UI shows a chat, plus a live view of the browser and computer the agent is using. The workflow is: open the dashboard, hand it a goal (\"research these five competitors and write up a summary\", \"build and test this script\"), watch it work or walk away, and read the report later. It is at its best on self-contained multi-step tasks where you want one agent to plan, execute, and verify without you wiring anything up.",
        "**OpenClaw** is ambient. After you connect your messaging channels in its Control UI, the agent is just another chat in your phone. You send it tasks the way you would text an assistant, and its heartbeat scheduler runs standing routines in the background: message you a morning summary of the feeds you follow, or ping you when a page you are watching changes. It is at its best as an always-available assistant that lives where you already are, which is your messages.",
        "If you are new to the category, [what is an AI agent](/blog/what-is-an-ai-agent) covers the basics. The short version for this comparison: pick Agent Zero when the unit of work is a goal you hand over, pick OpenClaw when the unit of work is an ongoing conversation plus scheduled routines.",
      ],
    },
    {
      heading: "Server requirements: one is heavier, one flexes",
      paragraphs: [
        "**Agent Zero** has the heavier and less negotiable footprint. It runs its full stack in a Docker container: the agent loop, its tools, and its own browser and computer. The [project's own VPS guide](https://github.com/agent0ai/agent-zero/blob/main/docs/setup/vps-deployment.md) lists 1 vCPU and 2 GB of RAM as the minimum and 2 vCPU with 4 GB or more as recommended. On Hivra an Agent Zero computer starts at 1 vCPU and 2 GB, and you can give it more from your plan's compute in the dashboard. There is no lighter mode, because the browser and computer ship inside the container whether or not a given task uses them.",
        "**OpenClaw** scales with what you turn on. The daemon and heartbeat scheduler are the light part: on Hivra an OpenClaw computer starts at 1 vCPU and 2 GB RAM, and switching browser automation on adds another 1 vCPU and 2 GB. If you self-host with the full Docker setup instead, budget more: [our OpenClaw self-hosting guide](/blog/how-to-self-host-openclaw) recommends 2 vCPU and 4 GB as the DIY minimum, because the multi-container install competes with everything else on the box.",
        "The browser difference matters more than the raw numbers. Agent Zero's browser is its own, inside its container, visible in its dashboard, with no extra setup. OpenClaw's optional browser works differently: turn it on and OpenClaw gets a real Chrome running on the same machine, with a live browser view where you log into your accounts once. After that, the agent acts inside those sessions. Self-contained browsing versus browsing as you, in your accounts. Which one you want depends on the tasks.",
      ],
    },
    {
      heading: "The security part nobody budgets for",
      paragraphs: [
        "Both agents ship a web UI, and a web UI on a server is a thing you have to protect. This is not hypothetical for OpenClaw: [Bitsight researchers counted more than 30,000 OpenClaw instances](https://www.bitsight.com/blog/openclaw-ai-security-risks-exposed-instances) exposed to the public internet between 27 January and 8 February 2026, and found that trivially weak tokens were accepted on exposed gateways. A one-click remote code execution flaw, [CVE-2026-25253](https://thehackernews.com/2026/02/openclaw-bug-enables-one-click-remote.html), was patched in v2026.1.29 and disclosed publicly in early February. An autonomous agent with shell access and your credentials is one of the worst possible things to leave open.",
        "Agent Zero has the same shape of risk. Its dashboard is the control surface for an agent that writes and runs code, so exposing it unauthenticated hands that power to anyone who finds the port.\n\nSelf-hosting either agent means owning this: a reverse proxy you configure correctly, authentication you bolt on, and updates you apply on the project's schedule, which for OpenClaw means new releases several times a month.",
        "Managed hosting closes the exposure gap by default: on Hivra each agent's UI is bound to localhost on its own private VM and reached only through Hivra's authenticated gateway. The trade-offs of doing this yourself versus paying someone are covered in [managed vs self-hosted AI agents](/blog/managed-vs-self-hosted-ai-agents).",
      ],
    },
    {
      heading: "What hosting actually costs",
      paragraphs: [
        "**DIY on a VPS.** A 1 vCPU, 2 GB box for a browserless OpenClaw runs about $5 to $10 a month. The 2 vCPU, 4 GB box that Agent Zero's guide recommends, or OpenClaw with the browser on, runs from €5.49 a month at Hetzner (excluding VAT) to $20-24 at Vultr, Linode, or DigitalOcean. Add your time: install, reverse proxy, auth, updates, and the occasional 2 a.m. restart. The [cost of running an AI agent](/blog/cost-of-running-ai-agent) breaks this down in detail.",
        "**Dedicated agent hosts.** Services that specialize in running OpenClaw for you exist too. They cost more than a raw VPS for a single always-on instance, because the security setup is part of what you pay for. Compare their current price pages before you pick one.",
        `**Hivra.** Both agents need a paid plan, [from ${ENTRY_PLAN_PRICE} a month](/pricing) for a compute pool of ${ENTRY_PLAN_SIZE}, with the UI kept private and no setup on your side.\n\nModel usage is the one cost hosting never includes, for anyone. Both agents need an LLM to think with, and model spend is often the larger number: a few dollars a month for light use, $50 or more for heavy daily work, depending on the model you pick. On Hivra you can use a managed model option (DeepSeek V4 Pro through Venice), paid from managed Venice credits you top up, or switch to your own provider any time: in the Control UI for OpenClaw, in Settings for Agent Zero. Keys you set there are stored on the agent's VM, and usage on your own key bills through your provider with no Hivra markup.`,
      ],
    },
    {
      heading: "Which one should you host?",
      paragraphs: [
        "**Host OpenClaw if** your agent's job is to be reachable and punctual: answer you in Telegram, WhatsApp, or Signal, run morning routines on its heartbeat, watch things while you sleep. It is lighter on the server, and its messaging-first design keeps it in a surface you already check daily. Start at [the OpenClaw page](/agents/openclaw).",
        "**Host Agent Zero if** your agent's job is to take a goal and go: multi-step research, tasks that need code written and run, work where watching the agent's browser and computer from one dashboard beats stitching tools together. Start at [the Agent Zero page](/agents/agent-zero).",
        "**Genuinely unsure?** Pick the one that matches where your work lives. If your day runs through messaging apps, OpenClaw will get used and a dashboard agent will not. If you have a backlog of hand-off-able projects, that is Agent Zero's home turf. For the wider landscape beyond these two, the [AI agent hosting guide](/blog/ai-agent-hosting-guide) compares the main options.",
      ],
    },
    {
      heading: "Running both, and the fastest way to try either one",
      paragraphs: [
        "Plenty of people end up wanting both: OpenClaw as the standing assistant, Agent Zero for hand-off projects. DIY, that is one 4 vCPU, 8 GB VPS, from €8.49 a month at Hetzner (excluding VAT) to $40-48 at Vultr or DigitalOcean, running the two side by side.",
        `On Hivra, one plan detail matters before you pick. A plan's compute is a pool shared across everything you run, and the ${ENTRY_PLAN_PRICE} plan's pool is ${ENTRY_PLAN_SIZE}. Both fit on the ${ENTRY_PLAN_PRICE} plan at their minimum size, with OpenClaw's browser off: Agent Zero at 1 vCPU and 2 GB plus OpenClaw at 1 vCPU and 2 GB fill that pool exactly. For OpenClaw with its browser on, or for more headroom (Agent Zero's own recommendation is 2 vCPU and 4 GB), take the [${LARGER_PLAN_PRICE} plan](/pricing), whose pool of ${LARGER_PLAN_SIZE} fits Agent Zero plus OpenClaw with its browser on. A stopped computer still counts against the pool; deleting it is what frees its share, so switching between agents is a delete and a relaunch, not a support ticket.`,
        `If you want to skip the setup entirely, either agent launches on Hivra from its page ([OpenClaw](/agents/openclaw) or [Agent Zero](/agents/agent-zero)): name the agent, pick a model in the agent's own UI, and hand it work. If the agent does not earn its keep, delete its computer. Paid plans come with a ${MONEY_BACK_GUARANTEE}.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Which needs a bigger server, Agent Zero or OpenClaw?",
      a: "Agent Zero. Its container bundles the agent loop, tools, and a browser and computer of its own, and the project recommends 2 vCPU and 4 GB RAM (with 1 vCPU and 2 GB as the minimum) and has no lighter mode. OpenClaw's daemon starts at 1 vCPU and 2 GB, and only grows if you switch its optional browser on.",
    },
    {
      q: "Which is easier to self-host?",
      a: "Agent Zero, narrowly. It ships as a single Docker container, so setup is one container plus a reverse proxy. OpenClaw's multi-container install has more moving parts, and the project ships new releases several times a month, so updates are a recurring chore. Either way you own the reverse proxy, the authentication, and the patching.",
    },
    {
      q: "How much does it cost to host Agent Zero or OpenClaw?",
      a: `A DIY VPS runs from about $5 a month at budget hosts to $20-24 for a 2 vCPU, 4 GB server at the US-brand hosts, and Hivra's paid plans start at ${ENTRY_PLAN_PRICE} a month for either agent. Whichever route you pick, budget separately for model usage; it is often the larger number.`,
    },
    {
      q: "What do these agents use for a model?",
      a: "Both need an LLM API to think with, and both speak OpenAI-compatible APIs, so most providers work. On Hivra you can use a managed model option (DeepSeek V4 Pro through Venice) paid from managed Venice credits, or set your own provider inside the agent's own UI. Keys you set there are stored on the agent's VM, and usage on your own key bills through your provider with no Hivra markup.",
    },
    {
      q: "Can I run Agent Zero and OpenClaw at the same time on one plan?",
      a: `Yes, on a plan whose compute pool fits both computers. Hivra's ${ENTRY_PLAN_PRICE} plan (${ENTRY_PLAN_SIZE}) fits both at minimum size with OpenClaw's browser off. The ${LARGER_PLAN_PRICE} plan (${LARGER_PLAN_SIZE}) fits Agent Zero plus OpenClaw with its browser on, with more headroom. A stopped computer still counts against the pool, so freeing room means deleting, not stopping.`,
    },
    {
      q: "Is it safe to self-host OpenClaw or Agent Zero on my own VPS?",
      a: "It can be, if you do the security work. Bitsight researchers counted more than 30,000 OpenClaw instances exposed to the internet in early 2026, and CVE-2026-25253, a one-click remote code execution flaw, was patched in v2026.1.29. Both agents' web UIs control software that can run code on your server, so a correctly configured reverse proxy, authentication, and prompt patching are non-negotiable.",
    },
    {
      q: "Are the hosted versions of Agent Zero and OpenClaw modified?",
      a: "No. Hivra runs both open-source projects unmodified on private VMs: Agent Zero as the container the project ships, OpenClaw with its Control UI exactly as the project ships it. Hivra is an independent hosting service and is not affiliated with or endorsed by either project.",
    },
  ],
  relatedArticles: [
    {
      slug: "openclaw-broken-after-update",
      title: "OpenClaw broken after an update? Every fix, in the order to try them",
    },
    {
      slug: "multi-agent-systems-explained",
      title: "Multi-agent AI systems in 2026: how they're built, what they cost, and when they're worth it",
    },
    { slug: "how-to-self-host-openclaw", title: "How to self-host OpenClaw: complete setup guide (2026)" },
    { slug: "hermes-vs-openclaw", title: "Hermes Agent vs OpenClaw: an honest comparison" },
    { slug: "managed-vs-self-hosted-ai-agents", title: "Managed vs self-hosted AI agents" },
    { slug: "ai-agent-hosting-guide", title: "AI agent hosting in 2026: every real option compared (VPS, serverless, managed)" },
    { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent in 2026" },
  ],
};
