// Agent Picker logic (/tools/hermes-vs-openclaw). Pure data and functions: no React, no browser APIs.
//
// Six answers are scored against a fixed weight table, one weight per agent for each possible
// answer. The agents come from the ones Hivra offers today (lib/hivra/agent-catalog.ts, available:true)
// that also have a public sign-up link (lib/hivra/agent-seo-catalog.ts). The scoring is plain
// addition, so the same answers always give the same ranking, and a tie is broken in a stated order.
//
// Every claim about what an agent does is in AGENT_PICKER_FACTS, read from the vendor's own pages on
// 2026-11-12. Weights are Hivra's judgement of fit, not a benchmark, and the page says so.

import { getAgent } from "@/lib/hivra/agent-catalog";
import { agentDeployHref, getAgentSeoEntry, type AgentSeoSlug } from "@/lib/hivra/agent-seo-catalog";

export const AGENT_PICKER_KEYS = ["hermes", "openclaw", "agent-zero", "claude-code", "codex", "aeon"] as const;
export type PickerAgent = (typeof AGENT_PICKER_KEYS)[number];

/** Which agent is listed first when everything else is level. Also the column order of the weight table. */
export const TIE_BREAK_ORDER: readonly PickerAgent[] = AGENT_PICKER_KEYS;

export const AGENT_PICKER_FACTS = {
  lastVerified: "2026-11-12",
  sources: [
    { label: "Hermes Agent on GitHub", url: "https://github.com/NousResearch/hermes-agent" },
    { label: "Hermes Agent docs", url: "https://hermes-agent.nousresearch.com/docs/" },
    { label: "Hermes messaging gateway", url: "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/" },
    { label: "Hermes scheduled tasks", url: "https://hermes-agent.nousresearch.com/docs/user-guide/features/cron" },
    { label: "OpenClaw on GitHub", url: "https://github.com/openclaw/openclaw" },
    { label: "OpenClaw docs", url: "https://docs.openclaw.ai/" },
    { label: "Agent Zero on GitHub", url: "https://github.com/agent0ai/agent-zero" },
    { label: "Aeon on GitHub", url: "https://github.com/aaronjmars/aeon" },
    { label: "Claude Code overview", url: "https://code.claude.com/docs/en/overview" },
    { label: "Codex CLI", url: "https://developers.openai.com/codex/cli" },
  ],
} as const;

interface AgentProfile {
  name: string;
  vendor: string;
  /** One line on what it is, from the vendor's own description. */
  summary: string;
  /** The honest cost of picking it. */
  tradeoff: string;
  /** Finishes "Pick {name} instead if ...". */
  betterWhen: string;
  /** The catalog slug that has the public sign-up link. */
  slug: AgentSeoSlug;
  /** What differs when it runs on a Hivra computer, only where it changes the picture. */
  hivraNote?: string;
}

