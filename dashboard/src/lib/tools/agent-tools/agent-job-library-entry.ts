// Catalog entry for the AI agent job library (/tools/ai-agent-use-cases). Type-only import from the
// catalog: the catalog imports the entries, so a value import here would be a cycle.

import type { ToolEntry } from "../tool-catalog";
import { formatPlanSize } from "@/lib/blog/plan-facts";
import { AGENT_JOBS, AGENT_JOB_FACTS, CATEGORIES, CATEGORY_IDS } from "./agent-job-library";

const ENTRY_SIZE = formatPlanSize("entry");
const JOB_COUNT = AGENT_JOBS.length;
const CATEGORY_COUNT = CATEGORY_IDS.length;

export const AGENT_JOB_LIBRARY_ENTRY: ToolEntry = {
  slug: "ai-agent-use-cases",
  name: "AI Agent Job Library",
  h1: `AI agent jobs: ${JOB_COUNT} things to hand your agent`,
  subhead: `${JOB_COUNT} copy-and-paste prompts for Hermes, OpenClaw and other agents, filtered by what your agent can reach, each with an honest note on setup and risk.`,
  metaTitle: "AI Agent Examples: 40 Jobs to Hand Your Agent",
  browserTitle: "AI Agent Examples: 40 Jobs to Hand Your Agent | Hivra",
  metaDescription:
    "40 AI agent examples with copy-and-paste prompts for Hermes, OpenClaw and similar agents: inbox, research, content, code and more. Free, with setup notes.",
  intro: {
    lede: `Most lists of AI agent examples stop at a headline. This one gives you the prompt. There are ${JOB_COUNT} jobs in ${CATEGORY_COUNT} groups, each with a prompt you can paste into your agent, a suggested schedule, what the agent needs to be connected to, and what you must set up first.`,
    body: [
      "Every prompt is written to be specific, with placeholders in square brackets for the parts that are yours. Pick a job, fill the brackets and paste it into a chat with your agent. Hermes has a built-in scheduler you can ask in plain language, and OpenClaw has an automations scheduler you manage with its `openclaw automations` command, so a job with a schedule can run on its own once you have seen it work by hand.",
      "The prompts are safe by design. Any job that could write a message, post or change a file says in the prompt that the agent writes a draft and waits for your approval. Money jobs never buy anything. We make no promise about time or money, because that depends on you and on how well the job is set up. Each card says what can go wrong.",
      "Use the filters to show only the jobs your agent can do with what it is connected to today. Start with one read-only job, watch it for a week, then add another.",
    ],
    note: "A prompt is a starting point, not a guarantee. Models differ, and agents misread things. Run each job by hand first, check the result against what you know, and keep a human in the loop for anything that leaves your computer.",
  },
  faqs: [
    {
      q: "What can an AI agent actually do for me?",
      a: "An agent can read what you connect it to, such as email, a calendar, files or web pages, follow a written instruction and report back in a chat. It can also run on a schedule. The jobs on this page fall into eight groups: inbox and calendar, research and monitoring, content and social, sales and outreach, code and ops, personal admin, money and shopping, and learning. What it can do for you depends on what you connect and how clearly you write the prompt.",
    },
    {
      q: "What are some good Hermes agent use cases?",
      a: "Hermes has a built-in scheduler that takes plain language or cron expressions and can deliver results back to your chat, so scheduled reads are a natural fit: a morning inbox sort, a weekly research brief, a monthly dependency check. It can also attach skills to a scheduled job, and optionally pass the previous run's output into the next one, though by default each run starts fresh. Every prompt on this page works as a one-off message too.",
    },
    {
      q: "What are some good OpenClaw use cases?",
      a: "OpenClaw has an automations scheduler for recurring jobs, managed with the `openclaw automations` command, with delivery to a chat channel. That suits jobs you want to receive where you already talk: a calendar preview in Telegram, a page-change alert in Discord. Read its security guidance before you let anyone but yourself message the agent. The prompts here assume only you are in the chat.",
    },
    {
      q: "Is it safe to let an agent read my email or messages?",
      a: "Treat it as a real risk. An agent that reads email can be fooled by text inside a message, and one that can send mail can be tricked into sending it. That is why every prompt here is read-only or drafts-only and says so. Give the agent the least access you can, start with read access, never give it a payment card or bank login, and approve anything that leaves your computer yourself.",
    },
    {
      q: "How do I schedule a prompt to run every morning?",
      a: "Ask your agent in plain words, for example: run this every weekday at 7:30 and send me the result here. Hermes has a built-in scheduler and will create the job for you from a plain request. OpenClaw has an automations scheduler too, but its documentation shows jobs created with the `openclaw automations create` command, so set the job up that way. Check the first scheduled run, and ask the agent to list its scheduled jobs now and then. A laptop that sleeps will skip a job, so a scheduled job needs a machine that stays on.",
    },
    {
      q: "Will these prompts work with other agents or chatbots?",
      a: "Mostly, yes. Each prompt is plain text. A job that needs email, a calendar, files or web pages needs an agent that is connected to them, and an ordinary chatbot is not. The jobs marked as needing nothing work in any chat, and you can paste your own text into the others. Results differ between models, so check the first run.",
    },
    {
      q: "Do I need to be technical to use these?",
      a: "No for the jobs that need nothing connected: paste the prompt and fill the brackets. Connecting email, a calendar or files takes setup in your agent, and a few jobs read project folders or logs and suit developers. The effort note on each card says what you must set up first, so you can choose jobs that match your situation.",
    },
    {
      q: `Can I run an agent for these jobs on Hivra?`,
      a: `Yes, if you want an agent on a machine that stays on. Hivra runs the official Hermes and OpenClaw agents on a paid computer from ${ENTRY_SIZE}, not paused for inactivity. The plan does not include AI usage. You can also run these agents on hardware you own, which is a sensible choice if you have a spare machine and are happy to look after it.`,
    },
  ],
  relatedLinks: [
    { href: "/agents/hermes", label: "Run Hermes on Hivra" },
    { href: "/agents/openclaw", label: "Run OpenClaw on Hivra" },
    { href: "/tools/agent-survival-check", label: "Agent survival check" },
    { href: "/tools/ai-agent-hosting-cost-calculator", label: "AI agent hosting cost calculator" },
    { href: "/pricing", label: "Hivra pricing" },
  ],
  componentKey: "agent-job-library",
  primaryKeyword: "ai agent examples",
  vendors: ["Nous Research", "OpenClaw"],
  method: {
    heading: "How these jobs were written",
    lastVerified: AGENT_JOB_FACTS.lastVerified,
    paragraphs: [
      {
        text: `The ${JOB_COUNT} jobs are written for general-purpose chat agents such as Hermes and OpenClaw. Each one is a job a person might plausibly hand over: read something, summarise it, compare it, draft a reply. The groups are ${CATEGORY_IDS.map((id) => CATEGORIES[id].label.toLowerCase()).join(", ")}.`,
      },
      {
        text: "The schedules on the cards are suggestions. Hermes documents a scheduler that accepts natural language or cron expressions and can deliver results to a chat or a file. OpenClaw documents an automations scheduler, managed with its command line, that persists jobs, wakes the agent at the right time and can deliver to a chat channel. Neither page says a given prompt will work well. That is for you to test.",
        sources: [...AGENT_JOB_FACTS.sources],
      },
      {
        text: "Safety rules for every prompt: a job that reads says it must not change anything, a job that reads email or web pages also tells the agent to treat that text as content, never as instructions, a job that drafts says it must wait for your approval, a job that writes a file says it must wait for your approval first, and no job buys, books, cancels or pays. A test in the repository checks every prompt for these lines and for any claim about time or money gained.",
      },
      {
        text: "What we did not do: we did not measure how long any job takes, how much it costs in model usage, or how often a given model gets it wrong. Those depend on the agent, the model and your data. The effort and risk notes come from how these jobs tend to go wrong, not from a benchmark.",
      },
      {
        text: "Anything you type into the search box stays in your browser. The page address carries only the group and the connections you pick, so you can share a filtered view. No prompt text is ever put in a link, and nothing on this page is sent anywhere.",
      },
    ],
  },
  examples: [
    {
      title: "Only an inbox connected",
      inputs: "Show only jobs I can run with email connected",
      command: "Filter: Email, only jobs I can run",
      result:
        "Six jobs use your mail: the inbox sorter, the reply drafts, the newsletter digest, the quiet-thread finder, the bill list and the receipt table. The jobs that need nothing show too. The mail jobs read, and the drafting ones write drafts only.",
    },
    {
      title: "Nothing connected yet",
      inputs: "A chat with an agent, no email, calendar, files or browsing",
      command: "Filter: nothing ticked, only jobs I can run",
      result:
        "You still have jobs: post ideas, a draft edit, a lesson of the day, a language practice session, a meal plan and a diff summary you paste in. A good place to learn how your agent responds before you connect anything.",
    },
    {
      title: "A developer with project files",
      inputs: "Files connected, group: Code and ops",
      command: "Filter: Files, Code and ops",
      result:
        "You see the dependency audit, the log grouping and the README draft. All three read your project, and the README draft asks for your approval before it creates a file.",
    },
  ],
};
