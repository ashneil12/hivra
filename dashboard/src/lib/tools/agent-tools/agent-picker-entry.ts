// Catalog entry for the Agent Picker (/tools/hermes-vs-openclaw). Type-only import from the catalog:
// the catalog imports the entries, so a value import here would be a cycle.

import type { ToolEntry } from "../tool-catalog";
import { formatPlanSize } from "@/lib/blog/plan-facts";
import {
  AGENT_PICKER_FACTS,
  AGENT_PROFILES,
  recommend,
  type PickerAnswers,
} from "./agent-picker";

const ENTRY_SIZE = formatPlanSize("entry");

function answers(a: PickerAnswers): PickerAnswers {
  return a;
}

/** What the picker prints for a set of answers: the ranking, best first, with each score. */
function rankingText(a: PickerAnswers): string {
  const result = recommend(a);
  if (!result) return "";
  return result.ranking.map((row, i) => `${i + 1}. ${AGENT_PROFILES[row.agent].name} (${row.score} of ${result.maxScore})`).join("\n");
}

export const EXAMPLE_ANSWERS = {
  chat: answers({ job: "assistant", where: "telegram", focus: "everyday", hands: "some", uptime: "always", sub: "neither" }),
  coder: answers({ job: "project", where: "terminal", focus: "code", hands: "minimal", uptime: "present", sub: "claude" }),
  scheduled: answers({ job: "schedule", where: "web", focus: "mixed", hands: "minimal", uptime: "away", sub: "both" }),
} as const;