export const AGENT_PROFILES: Record<PickerAgent, AgentProfile> = {
  hermes: {
    name: "Hermes",
    vendor: "Nous Research",
    summary:
      "An open-source agent with a learning loop: it keeps memory, writes reusable skills from experience, runs scheduled jobs and talks to you from Telegram, Discord, Slack, WhatsApp, Signal and more through one gateway.",
    tradeoff:
      "It is a general assistant, not a coding tool. For long work inside one code repository, Claude Code or Codex is the sharper tool. Its memory and user modelling also mean it keeps notes about you, so read what it stores.",
    betterWhen:
      "you want an assistant that builds up memory and skills over time, and scheduled jobs whose results arrive in a chat.",
    slug: "hermes",
  },
  openclaw: {
    name: "OpenClaw",
    vendor: "OpenClaw",
    summary:
      "An open-source assistant built around a Gateway: one process that connects chat apps such as Discord, Telegram, WhatsApp, Slack and iMessage to an agent, with a browser Control UI, plugins and per-sender sessions.",
    tradeoff:
      "Its own README says tools run on the host for the main session unless you configure sandboxing, and unknown senders must be paired. Read its security guide before you connect other people or expose the Gateway.",
    betterWhen:
      "you want one assistant reachable across many chat apps, possibly shared with other people, with plugins you can add.",
    slug: "openclaw",
  },
  "agent-zero": {
    name: "Agent Zero",
    vendor: "Agent Zero",
    summary:
      "An open-source agent with its own Linux workspace: a terminal, a browser and a desktop inside a sandbox, reached through a web interface where you can step in.",
    tradeoff:
      "Its README describes the web interface as the way in, not chat apps, so check its plugin hub if you need Telegram or Discord. It runs in Docker and needs a model account, a provider key or a local model.",
    betterWhen:
      "you want to hand over a goal and watch it work in a browser and terminal of its own, from a web page.",
    slug: "agent-zero",
  },
  "claude-code": {
    name: "Claude Code",
    vendor: "Anthropic",
    summary:
      "Anthropic's coding agent. It reads your codebase, edits files and runs commands, from a terminal, an IDE or the browser.",
    tradeoff:
      "It is built for code, not for being a general assistant across chat apps. Anthropic's docs say most surfaces need a Claude subscription or Console account, and its usage limits are Anthropic's to change.",
    betterWhen: "most of your work is in a code repository and you already pay for Claude.",
    slug: "claude-code",
  },
  codex: {
    name: "Codex",
    vendor: "OpenAI",
    summary:
      "OpenAI's coding agent. It inspects code, makes edits and runs commands from your terminal, and codex exec lets scripts and CI call it.",
    tradeoff:
      "It is a terminal coding tool, not a general assistant. You sign in with ChatGPT or another sign-in method OpenAI offers, so it suits you best if you already use ChatGPT.",
    betterWhen: "most of your work is in a code repository and you already pay for ChatGPT.",
    slug: "codex",
  },
  aeon: {
    name: "Aeon",
    vendor: "Aeon",
    summary:
      "An open-source agent framework that runs on your own GitHub Actions: you pick skills, connect a model, and it runs on a schedule without a server of yours.",
    tradeoff:
      "It needs a GitHub account and its runs use your GitHub Actions minutes (a private repo uses your own). It is a younger and much smaller project than the others here, created in 2026.",
    betterWhen: "you want scheduled research, reviews or reports run from a GitHub repo, with no machine of your own kept on.",
    slug: "aeon",
    hivraNote: "On Hivra the computer hosts Aeon's dashboard, and its tasks run on your own GitHub Actions.",
  },
};

// ---- Questions --------------------------------------------------------------------------------

export const QUESTION_KEYS = ["job", "where", "focus", "hands", "uptime", "sub"] as const;
export type QuestionKey = (typeof QUESTION_KEYS)[number];

/** Weights are listed in TIE_BREAK_ORDER: hermes, openclaw, agent-zero, claude-code, codex, aeon. */
type Weights = readonly [number, number, number, number, number, number];

interface AnswerDef {
  value: string;
  label: string;
  weights: Weights;
  /** Why this answer points at an agent. Only written where the weight is 2 or more. */
  why: Partial<Record<PickerAgent, string>>;
}

interface QuestionDef {
  key: QuestionKey;
  /** Radio group name and legend. */
  label: string;
  /** Short phrase used in the shared summary. */
  short: string;
  answers: readonly AnswerDef[];
}

