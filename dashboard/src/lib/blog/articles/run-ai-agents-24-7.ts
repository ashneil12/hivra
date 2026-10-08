import { BlogArticle } from "../types";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
import { CLI_RUN_LIFETIME, SERVER_SIDE_AGENTS_KEEP_WORKING } from "../runtime-facts";
export const article: BlogArticle = {
  slug: "run-ai-agents-24-7",
  title: "How to run AI agents 24/7: infrastructure, recovery, and real cost (2026)",
  metaTitle: "How to run AI agents 24/7: infrastructure and cost",
  metaDescription:
    "A 24/7 AI agent needs always-on compute, crash recovery, persistent memory and a channel to reach you. Doing it yourself on a server costs $5-15 a month.",
  publishedDate: "2026-07-15",
  lastModified: "2026-10-06",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "An agent that stops when you close your laptop is a chatbot with extra steps.",
  intro:
    "Running an agent 24/7 comes down to four decisions. Where the process lives, what restarts it when it crashes, what it remembers, and how it reaches you at 3am.",
  shortAnswer:
    "To run an AI agent 24/7, put it on an always-on machine (a VPS works) and restart it automatically after crashes. Keep its state on disk. Give it a channel like Telegram to reach you. A DIY server runs $5-15 a month, and you pay for model usage only while the agent works.",
  sections: [
    {
      heading: "What 24/7 actually requires",
      paragraphs: [
        "Most guides stop at \"put it on a server.\" That gets you an agent you can reach at any hour. Getting useful work out of it at any hour takes four things:\n\n- **Always-on compute.** A machine that stays awake. Your laptop is disqualified by design: lids close, batteries die, operating systems suspend everything on sleep. The process has to live somewhere that stays powered and connected.\n- **Crash recovery.** Agents crash. They hit out-of-memory limits, an API times out mid-call, a dependency update breaks them at 2am. Something has to notice the dead process and restart it without you.\n- **Persistent memory.** If the agent forgets everything on restart, recovery is pointless. State needs to live on disk (or in a database), outside the process, so a restarted agent picks up its task list, context and history where it left off.\n- **A proactive channel.** An agent working overnight is no use if the results sit in a terminal you aren't looking at. It needs a way to reach you: Telegram, Discord, email, a webhook. Without one, you built a very expensive cron job that talks to itself.",
        "Miss any one of them and you've got an agent that works while you happen to be watching. You can build every layer yourself, and the sections below show how, shortcuts included. For the wider question of where to host, start with [the AI agent hosting guide](/blog/ai-agent-hosting-guide).",
      ],
    },
    {
      heading: "The option matrix: laptop hacks vs VPS vs managed",
      paragraphs: [
        `An always-on agent can live in three places. Here's how they compare on those four requirements:\n\n| | Laptop + caffeinate | DIY VPS | Managed (Hivra) |\n|---|---|---|---|\n| Always-on compute | No. Sleep, reboots, and travel all kill it | Yes | Yes, on paid plans |\n| Crash recovery | Manual | You build it (systemd, healthchecks) | The agent's services are set up on the VM for you |\n| Persistent memory | Survives until you reinstall | You configure the volume | Persistent workspace per agent |\n| Proactive channel | You wire it | You wire it | Telegram for Claude Code (Telegram tab) and Hermes (channel grid) |\n| Cash cost | $0 | $5-15/mo | From ${ENTRY_PLAN_PRICE}/mo (${ENTRY_PLAN_SIZE}) |\n| Your time | Constant babysitting | 2-4 hours setup, ongoing patching | Pick an agent and sign in |\n\nOn the laptop route, \`caffeinate\` on macOS or disabled sleep on Windows keeps the machine awake, but the first reboot, network change or forced OS update ends the run. That's fine for one overnight task and not much more. If you try it, the [keep-awake command builder](/tools/keep-mac-awake) writes the exact command.`,
        "The DIY VPS route works, and the rest of this guide covers building it. The managed route runs the same agents on a private VM, with the memory and channel layers already wired and the machine run for you. Either is a sound choice. What differs is whose pager goes off when the process dies.\n\nUsing Cursor and wondering about a terminal agent instead? Read [Cursor vs Claude Code](/blog/cursor-vs-claude-code). [Cursor Cloud Agents](/blog/cursor-cloud-agents) covers what Cursor's own cloud option costs.",
      ],
    },
    {
      heading: "Scheduling: cron, heartbeats, and routines",
      paragraphs: [
        "A 24/7 agent that only reacts to messages is idle 95% of the time. Scheduling puts those idle hours to work, and there are three ways to do it, from simplest to most capable.\n\n**OS cron.** The blunt tool. It fires a headless agent run on a schedule:\n\n```bash\n# Run a headless task every morning at 7am\n0 7 * * * cd /opt/agent && ./run-task.sh \"summarize overnight alerts\" >> /var/log/agent-cron.log 2>&1\n```\n\nCron is reliable and boring. Its weakness is that every run starts cold, with no memory of the last one unless you pass state along yourself.\n\n**Heartbeats.** The agent wakes on a short interval (every 15 or 30 minutes), reads a checklist file, decides if anything needs doing, and goes back to sleep. That's how an agent checks your inbox, watches an RSS feed or monitors a deploy without anyone prompting it. The agent decides what to do when it wakes, with current context, instead of running a frozen command.",
        "**Agent-native routines.** Frameworks like Hermes ship a scheduler inside the agent itself, so recurring jobs live in the agent's own memory and survive restarts with their context intact. That closes the cold-start gap cron leaves open. [Hermes Agent scheduled tasks](/blog/hermes-agent-cron-scheduled-tasks) has the full setup.\n\nRule of thumb: cron for fixed jobs that never need context, heartbeats for watch-and-react work, native routines when the agent should own its own calendar.",
      ],
    },
    {
      heading: "Monitoring and auto-restart",
      paragraphs: [
        "On a DIY server, systemd is the standard answer for keeping the process alive:\n\n```bash\n# /etc/systemd/system/agent.service\n[Unit]\nDescription=AI agent\nAfter=network-online.target\n\n[Service]\nWorkingDirectory=/opt/agent\nExecStart=/usr/bin/node index.js\nRestart=always\nRestartSec=5\nMemoryMax=2G\n\n[Install]\nWantedBy=multi-user.target\n```\n\n`Restart=always` handles crashes. `MemoryMax` stops a leaking agent from taking the whole server down with it. Enable with `systemctl enable --now agent`.",
        "Restarting on a crash is only the start. The failures that actually kill long-running agents are quieter:\n\n- **Disk fills up.** Logs and browser caches grow forever. Rotate logs (`logrotate`) and cap cache directories, or the server dies in week three.\n- **The process is alive but stuck.** A hung API call or a deadlocked loop passes every process check. You need a liveness probe that tests real behavior: hit the agent's API and expect a response. A live PID alone doesn't tell you it's working.\n- **Silent auth expiry.** Tokens and sessions expire. The agent runs, every task fails, nothing restarts because nothing crashed. Alert on task failure rate, not just uptime.\n\nNot sure whether your current setup survives these? [The agent survival check](/tools/agent-survival-check) walks through the failure modes in about a minute and tells you which ones would take your agent down.",
      ],
    },
    {
      heading: "Running multiple agents on one server",
      paragraphs: [
        "Once one agent earns its keep, you'll want a second. A research agent, a coding agent, one per project. Cramming them onto one VPS is where DIY setups start to hurt:\n\n- **Resource contention.** One agent spins up a browser and eats 2 GB of RAM. The other agents start getting OOM-killed. Now you're writing cgroup limits.\n- **Dependency collisions.** Agent A needs Python 3.12, agent B's install script upgrades it to 3.13, agent A stops booting. Containers fix this, at the cost of you now maintaining Docker.\n- **Shared blast radius.** A bad update or a disk-full event takes out every agent at once, instead of one.\n\nThe clean pattern is isolation: one VM (or at minimum one container) per agent, each with its own filesystem, its own memory limit, and its own lifecycle.",
        `That isolation is the managed model. On [Hivra](/), each agent runs on its own private VM, so one agent's browser binge can't starve another. A plan is a compute pool you split across your agents: ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE}/month for ${LARGER_PLAN_SIZE}. The catalog covers six agents: Hermes, Claude Code, Codex, Aeon, OpenClaw, and Agent Zero. For the last two, [Agent Zero vs OpenClaw hosting](/blog/agent-zero-vs-openclaw-hosting) covers what each needs from its computer and which plan fits. Mixing them is normal. A common stack is Hermes as the always-on operator plus Claude Code for repo work.`,
      ],
    },
    {
      heading: "What 24/7 duty cycle actually costs",
      paragraphs: [
        `Split the cost into the two lines that behave differently:\n\n**Infrastructure is flat.** A server that runs 24/7 costs the same whether the agent does one task or a hundred. DIY: $5-10/month for a small VPS running a CLI agent, more like $10-15/month once you add a real browser, because Chrome wants 1-2 GB of RAM to itself. Managed: Hivra starts at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, and paid plans are not paused for inactivity.\n\n**Inference scales with activity, not uptime.** People get this part wrong. An idle agent sitting at a prompt burns zero tokens. You pay for model usage when the agent works, so \"running 24/7\" doesn't mean \"paying for inference 24/7.\" A heartbeat every 30 minutes with a short check is cheap. An agent grinding a codebase all night is not, and that cost is the same wherever it runs.`,
        "Two levers keep the inference line sane:\n\n- **Bring your own subscription.** Claude Code runs on your Anthropic login and Codex on your ChatGPT login, so heavy agent work rides a flat subscription you already pay for instead of metered API billing. Hivra does not mark up AI usage on your own subscription or API key.\n- **Tune the heartbeat.** A 15 minute heartbeat is 96 wakeups a day. If the job is \"check the inbox,\" 30 or 60 minutes usually loses nothing and halves or quarters the always-on token spend.\n\nFor your specific stack, [the hosting cost calculator](/tools/ai-agent-hosting-cost-calculator) prices the DIY and managed routes side by side with your numbers.",
      ],
    },
    {
      heading: "The managed path",
      paragraphs: [
        `You can build everything above by hand. If you'd rather spend the weekend on what the agent does instead of what keeps it alive, [Hivra](/) provisions the stack for you: a private VM per agent, a persistent workspace, the agent's services set up on its computer, and Telegram as the proactive channel for Claude Code and Hermes.\n\nClaude Code and Codex are the vendors' official CLIs, and Hermes runs from Hivra's maintained build of the open-source agent. Claude Code signs in with your own Anthropic account, Codex with your own ChatGPT account, and Hivra does not mark up that AI usage. Hivra is independent and is not affiliated with Anthropic or OpenAI. ${SERVER_SIDE_AGENTS_KEEP_WORKING} ${CLI_RUN_LIFETIME} [Plans start at ${ENTRY_PLAN_PRICE}/month](/pricing), paid plans are not paused for inactivity, and they come with a ${MONEY_BACK_GUARANTEE}, so you can test the loop end to end. If the DIY route sounds like a good weekend, take it. It works. The managed route is for when you'd rather skip the server work.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Can I run an AI agent 24/7 on my laptop?",
      a: "Not reliably. Tools like caffeinate keep the machine awake, but sleep, reboots, OS updates, and network changes all end the run. A laptop works for a single overnight task. For anything permanent, the process needs an always-on machine: a home server, a VPS, or a managed VM.",
    },
    {
      q: "How much does it cost to run an AI agent 24/7?",
      a: `Infrastructure: $5-10/month for a small DIY VPS, $10-15/month with a browser, or managed on Hivra from ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}. Inference is separate and scales with activity, not uptime: an idle agent burns zero tokens, and agents like Claude Code and Codex can run on your existing Anthropic or ChatGPT subscription.`,
    },
    {
      q: "Do AI agents use API tokens while sitting idle?",
      a: "No. An agent waiting for input consumes no model tokens. Costs accrue when it works: responding to messages, running scheduled heartbeats, executing tasks. That's why a 24/7 agent with a sensible heartbeat interval is much cheaper than the phrase \"running around the clock\" suggests.",
    },
    {
      q: "How do I automatically restart an AI agent when it crashes?",
      a: "On a Linux server, run it as a systemd service with Restart=always and a RestartSec delay, plus MemoryMax to contain leaks. Also cover the quiet failures: rotate logs so the disk never fills, probe real behavior rather than just the process ID, and alert on task failure rate to catch expired credentials.",
    },
    {
      q: "What is a heartbeat for an AI agent?",
      a: "A short scheduled wakeup, typically every 15 to 60 minutes, where the agent checks a list of standing responsibilities (inbox, feeds, monitors) and acts only if something needs doing. Unlike cron, the agent decides at wake time using current context instead of executing a fixed command.",
    },
    {
      q: "Can I run multiple AI agents on one VPS?",
      a: "You can, but expect resource contention, dependency collisions, and a shared blast radius when something fails. The cleaner pattern is one VM or container per agent. Managed platforms do this by default: on Hivra, each agent gets its own private VM, and the plan's compute pool is split across them.",
    },
  ],
  relatedArticles: [
    { slug: "ai-agent-hosting-guide", title: "AI agent hosting: the complete guide" },
    { slug: "keep-claude-code-running-24-7", title: "How to keep Claude Code running 24/7" },
    { slug: "run-codex-24-7-in-the-cloud", title: "Codex cloud, or Codex on a computer that stays on? Where to run it 24/7" },
    { slug: "hermes-agent-cron-scheduled-tasks", title: "Hermes Agent scheduled tasks" },
  ],
};
