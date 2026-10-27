import { BlogArticle } from "../types";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "ai-agent-api-cost-optimization",
  title: "What an AI agent costs per month in API tokens (2026)",
  metaTitle: "What an AI agent costs per month in API tokens",
  metaDescription:
    "A worked monthly API bill for an autonomous agent on Anthropic and OpenAI models, as of October 2026, plus the cuts that actually lower it.",
  publishedDate: "2026-04-03",
  lastModified: "2026-10-21",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "A worked bill, current prices, and the cuts that matter.",
  intro:
    "Ask what an agent costs per month and you usually get a list of tips. You wanted a bill. Here's one, on Anthropic and OpenAI prices as of October 2026, plus the few cuts that actually move the number.",
  shortAnswer:
    "An autonomous agent running about 20 times a day, at 8,000 input and 2,000 output tokens per run, costs roughly $1 a month on Claude Haiku 5.5, $22 on Sonnet 5.5, or $43 on Opus 5.5 at Anthropic's October 2026 rates. Add your host on top. This is a worked example, not a measurement.",
  sections: [
    {
      heading: "What does an autonomous agent cost per month?",
      paragraphs: [
        "Between $1 and $108 a month for the same workload, depending on the model. This is a worked example, not something we measured, so here are the assumptions to swap for your own: 20 runs a day for 30 days, which is 600 runs. Each run reads about 8,000 tokens and writes about 2,000. That adds up to 4.8 million input tokens and 1.2 million output tokens a month. GPT-4 is legacy now, so the rows use current models.",
        `Prices are per million tokens (input/output), from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) and [OpenAI's API pricing page](https://developers.openai.com/api/docs/pricing) (Standard, short context). Haiku 5.5 is priced by prompt length: the rates below are for prompts up to 100,000 tokens, and a run of 8,000 input tokens is well inside that.\n\n| Model | Vendor rate (in/out) | Worked monthly API cost |\n|---|---|---|\n| Claude Haiku 5.5 | $0.10 / $0.50 | 4.8×$0.10 + 1.2×$0.50 = **$1.08** |\n| Claude Haiku 5.5 via Batch API | $0.05 / $0.25 | half of Haiku = **$0.54** |\n| Claude Sonnet 5.5 | $2 / $10 | 4.8×$2 + 1.2×$10 = **$21.60** |\n| Claude Opus 5.5 | $4 / $20 | 4.8×$4 + 1.2×$20 = **$43.20** |\n| OpenAI gpt-6-luna | $0.10 / $0.50 | 4.8×$0.10 + 1.2×$0.50 = **$1.08** |\n| OpenAI gpt-6.1-sol | $2 / $10 | 4.8×$2 + 1.2×$10 = **$21.60** |\n| OpenAI gpt-6-astra | $10 / $50 | 4.8×$10 + 1.2×$50 = **$108.00** |\n\nDouble the runs, or double the tokens per run, and the bill doubles. A browser-heavy agent that sends screenshots each step burns more input than this table assumes. Hosting sits on top: on Hivra that starts at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}. Compare DIY versus managed with the [AI agent hosting cost calculator](/tools/ai-agent-hosting-cost-calculator), and see how a [bring-your-own API key](/blog/byo-api-key-explained) keeps the token line on your own invoice with no Hivra markup on that key.`,
      ],
    },
    {
      heading: "Why does an agent cost more than chat?",
      paragraphs: [
        "Because it re-reads everything at every step. A chat message costs tokens once: your message in, the reply out. An agent on a 10-step task sends the original instruction, the history so far and the tool definitions every single step, then feeds each tool result into the next one. By step 10 it's re-reading all 9 earlier actions and results. The bill snowballs as the task goes on.",
        "One Reddit r/AI_Agents thread reported agents using approximately 4x more tokens than equivalent chat interactions, and multi-agent setups (an orchestrator plus specialist sub-agents sharing context) about 15x. Treat those as rough community figures, not measurements. That's just what multi-step work costs. The trap is timing: a bill that looked fine while you were chatting turns into a nasty surprise the month your agents start running on a schedule.",
        "Browser work is the multiplier that catches people out. Screenshots and page captures go in as image tokens, and those are pricey on every model. A task that takes 10 screenshots, each at roughly 1,000 tokens of image context, running daily, generates about 300,000 tokens per month purely from screenshots. For browser-heavy monitoring, put the screenshot reading on Haiku 5.5 and the decisions on Sonnet 5.5. It's cheaper than running the lot on Sonnet.",
      ],
    },
    {
      heading: "What do the models cost per token right now?",
      paragraphs: [
        "As of October 2026, per million tokens (input/output), from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) and [OpenAI's API pricing page](https://developers.openai.com/api/docs/pricing) (Standard, short context):\n\n| Model | Input / output | Good for |\n|---|---|---|\n| Claude Haiku 5.5 | $0.10 / $0.50 | Fast, cheap steps (prompts up to 100,000 tokens; $0.50 / $2.50 above that) |\n| Claude Sonnet 5.5 | $2.00 / $10.00 | Most agent reasoning |\n| Claude Opus 5.5 | $4.00 / $20.00 | Hard, complex tasks |\n| gpt-6-luna | $0.10 / $0.50 | The cheapest flagship-tier row on OpenAI's table |\n| gpt-6.1-sol | $2.00 / $10.00 | Everyday reasoning |\n| gpt-6-astra | $10.00 / $50.00 | OpenAI's top tier |\n| gpt-5.3-codex | $1.75 / $14.00 | Listed under Codex on the same page |\n\nPlenty of older write-ups still quote GPT-4 or GPT-5 mini. That's history. Check the vendor page before you budget.",
        "Anthropic's Batch API takes 50% off any rate if you can wait up to 24 hours for the answer. Nightly summaries, weekly reports and competitor checks rarely need an answer this second, so batching just halves their bill. Haiku 5.5 on batch is $0.05 in and $0.25 out per million tokens for prompts up to 100,000 tokens. At that price, frequent monitoring gets very cheap.\n\nWeb search costs extra. Anthropic charges $10 per 1,000 searches plus the tokens the results add. OpenAI charges $10.00 per 1,000 calls plus the search content at model rates. If your agent searches a lot, give search its own line in the budget.",
      ],
    },
    {
      heading: "Which cuts actually lower the bill?",
      paragraphs: [
        "Model routing first. Sort tasks by how hard they are before you run them, and send each to the right model. Lookups, summaries and format changes go to Haiku 5.5 or gpt-6-luna. Hard reasoning, code and multi-step planning go to Sonnet 5.5 or gpt-6.1-sol. On the worked table above, moving the same 600 runs from Sonnet 5.5 to Haiku 5.5 takes the month from about $22 to about $1, so sending the work that suits Haiku there is the biggest single lever.",
        "Then trim what you resend. Drop repeated history, squash old turns into summaries, and cut the padding out of your system prompt. Every 1,000 tokens you shave off the average run comes straight off a month of invoices.",
        "Cache answers you keep paying for. If a monitoring task checks the same pages or asks the same question over and over, store the expensive answer and reuse it for similar inputs for a while. The small embedding model that spots 'similar' costs next to nothing.",
        "Batch anything that can wait. Anthropic's Batch API (50% off) or OpenAI's batch pricing suits nightly reports, weekly summaries and monthly data jobs. You might wait up to 24 hours for results. For a report nobody reads until Monday, who cares?",
        "And set a hard spend limit today. Most providers let you cap monthly spend or set billing alerts per account or project. Put the cap well under what you'd be comfortable losing, because an agent stuck in a retry loop can burn thousands of dollars overnight. A cap is cheap insurance.",
      ],
    },
    {
      heading: "What would this cost on Hivra?",
      paragraphs: [
        `Here's an illustration, not a measurement: someone running 5 to 7 scheduled tasks on Hivra's ${ENTRY_PLAN_PRICE}/month plan (${ENTRY_PLAN_SIZE}), at the rates above. Weekly research tasks on Sonnet 5.5: $5-10/month. Occasional complex reasoning on Opus 5.5: $3-8/month. Competitive monitoring and daily summaries go on Haiku 5.5, using half-price batching where a task can wait ($0.05/$0.25 per MTok). Haiku 5.5's rate is a tenth of what Haiku 4.5's was, so the Haiku line is the small one. The token volumes behind these ranges are not stated, so there is no monthly total here: add the host, which is ${ENTRY_PLAN_PRICE}/month on Hivra for ${ENTRY_PLAN_SIZE}, to the lines you expect to use.`,
        "For browser-intensive workloads (daily scraping of 5-10 competitor pages with screenshot analysis), expect $15-30/month in API tokens using Haiku for vision steps and Sonnet for synthesis. Ten pages per day for 30 days is about 300,000 screenshot tokens, roughly $0.03/month at Haiku 5.5 input rates, so most of the cost is the reasoning steps. Budget for that before you put browser work on a daily schedule.\n\nWant the host line side by side with a VPS? Use the [AI agent hosting cost calculator](/tools/ai-agent-hosting-cost-calculator). Token billing stays on your provider when you [bring your own API key](/blog/byo-api-key-explained); Hivra does not mark up that key.",
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
      a: "As of October 2026, gpt-6-luna at $0.10/$0.50 per million tokens is the cheapest flagship-tier row on OpenAI's Standard short-context table. Claude Haiku 5.5 lists at the same $0.10/$0.50 for prompts up to 100,000 tokens ($0.50/$2.50 above that). Via the Anthropic Batch API, Haiku 5.5 drops to $0.05/$0.25, often the best value for async scheduled workloads.",
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
      a: `As an illustration, not a measurement (5 to 7 scheduled tasks, mixed Haiku and Sonnet): Sonnet research tasks $5-10/month and occasional Opus reasoning $3-8/month, with the Haiku part small because Haiku 5.5's rate is a tenth of what Haiku 4.5's was. Hivra's entry plan is ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE} on top. Browser-heavy workloads with daily scraping add $15-30/month. No monthly total is given, because the token volumes behind these ranges are not stated.`,
    },
    {
      q: "What does an autonomous AI agent cost per month on the GPT-4 API?",
      a: "GPT-4 is legacy. Budget on current models instead. Using the labelled example on this page (20 runs a day, 8,000 input and 2,000 output tokens per run), Claude Haiku 5.5 is about $1/month, Sonnet 5.5 about $22, Opus 5.5 about $43, and OpenAI gpt-6-luna about $1 at October 2026 rates. Add hosting on top.",
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