export const QUESTIONS: readonly QuestionDef[] = [
  {
    key: "job",
    label: "What do you want it to do?",
    short: "Job",
    answers: [
      {
        value: "assistant",
        label: "Be an assistant: I message it and it answers or does small jobs",
        weights: [3, 3, 1, 0, 0, 0],
        why: {
          hermes: "You want an assistant you message. Hermes is built for that: memory across chats and skills it writes from what it has done.",
          openclaw: "You want an assistant you message. OpenClaw's Gateway exists to put an agent inside the chat apps you already use.",
        },
      },
      {
        value: "project",
        label: "Take a goal and work through it: research, browsing, files",
        weights: [1, 1, 3, 2, 2, 1],
        why: {
          "agent-zero": "You want to hand over a goal. Agent Zero works in a Linux workspace of its own with a terminal and a browser.",
          "claude-code": "You want a goal worked through. Claude Code reads, edits and runs commands across a whole project.",
          codex: "You want a goal worked through. Codex inspects files, makes edits and runs commands in a project.",
        },
      },
      {
        value: "schedule",
        label: "Run jobs on a schedule and report back",
        weights: [3, 2, 0, 0, 0, 3],
        why: {
          hermes: "You want scheduled work. Hermes has a built-in cron scheduler that can deliver results to a chat.",
          openclaw: "You want scheduled work. OpenClaw's docs list cron and webhooks among its automation tools.",
          aeon: "You want scheduled work. Aeon's whole design is skills that run on a schedule through your GitHub Actions.",
        },
      },
    ],
  },
  {
    key: "where",
    label: "Where will you talk to it?",
    short: "Where",
    answers: [
      {
        value: "telegram",
        label: "Telegram",
        weights: [3, 3, 0, 0, 0, 1],
        why: {
          hermes: "You will talk to it on Telegram. Hermes supports Telegram with voice, images, files and threads.",
          openclaw: "You will talk to it on Telegram. Telegram is one of OpenClaw's channels, served by the same Gateway as the rest.",
        },
      },
      {
        value: "discord",
        label: "Discord",
        weights: [3, 3, 0, 0, 0, 0],
        why: {
          hermes: "You will talk to it on Discord. Hermes supports Discord, including voice channels.",
          openclaw: "You will talk to it on Discord. Discord is one of OpenClaw's core channels.",
        },
      },
      {
        value: "web",
        label: "A web page in my browser",
        weights: [1, 2, 3, 1, 0, 2],
        why: {
          openclaw: "You want a web page. OpenClaw's Control UI gives you chat, configuration and sessions in the browser.",
          "agent-zero": "You want a web page. Agent Zero's whole interface is a web UI, with the browser and desktop shown beside the chat.",
          aeon: "You want a web page. Aeon runs a dashboard where you pick skills and press Run.",
        },
      },
      {
        value: "terminal",
        label: "A terminal",
        weights: [2, 1, 0, 3, 3, 0],
        why: {
          hermes: "You work in a terminal. Hermes has a full terminal interface with multiline editing and streaming tool output.",
          "claude-code": "You work in a terminal. The terminal CLI is Claude Code's full-featured surface.",
          codex: "You work in a terminal. Codex CLI is built around the terminal loop.",
        },
      },
    ],
  },
  {
    key: "focus",
    label: "Is the work mostly code, or everyday tasks?",
    short: "Work",
    answers: [
      {
        value: "code",
        label: "Mostly code",
        weights: [0, 0, 1, 3, 3, 1],
        why: {
          "claude-code": "Your work is mostly code. Claude Code is Anthropic's tool for exactly that.",
          codex: "Your work is mostly code. Codex is OpenAI's tool for exactly that.",
        },
      },
      {
        value: "mixed",
        label: "A mix of both",
        weights: [2, 2, 2, 1, 1, 1],
        why: {
          hermes: "Your work is a mix. Hermes is a general agent with 60 plus built-in tools, not a coding-only one.",
          openclaw: "Your work is a mix. OpenClaw is a general assistant with tools, skills and plugins.",
          "agent-zero": "Your work is a mix. Agent Zero's terminal, browser and documents cover both sides.",
        },
      },
      {
        value: "everyday",
        label: "Mostly everyday tasks",
        weights: [3, 3, 2, 0, 0, 1],
        why: {
          hermes: "Your work is everyday tasks. Hermes is a general assistant, not a coding copilot.",
          openclaw: "Your work is everyday tasks. OpenClaw is a general personal assistant first.",
          "agent-zero": "Your work is everyday tasks. Agent Zero's own examples are plans, documents, research and spreadsheets.",
        },
      },
    ],
  },
  {
    key: "hands",
    label: "How hands-on do you want to be?",
    short: "Hands-on",
    answers: [
      {
        value: "tinker",
        label: "Hands-on: I will configure channels, models and tools",
        weights: [2, 3, 1, 0, 0, 1],
        why: {
          hermes: "You like to configure. Hermes lets you choose provider and model, toggle tools and write your own skills.",
          openclaw: "You like to configure. OpenClaw has a wide surface: channels, plugins, per-sender routing and sandboxing.",
        },
      },
      {
        value: "some",
        label: "Some setup is fine",
        weights: [2, 2, 2, 2, 2, 2],
        why: {},
      },
      {
        value: "minimal",
        label: "Minimal: I want to sign in and start",
        weights: [1, 0, 2, 3, 3, 2],
        why: {
          "agent-zero": "You want little setup. Agent Zero's installer creates an instance with a persistent workspace, then you open its Web UI.",
          "claude-code": "You want little setup. You install it, sign in and run it in a project.",
          codex: "You want little setup. You install it, sign in with ChatGPT and run it in a project.",
          aeon: "You want little setup. Aeon Connect creates your repo, takes a model and lets you pick skills in the browser.",
        },
      },
    ],
  },
  {
    key: "uptime",
    label: "Does it need to be available around the clock?",
    short: "Uptime",
    answers: [
      {
        value: "always",
        label: "Yes, I want to message it at any hour",
        weights: [3, 3, 1, 0, 0, 1],
        why: {
          hermes: "You want it reachable at any hour. Hermes is designed to live on a server you talk to from chat.",
          openclaw: "You want it reachable at any hour. The OpenClaw Gateway is a daemon that stays up for your chat apps.",
        },
      },
      {
        value: "away",
        label: "It should finish long jobs while I am away",
        weights: [2, 2, 2, 1, 1, 3],
        why: {
          hermes: "You want jobs finished while you are away. Hermes runs scheduled jobs unattended.",
          openclaw: "You want jobs finished while you are away. OpenClaw's docs list cron and automation tools.",
          "agent-zero": "You want jobs finished while you are away. Agent Zero runs a goal to the end in its own workspace.",
          aeon: "You want jobs finished while you are away. Aeon runs on GitHub's machines, so none of yours has to stay on.",
        },
      },
      {
        value: "present",
        label: "No, only while I am working",
        weights: [0, 0, 0, 2, 2, 0],
        why: {
          "claude-code": "You only need it while you work. Claude Code is built to work beside you in a project.",
          codex: "You only need it while you work. Codex is built to work beside you in a project.",
        },
      },
    ],
  },
  {
    key: "sub",
    label: "Do you already pay for Claude or ChatGPT?",
    short: "Subscription",
    answers: [
      {
        value: "claude",
        label: "Claude",
        weights: [0, 0, 1, 3, 0, 2],
        why: {
          "claude-code": "You already pay for Claude. Claude Code signs in with a Claude subscription.",
          aeon: "You already pay for Claude. Aeon can take a Claude subscription token as its model.",
        },
      },
      {
        value: "chatgpt",
        label: "ChatGPT",
        weights: [0, 0, 1, 0, 3, 2],
        why: {
          codex: "You already pay for ChatGPT. Codex signs in with ChatGPT.",
          aeon: "You already pay for ChatGPT. Aeon can take a ChatGPT login as its model.",
        },
      },
      {
        value: "both",
        label: "Both",
        weights: [0, 0, 1, 2, 2, 2],
        why: {
          "claude-code": "You pay for both, so either coding agent is covered. Claude Code uses your Claude sign-in.",
          codex: "You pay for both, so either coding agent is covered. Codex uses your ChatGPT sign-in.",
          aeon: "You pay for both, and Aeon can use either as its model.",
        },
      },
      {
        value: "neither",
        label: "Neither",
        weights: [2, 2, 2, 1, 1, 1],
        why: {
          hermes: "You have no subscription to use. Hermes works with Nous Portal, OpenRouter, OpenAI or your own endpoint.",
          openclaw: "You have no subscription to use. OpenClaw works with hosted and local model providers.",
          "agent-zero": "You have no subscription to use. Agent Zero takes a cloud provider key or a local model.",
        },
      },
    ],
  },
];

