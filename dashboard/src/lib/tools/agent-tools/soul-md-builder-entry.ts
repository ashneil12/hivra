// Catalog entry for the SOUL.md generator (/tools/soul-md-generator). Type-only import from the catalog:
// the catalog imports the entries, so a value import here would be a cycle.

import type { ToolEntry } from "../tool-catalog";
import { SOUL_FACTS, SOUL_SOURCE_LIST, buildSoulMd, presetForm } from "./soul-md-builder";

export const SOUL_MD_BUILDER_ENTRY: ToolEntry = {
  slug: "soul-md-generator",
  name: "SOUL.md Generator",
  h1: "SOUL.md generator for Hermes and OpenClaw agents",
  subhead:
    "Answer a few plain questions about who your agent works for, how it should sound, when to ask and what it must never do, and get a clean SOUL.md to copy or download.",
  metaTitle: "SOUL.md Generator for Hermes and OpenClaw Agents",
  browserTitle: "SOUL.md Generator for Hermes and OpenClaw Agents | Hivra",
  metaDescription:
    "Build a SOUL.md for a Hermes or OpenClaw agent: tone, boundaries, privacy and approvals. Live preview, copy or download, and nothing leaves your browser.",
  intro: {
    lede: "A SOUL.md is a short Markdown file that tells an AI agent who it is and how to behave. Both Hermes Agent and OpenClaw read it at the start of a session and put it near the top of the model's instructions. Write it well and the agent sounds like one person who knows your habits. Write it badly and you get filler.",
    body: [
      "This generator asks for the things a good SOUL.md covers: who the agent is and who it works for, its tone, when to act and when to ask, hard boundaries, how to treat private information, how to write, and what needs your approval first. You see the file build as you type. Copy it, or download it as SOUL.md. Four presets fill the form so you can start from something and change it.",
      "Hermes and OpenClaw use the file in slightly different ways, and the page shows both: where the file lives, what it is for and what belongs in other files instead, such as AGENTS.md and the memory files. All of it comes from the two projects' own docs, linked below.",
      "A SOUL.md is guidance to the model. It is not a lock. A line that says never delete files will not stop a delete if the agent has the tool and the model decides otherwise. Limits that matter belong in the agent's settings. The page spells out what a SOUL.md cannot do so you do not rely on it for that.",
    ],
    note: "What you type stays in your browser. Nothing is sent anywhere. The page address carries only the preset you picked, never your text.",
  },
  faqs: [
    {
      q: "What is a SOUL.md file?",
      a: "It is a plain Markdown file that sets an agent's identity: its voice, manner and defaults. In Hermes Agent it is the main identity of the agent, placed first in the system prompt in place of the built-in default. In OpenClaw it holds persona, tone and boundaries, and is loaded every session for the main agent by default, along with the other workspace files. In both, the file is read as instructions to the model, not run as code.",
    },
    {
      q: "Where does SOUL.md go in Hermes?",
      a: "In your Hermes home folder: ~/.hermes/SOUL.md, or $HERMES_HOME/SOUL.md if you set a custom home. Hermes does not look for it in the folder you run it from, so a copy in a project folder does nothing. Hermes creates a starter file on first run and never overwrites an existing one. It reads the file when a session starts, so edit it and then start a new session.",
    },
    {
      q: "Where does SOUL.md go in OpenClaw?",
      a: "In the agent's workspace, which by default is ~/.openclaw/workspace. The workspace location can be changed with a profile or with the OPENCLAW_WORKSPACE_DIR setting, so if you changed it, put the file there. OpenClaw loads SOUL.md every session for the main agent by default, with AGENTS.md, IDENTITY.md, USER.md and, when it exists, MEMORY.md. Sub-agent sessions get only AGENTS.md, so do not rely on SOUL.md reaching a sub-agent.",
    },
    {
      q: "What is the difference between SOUL.md and AGENTS.md?",
      a: "SOUL.md is who the agent is. AGENTS.md is how to work in a particular place. Hermes gives a rule of thumb: if it should follow the agent everywhere, put it in SOUL.md, and if it belongs to one project, put it in AGENTS.md. Commands, ports, folder paths and project conventions go in AGENTS.md. Voice, tone, manner and how the agent handles doubt go in SOUL.md. Facts about you, and what happened last week, go in the memory files.",
    },
    {
      q: "How long should a SOUL.md be?",
      a: "Short. The Hermes guide suggests starting with 4 to 8 lines for tone and defaults, and warns that an overly long file is truncated without giving a limit. OpenClaw truncates a workspace file over 20,000 characters by default, and 60,000 across all its files. OpenClaw's own advice is that short beats long and sharp beats vague. A page of specific rules usually does more than five pages of generic ones.",
    },
    {
      q: "Can a SOUL.md stop my agent from doing something dangerous?",
      a: "No. It guides the model, and a model can misread it, lose it in a long session or be steered by text it reads on a web page or in an email. OpenClaw's prompt injection page says to keep hard enforcement for tool policy, exec approvals, sandboxing and channel allowlists. Use the SOUL.md to state what you want, and use the agent's settings to make the dangerous things impossible or gated by approval.",
    },
    {
      q: "Is this a system prompt generator?",
      a: "It writes the part of a system prompt that is about character and behaviour, in the form Hermes and OpenClaw expect. Both agents add their own instructions around the file. Hermes puts its content first with no wrapper text, so what you write is what the model sees. The file is plain Markdown, so you can also paste it into any other tool that accepts a system prompt or persona.",
    },
    {
      q: "Does Hermes check my SOUL.md for prompt injection?",
      a: "Yes. Hermes scans SOUL.md for prompt-injection patterns before using it. A hit does not block the file: Hermes loads it, logs a warning and the /context command flags it for review. Keep the file about persona and voice, and avoid phrases that tell the model to ignore other instructions. The generator warns when your text contains wording like that.",
    },
  ],
  faqCode: ["~/.hermes/SOUL.md", "$HERMES_HOME/SOUL.md", "~/.openclaw/workspace", "OPENCLAW_WORKSPACE_DIR", "/context"],
  relatedLinks: [
    { href: "/agents/hermes", label: "Run Hermes on Hivra" },
    { href: "/agents/openclaw", label: "Run OpenClaw on Hivra" },
    { href: "/pricing", label: "Hivra pricing" },
    { href: "/agents/claude-code", label: "Claude Code on Hivra" },
  ],
  componentKey: "soul-md-builder",
  primaryKeyword: "hermes agent soul.md",
  vendors: ["Hermes Agent", "Nous Research", "OpenClaw"],
  method: {
    heading: "What the generator rests on",
    lastVerified: SOUL_FACTS.lastVerified,
    paragraphs: [
      {
        text: "What SOUL.md is for, where it lives and how it is loaded comes from the Hermes Agent docs: the personality page, the page on which file does what and the guide to using SOUL.md. The OpenClaw facts come from its SOUL.md page and template, the agent workspace page and the system prompt page.",
        sources: [...SOUL_SOURCE_LIST],
      },
      {
        text: "The output sections are our own layout, not a required format. Hermes says there are no required headings and suggests Identity, Style, Avoid and Defaults. OpenClaw's template uses Core Truths, Boundaries, Vibe and Continuity. The generator writes Identity, Style, a section on when to act and ask, Private information, Boundaries and Ask first, in the second person, because both projects write their examples that way. The wording behind each choice is ours.",
      },
      {
        text: "The generator is a plain function. The same answers always give the same file. A section with no answers is left out. Your text is cleaned before it goes in: line breaks are flattened, and characters that could start a heading, list, quote or code block are escaped, so one line cannot start a heading, list, quote, table or code block, or turn into a link. The text is not stored or sent anywhere.",
      },
      {
        text: "We did not test how any model follows the file, and the page does not say it will. Behaviour depends on the model, the rest of the agent's instructions and what the agent reads while it works.",
      },
    ],
  },
  examples: [
    {
      title: "Research assistant preset, unchanged",
      inputs: "The Research assistant preset with no edits",
      command: buildSoulMd(presetForm("research")),
      result:
        "A file of about 45 lines. It sets a careful voice, asks before spending money or sharing access, and tells the agent to treat text from web pages as information. It does not stop the agent from using a tool it has. For that, set tool limits in the agent.",
    },
    {
      title: "Inbox and calendar preset, unchanged",
      inputs: "The Inbox and calendar preset with no edits",
      command: buildSoulMd(presetForm("inbox")),
      result:
        "The Ask first list names sending, deleting and inviting. That is a request to the model. If a message must never go out without you, also set the agent to require approval for the send tool.",
    },
    {
      title: "Dev operator preset, unchanged",
      inputs: "The Dev operator preset with no edits",
      command: buildSoulMd(presetForm("dev")),
      result:
        "The Ask first list covers pushing, deploying and deleting. These are requests to the model, not locks. Keep deploy keys and force-push rights out of the agent's reach if you need a hard stop.",
    },
  ],
};
