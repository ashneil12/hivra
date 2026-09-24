import { BlogArticle } from "../types";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
export const article: BlogArticle = {
  slug: "is-it-safe-to-leave-an-ai-agent-running-unattended",
  title: "Is it safe to leave an AI agent running unattended? The four risks that matter",
  metaTitle: "Is It Safe to Leave an AI Agent Running Unattended?",
  metaDescription:
    "Mostly yes, if you control four things: what the agent can touch, what it can spend, where it runs, and what happens when it crashes. The risk rundown.",
  publishedDate: "2026-08-04",
  lastModified: "2026-09-24",
  readingTimeMin: 9,
  author: "Hivra team",
  tagline: "The scary failure is rare. The boring failure happens weekly.",
  intro:
    "Leaving an AI agent running while you sleep is safe for most workloads, but only if you have deliberately controlled four things: what the agent is allowed to touch, what it can spend, where it runs, and what happens when it dies. This article walks each risk honestly, with the mitigations that actually work.",
  sections: [
    {
      heading: "The short answer",
      paragraphs: [
        "Yes, with conditions. Thousands of people run persistent agents like Hermes, Claude Code, Codex, and OpenClaw around the clock, and the overwhelming majority of unattended incidents are boring: the process died and nobody noticed, or a task loop burned more API credit than expected. Catastrophic stories are rare, and nearly all of them trace back to an agent that was given broader permissions than its job required.",
        "The useful way to think about it is not \"is the AI trustworthy\" but \"what is the blast radius if this specific agent does the wrong thing tonight.\" Blast radius is something you control before you walk away. It comes down to four levers:\n\n- **Permissions:** what the agent can read, write, and execute\n- **Spend:** how much money it can consume through your AI accounts\n- **Isolation:** whether it runs next to your personal files or on its own machine\n- **Recovery:** what happens when the process crashes at 2am\n\nGet those four right and unattended operation is a routine engineering setup, not a leap of faith. Get them wrong and you are relying on luck. The rest of this article takes them one at a time.",
      ],
    },
    {
      heading: "Risk 1: the agent can touch more than its job requires",
      paragraphs: [
        "This is the risk behind most real horror stories. An agent asked to summarize emails does not need shell access. An agent that organizes your downloads folder does not need your SSH keys. But the path of least resistance during setup is to grant everything, click \"always allow,\" and move on. That is fine while you are watching. Unattended, it means any mistake the model makes executes with your full authority.",
        "The mitigations are unglamorous and effective:\n\n- **Scope permissions to the task.** Most agent runtimes have permission or tool profiles. Claude Code has an allowlist for commands and file paths. OpenClaw has `tools.profile`. Use the narrowest profile that lets the job succeed, and widen it only when a task actually fails for lack of access.\n- **Give the agent its own accounts where possible.** A dedicated email address, a bot token with limited scopes, an API key with restricted permissions. If the agent misuses a credential, you revoke one credential, not your identity.\n- **Do not let an unattended agent hold credentials it only needed once.** Setup often requires broad access. Running does not. Audit what is still in the environment before you leave it alone.",
        "Scoped permissions convert \"the model made a bad decision\" from an incident into a log line. That is the entire game.",
      ],
    },
    {
      heading: "Risk 2: runaway spend",
      paragraphs: [
        "The most common unattended failure that costs real money is a loop: the agent tries something, fails, retries with a slight variation, fails again, and repeats for six hours. Each attempt is an API call. None of this requires anything malicious. It is a stuck process with a credit card.",
        "Three controls handle it:\n\n- **Set hard spending limits on the AI account itself.** Anthropic, OpenAI, and every major provider let you cap monthly spend or set billing alerts. A hard cap turns the worst case from \"a surprising invoice\" into \"the agent stopped at your limit.\" This is the single highest-value five minutes in this article.\n- **Use subscription-based access where it fits.** Running Claude Code on a Claude subscription or Codex on a ChatGPT plan means a stuck loop hits a rate limit, not an open-ended meter.\n- **Give long-running tasks a budget in the prompt.** Telling the agent to stop and report after a set number of attempts is crude, but it works, because well-behaved agent runtimes respect it.",
        "Note that where the agent is hosted does not save you here. Whether the process runs on your laptop, your VPS, or a managed platform, the spend flows through your AI account, so the account-level cap is the control that matters. We break down the full cost picture in [the real cost of running a persistent AI agent](/blog/cost-of-running-ai-agent).",
      ],
    },
    {
      heading: "Risk 3: it runs next to things it should never see",
      paragraphs: [
        "An agent on your personal laptop shares a filesystem with your tax documents, your browser sessions, and every credential your other tools have cached. Even with scoped permissions, that is a dense environment for something autonomous to live in. And there is a second problem: agents that read the outside world (web pages, emails, messages from strangers) can be fed instructions by the content they read. Prompt injection is a real, unsolved class of attack, and the honest defense is not a clever prompt. It is making sure that even a successfully hijacked agent has nothing valuable within reach.",
        "Isolation is the fix, and it is binary in practice: either the agent has its own machine, or it does not. A cheap VPS, a spare box, or a managed VM all work. The isolated machine holds the agent, its workspace, and the scoped credentials it needs. Everything else you own lives somewhere the agent cannot reach by definition. On [Hivra](/), each agent gets a private virtual machine of its own, which gives you this boundary without building it: the agent can do real work inside its box, and the box is the boundary.",
        "If you must run unattended on a shared machine, at minimum run the agent as a separate OS user with its own home directory. It is weaker than a separate machine, but it beats sharing your login.",
      ],
    },
    {
      heading: "Risk 4: silent death, the opposite failure",
      paragraphs: [
        "Ask people what they fear about unattended agents and they describe the agent doing too much. Ask people who actually run them what goes wrong and they describe the agent doing nothing: the SSH session dropped, the laptop slept, the OAuth token expired, the disk filled with logs. The task you trusted to the agent quietly did not happen, and you found out days later.",
        "This failure mode is pure infrastructure, and it has standard fixes: run the agent under a process supervisor (systemd, Docker restart policies, or tmux at minimum), monitor that it is actually alive, and check in on its first few unattended nights before trusting it with anything important. We cover the mechanics in [why your AI agent dies when you close the terminal](/blog/ai-agent-dies-terminal-closes-fixes) and the full setup in [how to run AI agents 24/7](/blog/run-ai-agents-24-7).",
        "Silent death is a safety issue as well as a reliability problem. An agent that crashes mid-task can leave work half-done: a file half-written, a job half-migrated. Idempotent tasks, ones that can be safely re-run, are the mark of an agent workload that is genuinely ready to run unattended.",
      ],
    },
    {
      heading: "The pre-departure checklist",
      paragraphs: [
        "Before leaving any agent to run overnight for the first time, walk this list. It takes about fifteen minutes.\n\n1. **Permissions:** does the agent hold any access this task does not need? Remove it.\n2. **Spend cap:** is there a hard limit or a subscription boundary on the AI account it uses?\n3. **Isolation:** is it on its own machine or VM, away from your personal files and credentials?\n4. **Recovery:** if the process dies, does it restart? Would you find out?\n5. **Reversibility:** can everything it is about to do be undone? Deleting, sending, and publishing deserve a human in the loop until the agent has a track record.\n6. **Kill switch:** do you know, right now, how you would stop it from your phone?",
        "The reversibility point deserves one more sentence. A sensible progression is to let a new agent run read-only or draft-only tasks unattended first: research, summaries, monitoring, drafts for your review. Promote it to actions with consequences only after weeks of watching it behave. Trust is earned per agent and per task, not granted per product.",
      ],
    },
    {
      heading: "Does managed hosting change the safety picture?",
      paragraphs: [
        "Partly. Be precise about which risks a hosting platform can and cannot take off your plate.",
        "What it does handle: isolation, and the machine underneath the agent. On Hivra, every agent runs on a private VM per agent rather than your laptop or a shared container, so the boundary from risk 3 exists by default. Hivra runs that machine for you, paid plans are not paused for inactivity, and you get chat, terminal, and file access from a browser, which means the kill switch in your checklist is your phone. Know what runs inside that boundary, too. Hivra's chat runs the official [Claude Code](/agents/claude-code) and Codex CLIs with permission prompts bypassed by default, so the VM is the boundary rather than a per-command prompt; the Permissions setting on the agent's Manage tab narrows that to Limited or Read-only. [Hermes](/agents/hermes) runs from Hivra's maintained build of the open-source agent.",
        "What it cannot handle: permissions and spend stay yours under any hosting model. Hivra is built around bring-your-own login, so your Anthropic or ChatGPT account bills you directly with zero markup, and the spending caps you set with your provider are the caps that protect you. No host can decide which credentials your agent deserves. That judgment is the part of unattended safety that never gets outsourced.",
      ],
    },
    {
      heading: "Try it with the boundaries already built",
      paragraphs: [
        `If you want to run an agent unattended without assembling the isolation pieces yourself, [Hivra](/) launches Hermes, Claude Code, Codex, or Aeon on a private VM. [Plans start at ${ENTRY_PLAN_PRICE} a month](/pricing) for ${ENTRY_PLAN_SIZE}, paid plans are not paused for inactivity, and they come with a ${MONEY_BACK_GUARANTEE}. You bring your own AI login, keep your own spending limits, and can check on the agent or stop it from any browser. The permission decisions stay yours, including the Manage tab setting that decides how much a Claude Code or Codex agent may do on its box.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Is it safe to leave an AI agent running overnight?",
      a: "For most workloads, yes, provided four things are controlled: the agent's permissions are scoped to its task, the AI account it uses has a hard spending cap, it runs on an isolated machine or VM rather than your personal laptop, and a process supervisor restarts it if it crashes. Most unattended incidents are a dead process or a costly retry loop, not a rogue agent.",
    },
    {
      q: "What is the biggest risk of running an AI agent unattended?",
      a: "In practice, over-permissioning. Most real incidents trace back to an agent holding broader file, shell, or credential access than its job required, so a bad model decision executed with full authority. Scoping permissions to the task converts most mistakes into harmless log lines.",
    },
    {
      q: "Can an unattended AI agent run up a huge API bill?",
      a: "It can if nothing caps it. A stuck retry loop is the classic cause. The fix is a hard spending limit on the AI provider account itself, or subscription-based access where a loop hits a rate limit instead of a meter. Hosting choice does not affect this: usage always bills through your account, so the account-level cap is the real control.",
    },
    {
      q: "What about prompt injection? Can content the agent reads hijack it?",
      a: "Prompt injection is a real and unsolved class of attack for any agent that reads untrusted content like web pages or inbound messages. The honest defense is limiting blast radius: scoped credentials, an isolated machine, and human review for irreversible actions, so even a successfully manipulated agent has little of value within reach.",
    },
    {
      q: "Which tasks should an AI agent not do unattended?",
      a: "Anything irreversible without a track record: deleting data, sending messages to other people, spending money, or publishing publicly. Start a new agent on read-only and draft-only work such as research, monitoring, and summaries, then promote it to consequential actions after it has behaved well for weeks.",
    },
    {
      q: "Does using a managed platform make unattended agents safe?",
      a: "It helps with two of the four risks. A platform like Hivra provides isolation (a private VM per agent) and runs the machine underneath the agent for you, with paid plans that are not paused for inactivity, plus browser access that works as a kill switch from your phone. Permission scoping and spending limits remain your job under every hosting model. On Hivra, Claude Code and Codex run with permission prompts bypassed by default until you pick Limited or Read-only on the agent's Manage tab, and usage runs through your own AI accounts.",
    },
  ],
  relatedArticles: [
    {
      slug: "run-ai-agents-24-7",
      title: "How to run AI agents 24/7: infrastructure, recovery, and real cost (2026)",
    },
    {
      slug: "ai-agent-dies-terminal-closes-fixes",
      title: "Why your AI agent dies when you close the terminal (and every fix that works)",
    },
    {
      slug: "cost-of-running-ai-agent",
      title: "The real cost of running a persistent AI agent in 2026",
    },
    {
      slug: "managed-vs-self-hosted-ai-agents",
      title: "Managed vs self-hosted AI agents: the honest total-cost math (2026)",
    },
    {
      slug: "keep-claude-code-running-24-7",
      title: "How to keep Claude Code running 24/7 (even when your laptop closes)",
    },
  ],
};