// ---- Answers ----------------------------------------------------------------------------------

/** Each question's answer value, or "" when it has not been answered. */
export type PickerAnswers = Record<QuestionKey, string>;

export const EMPTY_ANSWERS: PickerAnswers = { job: "", where: "", focus: "", hands: "", uptime: "", sub: "" };

function questionFor(key: QuestionKey): QuestionDef {
  const question = QUESTIONS.find((q) => q.key === key);
  if (!question) throw new Error(`Unknown question ${key}`);
  return question;
}

export function isComplete(answers: PickerAnswers): boolean {
  return QUESTION_KEYS.every((key) => questionFor(key).answers.some((a) => a.value === answers[key]));
}

export function answeredCount(answers: PickerAnswers): number {
  return QUESTION_KEYS.filter((key) => questionFor(key).answers.some((a) => a.value === answers[key])).length;
}

/** Agents Hivra offers today that have a public start link. An agent that stops being available drops out. */
export function availableAgents(): PickerAgent[] {
  return AGENT_PICKER_KEYS.filter((key) => {
    const profile = AGENT_PROFILES[key];
    return getAgent(profile.slug)?.available === true && getAgentSeoEntry(profile.slug) !== undefined;
  });
}

// ---- Scoring ----------------------------------------------------------------------------------

