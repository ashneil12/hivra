import { BlogArticle } from "../types";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "ai-agent-api-cost-optimization",
  title: "What an AI agent costs per month in API tokens (2026)",
  metaTitle: "What an AI agent costs per month in API tokens",
  metaDescription:
    "A worked monthly API bill for an autonomous agent on Anthropic and OpenAI models, as of October 2026, plus the cuts that actually lower it.",
  publishedDate: "2026-04-03",
  lastModified: "2026-10-05",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "A worked bill, current prices, and the cuts that matter.",
  intro:
    "Ask what an agent costs per month and you usually get a list of tips. You wanted a bill. Here's one, on Anthropic and OpenAI prices as of October 2026, plus the few cuts that actually move the number.",
  shortAnswer:
    "An autonomous agent running about 20 times a day, at 8,000 input and 2,000 output tokens per run, costs roughly $11 a month on Claude Haiku 4.5, $22 on Sonnet 5.5, or $43 on Opus 5.5 at Anthropic's October 2026 rates. Add your host on top. This is a worked example, not a measurement.",
  sections: [
    {
      heading: "What does an autonomous agent cost per month?",
      paragraphs: [
        "Between $1 and $108 a month for the same workload, depending on the model. This is a worked example, not something we measured, so here are the assumptions to swap for your own: 20 runs a day for 30 days, which is 600 runs. Each run reads about 8,000 tokens and writes about 2,000. That adds up to 4.8 million input tokens and 1.2 million output tokens a month. GPT-4 is legacy now, so the rows use current models.",
        `Prices are per million tokens (input/output), from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) and [OpenAI's API pricing page](https://developers.openai.com/api/docs/pricing) (Standard, short context).\n\n| Model | Vendor rate (in/out) | Worked monthly API cost |\n|---|---|---|\n| Claude Haiku 4.5 | $1 / $5 | 4.8×$1 + 1.2×$5 = **$10.80** |\n| Claude Haiku 4.5 via Batch API | $0.50 / $2.50 | half of Haiku = **$5.40** |\n| Claude Sonnet 5.5 | $2 / $10 | 4.8×$2 + 1.2×$10 = **$21.60** |\n| Claude Opus 5.5 | $4 / $20 | 4.8×$4 + 1.2×$20 = **$43.20** |\n| OpenAI gpt-6-luna | $0.10 / $0.50 | 4.8×$0.10 + 1.2×$0.50 = **$1.08** |\n| OpenAI gpt-6.1-sol | $2 / $10 | 4.8×$2 + 1.2×$10 = **$21.60** |\n| OpenAI gpt-6-astra | $10 / $50 | 4.8×$10 + 1.2×$50 = **$108.00** |\n\nDouble the runs, or double the tokens per run, and the bill doubles. A browser-heavy agent that sends screenshots each step burns more input than this table assumes. Hosting sits on top: on Hivra that starts at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}. Compare DIY versus managed with the [AI agent hosting cost calculator](/tools/ai-agent-hosting-cost-calculator), and see how a [bring-your-own API key](/blog/byo-api-key-explained) keeps the token line on your own invoice with no Hivra markup on that key.`,
      ],
    },
    {
      heading: "Why does an agent cost more than chat?",
      paragraphs: [
        "Because it re-reads everything at every step. A chat message costs tokens once: your message in, the reply out. An agent on a 10-step task sends the original instruction, the history so far and the tool definitions every single step, then feeds each tool result into the next one. By step 10 it's re-reading all 9 earlier actions and results. The bill snowballs as the task goes on.",
        "A Reddit r/AI_Agents thread tracking this precisely found agents use approximately 4x more tokens than equivalent chat interactions. Multi-agent setups (an orchestrator plus specialist sub-agents sharing context) use about 15x. That's just what multi-step work costs. The trap is timing: a bill that looked fine while you were chatting turns into a nasty surprise the month your agents start running on a schedule.",
        "Browser work is the multiplier that catches people out. Screenshots and page captures go in as image tokens, and those are pricey on every model. A task that takes 10 screenshots, each at roughly 1,000 tokens of image context, running daily, generates about 300,000 tokens per month purely from screenshots. For browser-heavy monitoring, put the screenshot reading on Haiku 4.5 and the decisions on Sonnet 5.5. It's cheaper than running the lot on Sonnet.",
      ],
    },
    {
      heading: "What do the models cost per token right now?",
      paragraphs: [
        "As of October 2026, per million tokens (input/output), from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) and [OpenAI's API pricing page](https://developers.openai.com/api/docs/pricing) (Standard, short context):\n\n| Model | Input / output | Good for |\n|---|---|---|\n| Claude Haiku 4.5 | $1.00 / $5.00 | Fast, cheap steps |\n| Claude Sonnet 5.5 | $2.00 / $10.00 | Most agent reasoning |\n| Claude Opus 5.5 | $4.00 / $20.00 | Hard, complex tasks |\n| gpt-6-luna | $0.10 / $0.50 | The cheapest flagship-tier row on OpenAI's table |\n| gpt-6.1-sol | $2.00 / $10.00 | Everyday reasoning |\n| gpt-6-astra | $10.00 / $50.00 | OpenAI's top tier |\n| gpt-5.3-codex | $1.75 / $14.00 | Listed under Codex on the same page |\n\nPlenty of older write-ups still quote GPT-4 or GPT-5 mini. That's history. Check the vendor page before you budget.",
        "Anthropic's Batch API takes 50% off any rate if you can wait up to 24 hours for the answer. Nightly summaries, weekly reports and competitor checks rarely need an answer this second, so batching just halves their bill. Haiku 4.5 on batch is $0.50 in and $2.50 out per million tokens. At that price, frequent monitoring gets very cheap.\n\nWeb search costs extra. Anthropic charges $10 per 1,000 searches plus the tokens the results add. OpenAI charges $10.00 per 1,000 calls plus the search content at model rates. If your agent searches a lot, give search its own line in the budget.",
      ],
    },
    {
      heading: "What do real developers actually spend?",
      paragraphs: [
        "Developer Ari Vance started at $847.32 a month and wrote up six weeks of cutting. Week by week: $212, $198, $135, $98, $68, $42. He settled at $159 a month, 81% lower. Where the savings came from: model routing (35% of the cut), prompt compression (22%), semantic caching (18%), production RAG (14%) and async batching (11%).",
        "Developer Helen Mireille ran OpenClaw on her own server for three months and posted the bill. $72 for the VPS. $359 in API tokens ($187, then $94, then $78, falling as she moved tasks to cheaper models). $75 for a vector database, $45 for monitoring, $9 for the domain and SSL. $560 in all. Her token cost fell 58% from month one to month three once she sent hard tasks to Claude Opus, normal ones to Sonnet and simple lookups to Haiku. Then she moved to a $49 a month managed platform and saved $138 a month, plus 3 to 15 hours of upkeep.",
        "On Reddit's r/AI_Agents in early 2026, small teams starting out reported spending $500 to $2,000 a month on AI APIs. One startup founder moved from $3,000/month on GPT-4 to $150/month on a cheaper then-current mini model for 95% of tasks, saving $34,200/year. A solo AI agency founder with eight clients at $5,000/month each reported $6,000/month in AI API costs against $40,000 revenue, an 85% profit margin.",
      ],
    },
    {
      heading: "Which cuts actually lower the bill?",
      paragraphs: [
        "Model routing first. Sort tasks by how hard they are before you run them, and send each to the right model. Lookups, summaries and format changes go to Haiku 4.5 or gpt-6-luna. Hard reasoning, code and multi-step planning go to Sonnet 5.5 or gpt-6.1-sol. In the write-ups above, this one change cut 30 to 40% of the bill. Nothing else comes close.",
        "Then trim what you resend. Drop repeated history, squash old turns into summaries, and cut the padding out of your system prompt. That was 22% of Vance's savings. Every 1,000 tokens you shave off the average run comes straight off a month of invoices.",
        "Cache answers you keep paying for. If a monitoring task checks the same pages or asks the same question over and over, store the expensive answer and reuse it for similar inputs for a while. The small embedding model that spots 'similar' costs next to nothing.",
        "Batch anything that can wait. Anthropic's Batch API (50% off) or OpenAI's batch pricing suits nightly reports, weekly summaries and monthly data jobs. You might wait up to 24 hours for results. For a report nobody reads until Monday, who cares?",
        "And set a hard spend limit today. Most providers let you cap monthly spend or set billing alerts per account or project. Put the cap well under what you'd be comfortable losing, because an agent stuck in a retry loop can burn thousands of dollars overnight. A cap is cheap insurance.",
      ],
    },
    {
      heading: "What would this cost on Hivra?",
      paragraphs: [
        `Here's an illustration, not a measurement: someone running 5 to 7 scheduled tasks on Hivra's ${ENTRY_PLAN_PRICE}/month plan (${ENTRY_PLAN_SIZE}), at the rates above. Competitive monitoring and daily summaries on Haiku 4.5, using half-price batching where a task can wait ($0.50/$2.50 per MTok): about $2-4/month. Weekly research tasks on Sonnet 5.5: $5-10/month. Occasional complex reasoning on Opus 5.5: $3-8/month. Total API: $10-22/month. Full stack: about $20-32/month for a persistent agent on that host size.`,
        "For browser-intensive workloads (daily scraping of 5-10 competitor pages with screenshot analysis), expect $15-30/month in API tokens using Haiku for vision steps and Sonnet for synthesis. Ten pages per day for 30 days is about 300,000 screenshot tokens, roughly $0.30/month at Haiku input rates, so most of the cost is the reasoning steps. Budget for that before you put browser work on a daily schedule.\n\nWant the host line side by side with a VPS? Use the [AI agent hosting cost calculator](/tools/ai-agent-hosting-cost-calculator). Token billing stays on your provider when you [bring your own API key](/blog/byo-api-key-explained); Hivra does not mark up that key.",
      ],
    },
  ],
  faqs: [
    {
      q: "Why do AI agents cost so much more than chatbots?",
      a: "Agents pay for tokens at every step, not once. By step 10, each call re-reads all 9 earlier actions and results. Multi-agent setups share that context across several agents, which multiplies it again. Rough figures: agents use about 4x the tokens of chat, and multi-agent systems about 15x.",
    },
    {
      q: "What is the cheapest model for running AI agent tasks in 2026?",
      a: "As of October 2026, gpt-6-luna at $0.10/$0.50 per million tokens is the cheapest flagship-tier row on OpenAI's Standard short-context table. Claude Haiku 4.5 ($1.00/$5.00) costs more per token but is strong on structured tool-calling. Via the Anthropic Batch API, Haiku 4.5 drops to $0.50/$2.50, often the best value for async scheduled workloads.",
    },
    {
      q: "How do I prevent runaway API costs from an agent in a retry loop?",
      a: "Set a monthly spend limit on your API account now. Anthropic, OpenAI and Google all offer limits or billing alerts. Add a step limit per task in your agent framework so a failing tool can only retry so many times. And switch on failure notifications, so you hear about a broken task the day it breaks, not on next month's invoice.",
    },
    {
      q: "Does Hivra let me control which model runs which tasks?",
      a: "Yes, per agent. Each agent uses the model you pick in its own settings, and a scheduled task runs on the agent you assign it to, so you can put cheap monitoring on one agent and heavier reasoning on another. A scheduled task has no model setting of its own. Usage on your own key bills through your provider at its rates.",
    },
    {
      q: "What does it actually cost per month to run a Hermes agent?",
      a: `As an illustration, not a measurement (5 to 7 scheduled tasks, mixed Haiku and Sonnet at October 2026 rates): $10-22/month in API tokens plus ${ENTRY_PLAN_PRICE}/month for Hivra's entry plan (${ENTRY_PLAN_SIZE}) = $20-32/month total. Browser-heavy workloads with daily scraping add $15-30/month. Full range: about $25-62/month for a fully operational persistent agent.`,
    },
    {
      q: "What does an autonomous AI agent cost per month on the GPT-4 API?",
      a: "GPT-4 is legacy. Budget on current models instead. Using the labelled example on this page (20 runs a day, 8,000 input and 2,000 output tokens per run), Claude Haiku 4.5 is about $11/month, Sonnet 5.5 about $22, Opus 5.5 about $43, and OpenAI gpt-6-luna about $1 at October 2026 rates. Add hosting on top.",
    },
  ],
  relatedArticles: [
    { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent" },
    { slug: "byo-api-key-explained", title: "BYO API key: what it means and why it matters" },
    { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
    { slug: "how-ai-agents-work", title: "How AI agents actually work" },
  ],
  relatedFeatures: [
    { slug: "scheduled-tasks", title: "Scheduled Tasks" },
    { slug: "browser-automation", title: "Browser Automation" },
  ],
  relatedComparisons: [
    { slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" },
  ],
};