export const AGENT_PICKER_ENTRY: ToolEntry = {
  slug: "hermes-vs-openclaw",
  name: "Agent Picker",
  h1: "Hermes or OpenClaw: which agent fits you?",
  subhead:
    "Answer six questions and get a ranked pick among Hermes, OpenClaw, Agent Zero, Claude Code, Codex and Aeon, with reasons and the honest tradeoff.",
  metaTitle: "Hermes vs OpenClaw: Which AI Agent Should You Run?",
  browserTitle: "Hermes vs OpenClaw: Which AI Agent Should You Run? | Hivra",
  metaDescription:
    "Hermes vs OpenClaw, plus Agent Zero, Claude Code, Codex and Aeon. Answer six questions for a ranked pick with reasons and tradeoffs.",
  intro: {
    lede: "Hermes and OpenClaw look alike from a distance. Both are open-source agents under the MIT licence, both live on a server, and both let you message them from chat apps with the model you choose. What differs is what each is built around.",
    body: [
      "Hermes is built around a learning loop. It keeps memory, writes reusable skills from what it has done, runs scheduled jobs and delivers the results to a chat. OpenClaw is built around its Gateway, one process that connects Discord, Telegram, WhatsApp, Slack, iMessage and more to an agent, with a browser Control UI, plugins and separate sessions per sender.",
      "The picker also scores Agent Zero, Claude Code, Codex and Aeon, because for some people the right answer is neither of the two you searched for. If you code all day and already pay for Claude, you should not be reading about chat gateways. Answer the six questions and it shows its working.",
    ],
    note: "The scores are our judgement of fit, written down in a table you can read below, not a benchmark. Everything you choose stays in your browser. Nothing is sent anywhere.",
  },
  faqs: [
    {
      q: "What is the difference between Hermes and OpenClaw?",
      a: "Hermes is built around a learning loop: agent-curated memory, skills it writes and improves from experience, search over past conversations, and a built-in cron scheduler. OpenClaw is built around a Gateway that connects 20 or more chat apps to an agent, with a Control UI in the browser, plugins and multi-agent routing. Both are MIT licensed and both let you pick the model. If your main need is an assistant that gets to know you and runs scheduled jobs, start with Hermes. If your main need is one agent reachable across many chat apps, possibly shared, start with OpenClaw.",
    },
    {
      q: "Which should I pick for Telegram or Discord?",
      a: "Either works on both. Hermes supports Telegram and Discord through its messaging gateway, including voice on both. OpenClaw lists Telegram and Discord among its core channels. The difference is the setup. OpenClaw pairs unknown senders by default and asks you to read its security guide before you open the Gateway to other people. Hermes puts its emphasis on memory, skills and scheduled delivery to the chat.",
    },
    {
      q: "Is OpenClaw free?",
      a: "The software is. OpenClaw is MIT licensed and its README says it has no paid tier, hosted service or token. You still pay for the model you connect, and for the machine it runs on if it is not your own. Hermes is also MIT licensed. Hivra has no free hosted plan, so a Hivra computer for either one costs " + ENTRY_SIZE + ". The plan does not include AI usage.",
    },
    {
      q: "What are the alternatives to OpenClaw?",
      a: "For the same job, a personal assistant you message, Hermes is the closest alternative. For handing over a goal and watching it work, Agent Zero gives the agent a Linux workspace with a terminal and a browser. For code, Claude Code and Codex are terminal coding agents, one from Anthropic and one from OpenAI. For scheduled work with no server of your own, Aeon runs on your GitHub Actions. The picker above ranks all of them against your answers.",
    },
    {
      q: "Is Hermes or OpenClaw better for coding?",
      a: "Neither is a coding tool first. Both can run commands and edit files, but for long work inside one repository Claude Code and Codex are built for exactly that and make better first choices. If you want a chat assistant that can also touch code now and then, Hermes or OpenClaw is fine. Answer 'Mostly code' in the picker and it will say so.",
    },
    {
      q: "Can I run Hermes or OpenClaw all day on my laptop?",
      a: "Only while the laptop is awake and online. A laptop that sleeps stops the agent. For around-the-clock use, run the agent on a machine that stays on: a home server, a VPS or a managed computer. On Hivra, a paid " + ENTRY_SIZE + " computer stays on and is not paused for inactivity. Self-hosting on hardware you already own is a sensible answer too, and the upstream install guides cover it.",
    },
    {
      q: "Is it safe to give an agent access to my chats?",
      a: "Treat it with care. OpenClaw's README tells you to treat inbound messages as untrusted input, pairs unknown senders by default, and notes that tools run on the host for the main session unless you configure sandboxing. Hermes documents command approval and container isolation in its security guide. Whichever you pick, start with only you in the chat, give it the fewest tools you need, and read the vendor's security page before adding other people.",
    },
    {
      q: "How are the answers scored?",
      a: "Each answer carries a fixed weight for each agent, from 0 to 3. The picker adds the weights and ranks the agents by total. If two agents tie, the one with more strong matches comes first, then the fixed order Hermes, OpenClaw, Agent Zero, Claude Code, Codex, Aeon, and the result says the two scored level. The weights are our judgement, built from each vendor's own description, and the same answers always give the same ranking.",
    },
  ],
  relatedLinks: [
    { href: "/agents/claude-code", label: "Run Claude Code on Hivra" },
    { href: "/agents/codex", label: "Run Codex on Hivra" },
    { href: "/pricing", label: "Hivra pricing" },
  ],
  componentKey: "agent-picker",
  primaryKeyword: "hermes vs openclaw",
  vendors: ["Nous Research", "OpenClaw", "Agent Zero", "Aeon", "Anthropic", "OpenAI"],
  method: {
    heading: "How the picker decides",
    lastVerified: AGENT_PICKER_FACTS.lastVerified,
    paragraphs: [
      {
        text: "The six questions are the ones that actually separate these agents: what kind of job, where you will talk to it, code or everyday work, how much setup you accept, whether it must be reachable around the clock, and which subscription you already pay for. Each answer adds a weight from 0 to 3 to each agent. A 3 means the vendor builds the agent for that, a 0 means it does not. The highest total wins.",
      },
      {
        text: "What each agent does comes from the vendor's own pages: the Hermes and OpenClaw repositories and docs, the Agent Zero and Aeon READMEs, Anthropic's Claude Code overview and OpenAI's Codex CLI page. The Hermes gateway page lists Telegram, Discord, Slack, WhatsApp, Signal and a browser among its surfaces, and its cron page covers scheduled jobs with delivery to a chat. The OpenClaw README and docs describe the Gateway, the channels, the Control UI and the sandboxing caveat.",
        sources: [...AGENT_PICKER_FACTS.sources],
      },
      {
        text: "The weights are a judgement, not a measurement. Nobody has benchmarked these agents against each other on your job, and a project that ships a feature this month can change an answer next month. Treat a narrow win as a coin toss: the result says when the top two scored the same, and shows both so you can read the tradeoffs and decide.",
      },
      {
        text: "Only agents Hivra offers today are scored, and only those with a public start link. That is a limit of what we host, not a verdict on others. The table decides the order, not which agent Hivra hosts. The button at the end starts whichever agent comes first, and an agent you can run yourself, on your own machine, is a fair choice for most of them.",
      },
      {
        text: "Your answers stay in your browser. The page address carries the answer choices only, so you can send a result to someone. It never carries anything you type, because nothing here takes typed text.",
      },
    ],
  },
  examples: [
    {
      title: "Message it on Telegram, all day",
      inputs: "An assistant, on Telegram, everyday tasks, some setup is fine, available at any hour, no subscription",
      command: rankingText(EXAMPLE_ANSWERS.chat),
      result:
        "Hermes and OpenClaw sit level at the top, so the picker says they tied and lets the tie-break order decide. Hermes comes first on that rule. The page shows both with their tradeoffs, and either is a good answer.",
    },
    {
      title: "A coder who already pays for Claude",
      inputs: "Work through a goal, in a terminal, mostly code, minimal setup, only while working, pays for Claude",
      command: rankingText(EXAMPLE_ANSWERS.coder),
      result:
        "Claude Code wins clearly: it is built for terminal coding and signs in with the subscription you already have. Codex is the runner-up, and the page says to pick it if you pay for ChatGPT instead.",
    },
    {
      title: "Scheduled reports with no server",
      inputs: "Jobs on a schedule, from a web page, a mix of work, minimal setup, finished while away, pays for both",
      command: rankingText(EXAMPLE_ANSWERS.scheduled),
      result:
        "Aeon leads because it runs on your GitHub Actions, so no machine of yours has to stay on. Agent Zero follows, with Hermes close behind for scheduled jobs delivered to a chat. Aeon is the youngest project here, and the page says so.",
    },
  ],
};