export interface Reason {
  question: QuestionKey;
  text: string;
  weight: number;
}

export interface RankedAgent {
  agent: PickerAgent;
  score: number;
  /** Answers where this agent had a weight of 2 or more. */
  strongMatches: number;
}

export interface PickerResult {
  ranking: RankedAgent[];
  top: RankedAgent;
  runnerUp: RankedAgent | null;
  /** True when the top two scored the same and the order was decided by the tie-break rule. */
  tied: boolean;
  reasons: Reason[];
  /** The highest score an agent could reach on these answers, for "x of y". */
  maxScore: number;
}

function weightFor(answer: AnswerDef, agent: PickerAgent): number {
  return answer.weights[TIE_BREAK_ORDER.indexOf(agent)] ?? 0;
}

function selectedAnswer(answers: PickerAnswers, key: QuestionKey): AnswerDef | undefined {
  return questionFor(key).answers.find((a) => a.value === answers[key]);
}

/**
 * Rank the available agents for a set of answers. Highest score first. Ties go to the agent with more
 * strong matches (an answer weighted 2 or more), then to TIE_BREAK_ORDER. Unanswered questions add nothing.
 */
export function rankAgents(answers: PickerAnswers, agents: readonly PickerAgent[] = availableAgents()): RankedAgent[] {
  const ranked = agents.map((agent): RankedAgent => {
    let score = 0;
    let strongMatches = 0;
    for (const key of QUESTION_KEYS) {
      const answer = selectedAnswer(answers, key);
      if (!answer) continue;
      const weight = weightFor(answer, agent);
      score += weight;
      if (weight >= 2) strongMatches += 1;
    }
    return { agent, score, strongMatches };
  });
  return ranked.sort(
    (a, b) =>
      b.score - a.score || b.strongMatches - a.strongMatches || TIE_BREAK_ORDER.indexOf(a.agent) - TIE_BREAK_ORDER.indexOf(b.agent),
  );
}

/** The three reasons that moved an agent's score most, best first. Equal weights keep question order. */
export function reasonsFor(answers: PickerAnswers, agent: PickerAgent, limit = 3): Reason[] {
  const found: Reason[] = [];
  for (const key of QUESTION_KEYS) {
    const answer = selectedAnswer(answers, key);
    const text = answer?.why[agent];
    if (answer && text) found.push({ question: key, text, weight: weightFor(answer, agent) });
  }
  return found
    .map((reason, index) => ({ reason, index }))
    .sort((a, b) => b.reason.weight - a.reason.weight || a.index - b.index)
    .slice(0, limit)
    .map(({ reason }) => reason);
}

/** The recommendation for a full set of answers, or null while a question is still open. */
export function recommend(answers: PickerAnswers, agents: readonly PickerAgent[] = availableAgents()): PickerResult | null {
  if (!isComplete(answers) || agents.length === 0) return null;
  const ranking = rankAgents(answers, agents);
  const top = ranking[0];
  const runnerUp = ranking[1] ?? null;
  const maxScore = QUESTION_KEYS.reduce((sum, key) => sum + Math.max(...(selectedAnswer(answers, key)?.weights ?? [0])), 0);
  return {
    ranking,
    top,
    runnerUp,
    tied: runnerUp !== null && runnerUp.score === top.score,
    reasons: reasonsFor(answers, top.agent),
    maxScore,
  };
}

/** The sign-up link that opens Launch on this agent. */
export function startHrefFor(agent: PickerAgent): string {
  const entry = getAgentSeoEntry(AGENT_PROFILES[agent].slug);
  if (!entry) throw new Error(`No public page for ${agent}`);
  return agentDeployHref(entry);
}

// ---- Share links ------------------------------------------------------------------------------

/** The query keys this tool owns. Every other key (utm tags, a referral code) is left alone. */
export const AGENT_PICKER_PARAM_KEYS: readonly string[] = QUESTION_KEYS;

/** Read answers from a query string. Only allow-listed values count; anything else is unanswered. */
export function parseAgentPickerParams(search: string): PickerAnswers {
  const params = new URLSearchParams(search);
  const answers: PickerAnswers = { ...EMPTY_ANSWERS };
  for (const key of QUESTION_KEYS) {
    const value = params.get(key);
    if (value && questionFor(key).answers.some((a) => a.value === value)) answers[key] = value;
  }
  return answers;
}

/** The query string (no leading "?") for the answers: answered questions only, nothing free-form. */
export function serializeAgentPickerParams(answers: PickerAnswers): string {
  const params = new URLSearchParams();
  for (const key of QUESTION_KEYS) {
    if (questionFor(key).answers.some((a) => a.value === answers[key])) params.set(key, answers[key]);
  }
  return params.toString();
}

/** The plain-text summary of a result, for the copy button. No link: the button copies the page address. */
export function summaryText(answers: PickerAnswers, result: PickerResult): string {
  const lines = [`Agent Picker: ${AGENT_PROFILES[result.top.agent].name}`];
  if (result.runnerUp) lines.push(`Runner-up: ${AGENT_PROFILES[result.runnerUp.agent].name}`);
  for (const key of QUESTION_KEYS) {
    const answer = selectedAnswer(answers, key);
    if (answer) lines.push(`${questionFor(key).short}: ${answer.label}`);
  }
  return lines.join("\n");
}

export { questionFor, selectedAnswer };

/** The head-to-head rows shown under the picker. Every cell restates the vendor's own page (see AGENT_PICKER_FACTS). */
export const HERMES_VS_OPENCLAW_ROWS: readonly { label: string; hermes: string; openclaw: string }[] = [
  {
    label: "Built around",
    hermes: "A learning loop: memory, skills it writes and improves, search over past chats",
    openclaw: "A Gateway that links chat apps to an agent, with sessions, routing and plugins",
  },
  {
    label: "Chat apps",
    hermes: "Telegram, Discord, Slack, WhatsApp, Signal, Teams and more, from one gateway process",
    openclaw: "Discord, Telegram, WhatsApp, Slack, iMessage and 20 or more others, from one Gateway",
  },
  {
    label: "Browser and terminal",
    hermes: "A full terminal interface, and a chat you can open in the browser",
    openclaw: "A browser Control UI for chat, config and sessions, plus a CLI and TUI",
  },
  {
    label: "Scheduled work",
    hermes: "Built-in cron scheduler, results delivered to a chat or file",
    openclaw: "Cron and webhooks among its automation tools",
  },
  {
    label: "Models",
    hermes: "Nous Portal, OpenRouter, OpenAI or your own endpoint, switched with hermes model",
    openclaw: "Hosted and local providers, swappable plugins",
  },
  {
    label: "Licence and cost",
    hermes: "MIT. You pay for the model and the machine",
    openclaw: "MIT, no paid tier, hosted service or token. You pay for the model and the machine",
  },
  {
    label: "Safety note",
    hermes: "Documents command approval, authorization and container isolation",
    openclaw: "Treats inbound messages as untrusted, pairs unknown senders, tools run on the host unless sandboxed",
  },
];
