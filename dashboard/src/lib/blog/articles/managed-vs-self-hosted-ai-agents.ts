import { BlogArticle } from "../types";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";
export const article: BlogArticle = {
  slug: "managed-vs-self-hosted-ai-agents",
  title: "Managed vs self-hosted AI agents: the honest total-cost math (2026)",
  metaTitle: "Managed vs self-hosted AI agents: total-cost math",
  metaDescription:
    "Self-hosting an AI agent costs $5-10/month in server rent plus 4-10 hours of setup and upkeep. The full total-cost math, and where self-hosting wins.",
  publishedDate: "2026-07-15",
  lastModified: "2026-09-24",
  readingTimeMin: 9,
  author: "Hivra team",
  tagline: "The server rent is the smallest number in this comparison.",
  intro:
    "The cash difference between self-hosting an AI agent and paying for managed hosting is a few dollars a month. The real difference is measured in hours: setup, updates, security, and who gets paged when the agent dies at 3am. Here is the honest math for both.",
  sections: [
    {
      heading: "What each model actually means",
      paragraphs: [
        "**Self-hosted** means you rent a VPS (or repurpose a home server), install the agent runtime yourself, wire up API keys or account logins, configure a reverse proxy if you want web access, and keep all of it patched and running. You have root. You own every decision and every failure.",
        "**Managed** means a platform provisions the machine, installs the agent, runs the server, and hands you a working interface. On [Hivra](/), that is a private virtual machine per agent, running the agent you picked, with chat, terminal, and file access in the browser. You still sign in with your own accounts (your Anthropic login for Claude Code, your ChatGPT login for Codex), and there is zero markup on AI usage. The platform owns the server. You own the agent's brain and its data inside the box.",
        "One thing to check on any managed platform: which build of the agent it runs, and with which settings, because you inherit the platform's choices for both. On Hivra, Claude Code and Codex are the vendors' official CLIs, which Hivra's chat runs with permission prompts bypassed by default inside the agent's own VM (the Permissions setting on the agent's Manage tab narrows that to Limited or Read-only). Hermes runs from Hivra's maintained build of the open-source agent, so Hermes updates arrive on Hivra's tested rollout rather than the day Nous Research ships them.",
      ],
    },
    {
      heading: "Setup time: the 4-10 hour tax nobody puts on the pricing page",
      paragraphs: [
        "A self-hosted agent setup, done properly, looks like this:\n\n- Pick and rent a VPS, generate SSH keys, harden the box (firewall, fail2ban, SSH keys only): 1-2 hours\n- Install the runtime (Node or Python, plus the agent itself) and fight version mismatches: 1-2 hours\n- Authenticate the agent on a headless machine, which usually means copying OAuth URLs and tokens between your laptop and the server: 30-60 minutes\n- Set up tmux or a systemd service so the agent survives disconnects and reboots: 30-60 minutes\n- Optional but common: reverse proxy, TLS certificate, and basic auth so you can reach the agent from a browser or phone: 1-3 hours",
        "That is 4 to 10 hours for a first-timer, and the wide range is honest. If every step goes clean, you land near 4. One bad Python version conflict or a botched proxy config and you are at 10. We wrote step-by-step guides for [self-hosting Hermes Agent](/blog/how-to-self-host-hermes-agent) and [self-hosting OpenClaw](/blog/how-to-self-host-openclaw), and neither is short.",
        "The managed equivalent: pick an agent, click deploy, wait for the VM to provision, then sign in to your AI account inside the box. That is the whole setup.",
      ],
    },
    {
      heading: "The TCO table, including the hours",
      paragraphs: [
        "Cash cost alone makes self-hosting look like the obvious winner. Add the hours and the picture changes. The table below prices time at $50/hour, which is low for anyone doing this professionally. Substitute your own rate.",
        `| Cost line | Self-hosted (1 agent) | Hivra managed |\n|---|---|---|\n| Server rent | $5-10/mo | Included |\n| Platform fee | $0 | ${ENTRY_PLAN_PRICE}/mo or ${LARGER_PLAN_PRICE}/mo |\n| AI usage | Your API keys or subscriptions | Same. BYO login, zero markup |\n| Setup, one time | 4-10 hours ($200-500 at $50/hr) | Pick an agent and sign in |\n| Server maintenance | 1-2 hours/mo ($50-100/mo at $50/hr) | Included |\n| When the server breaks | You, whenever it happens | Hivra runs the server |\n| First-year total | $60-120 cash + 16-34 hours | About $120-240 cash, no server hours |`,
        "Two honest caveats on that table. First, if your time is genuinely free and you enjoy the work, the hours column costs you nothing and self-hosting wins on cash. Hobbyists are not wrong to self-host. Second, the maintenance line is not padding. OS security updates, runtime updates, agent updates, disks filling with logs, and certificate renewals are all real and recurring. Skipping them does not make the cost zero. It converts the cost into risk.",
        "Want to run the numbers for your own setup? The [AI agent hosting cost calculator](/tools/ai-agent-hosting-cost-calculator) does this math interactively, and [the real cost of running a persistent AI agent](/blog/cost-of-running-ai-agent) breaks down where the money actually goes.",
      ],
    },
    {
      heading: "Data control and privacy: where self-hosting genuinely wins",
      paragraphs: [
        "This is the strongest real argument for self-hosting, so it deserves a straight treatment rather than a strawman.",
        "On a self-hosted box, you control the physical jurisdiction of the server, the disk encryption, the backup destinations, and exactly which processes run next to your agent. No platform operator can access the machine, because there is no platform operator. If you work under strict compliance rules, or your agent handles data that contractually cannot touch third-party infrastructure, self-hosting is not just cheaper in some spreadsheet. It is the only option that satisfies the requirement.",
        "Managed hosting narrows this gap but does not close it. On Hivra, each agent runs in its own private VM rather than a shared container, you sign in with your own Anthropic or ChatGPT account inside the box (the login is stored on that VM), and your usage bills through your own accounts. That is meaningfully better than platforms that proxy your traffic through their own keys. But the VM still lives on infrastructure someone else operates, and Hivra administrators keep infrastructure access to the hosts Hivra manages. If your threat model or your contracts cannot accept that, self-host and do not look back.",
        "For everyone else, the practical question is different: is your data safer on a professionally maintained VM, or on a box you hardened once in an evening and have not patched since? Unmaintained self-hosted servers are the most common way this argument flips in practice.",
      ],
    },
    {
      heading: "Failure modes: who gets paged at 3am",
      paragraphs: [
        "A persistent agent is a long-running process on a real machine, and real machines fail. The failure list for a self-hosted agent:\n\n- The VPS provider reboots the host for maintenance and your agent does not come back, because the systemd unit you meant to write is still a TODO\n- The disk fills with logs and every write starts failing\n- An OS update breaks the runtime version the agent depends on\n- The OAuth token expires and every scheduled task silently fails until you notice\n- A port you left open gets scanned and now you are reading auth logs at midnight",
        "None of these are exotic. Anyone who has run servers has hit most of them. The question is not whether they happen. It is who notices, and when. Self-hosted, the monitoring is whatever you built, and the on-call rotation is you. Managed, the platform runs the machine and the services the agent depends on. You still own what the agent does. You stop owning whether the machine underneath it is alive.",
        "There is a middle case worth naming: the agent itself misbehaving, like a task loop burning API credits. No hosting model saves you from that. Spending limits on your AI accounts do, which is a good habit under both models.",
      ],
    },
    {
      heading: "The crossover point: when self-hosting starts to make sense",
      paragraphs: [
        "The economics shift with scale and with how much sysadmin work you can amortize.",
        `**A few agents, and you want them working this week:** managed wins on total cost for almost everyone. Hivra's plans start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, and the ${LARGER_PLAN_PRICE}/month plan gives you ${LARGER_PLAN_SIZE} to split across your agents. Matching that with self-hosting means several small VPSes or one larger box you slice yourself, plus the maintenance for all of it. The cash difference is small. The hours difference is not.`,
        "**Many agents on one big machine, run by someone who does infrastructure anyway:** the math starts favoring self-hosting. If you already operate servers, adding an agent to an existing box has near-zero marginal maintenance cost, and one well-specced dedicated server can host a lot of agents for a flat monthly price. The 4-10 hour setup tax also amortizes: the second agent on your box takes far less time than the first.",
        "**Hard data-control requirements:** self-hosting wins regardless of the math, as covered above.",
        "**You want to learn how the stack works:** self-host at least once. It is the best way to understand what an agent actually needs to run, and the [full hosting guide](/blog/ai-agent-hosting-guide) covers both paths in depth.",
      ],
    },
    {
      heading: "Hybrid setups are normal, not a compromise",
      paragraphs: [
        "This is not a religious choice, and plenty of people run both. Common patterns:\n\n- **Managed for the always-on agents, self-hosted for experiments.** The agent that runs your daily automations lives on managed hosting where uptime is somebody's job. The half-built agent you are hacking on lives on a cheap VPS you can break freely.\n- **Self-hosted for the regulated workload, managed for everything else.** One agent touches data that cannot leave your infrastructure. It gets the self-hosted box and the maintenance budget. The other four do not need that treatment.\n- **Start managed, graduate to self-hosted.** Prove the agent is worth running at all on a platform where you skip the server work, then move it to your own hardware once it has earned a permanent home and you know its real resource needs.\n- **Start self-hosted, retire to managed.** The opposite migration is just as common: the box was fun to build and is no longer fun to maintain.",
        "Because the agents on Hivra are the same vendor CLIs and open-source projects you can install yourself, migration in either direction is mostly moving workspace files and re-authenticating. You are not locked into a proprietary runtime on either side.",
      ],
    },
    {
      heading: "Try the managed side",
      paragraphs: [
        `If the hours column in the TCO table is the one that hurts, the managed route is easy to evaluate: [Hivra](/) launches Hermes, Claude Code, Codex, or Aeon on a private VM. Sign in with your own AI accounts, pay zero markup on that usage, and see whether a box you do not have to administer fits how you work. [Plans start at ${ENTRY_PLAN_PRICE}/month](/pricing), paid plans are not paused for inactivity, they come with a ${MONEY_BACK_GUARANTEE}, and your workspace files come with you if you ever move to your own hardware.`,
      ],
    },
  ],
  faqs: [
    {
      q: "Is it cheaper to self-host an AI agent or use a managed platform?",
      a: `On cash alone, self-hosting a single agent costs $5-10/month for a small VPS, versus ${ENTRY_PLAN_PRICE}/month and up managed. But self-hosting also costs 4-10 hours of setup plus 1-2 hours a month of maintenance. Unless your time is free or you are amortizing an existing server, managed is usually cheaper in total cost for a handful of agents.`,
    },
    {
      q: "How long does it take to self-host an AI agent?",
      a: "Plan for 4-10 hours for a first setup: renting and hardening a VPS, installing the runtime, authenticating on a headless machine, setting up tmux or systemd for persistence, and optionally a reverse proxy with TLS for browser access. A managed launch skips all of that: you pick the agent and sign in.",
    },
    {
      q: "Is self-hosting an AI agent more private than managed hosting?",
      a: "It can be. Self-hosting gives you full control over jurisdiction, disk encryption, and who can access the machine, which matters under strict compliance rules. But an unpatched self-hosted box is often less secure in practice than a professionally maintained VM. On Hivra, agents run in private per-agent VMs and you sign in with your own AI accounts. Those logins are stored on the agent's VM, and Hivra administrators keep infrastructure access to the hosts Hivra manages.",
    },
    {
      q: "Do managed platforms mark up AI usage costs?",
      a: "Some do. Hivra does not mark up usage on your own logins or keys: you bring your own logins (your Anthropic account for Claude Code, your ChatGPT account for Codex) or your own API keys, and that usage bills through your own accounts.",
    },
    {
      q: "Can I move from managed hosting to self-hosting later?",
      a: "Yes, and it is a normal path. Because the agents on Hivra are the same vendor CLIs and open-source projects you can install yourself, migrating means copying your workspace files to your own server and re-authenticating. There is no proprietary runtime to escape from, and the reverse migration works the same way.",
    },
    {
      q: "When does self-hosting clearly beat managed hosting?",
      a: "Three cases: you have hard data-control or compliance requirements that forbid third-party infrastructure, you already run servers and can add agents at near-zero marginal maintenance cost, or you are running many agents on one large machine where a flat server price beats per-plan pricing.",
    },
  ],
  relatedArticles: [
    {
      slug: "what-is-an-ai-agent",
      title: "What is an AI agent? A clear, technical explanation for 2026",
    },
    {
      slug: "multi-agent-systems-explained",
      title: "Multi-agent AI systems in 2026: how they're built, what they cost, and when they're worth it",
    },
    {
      slug: "cost-of-running-ai-agent",
      title: "The real cost of running a persistent AI agent in 2026",
    },
    {
      slug: "how-to-self-host-hermes-agent",
      title: "How to self-host Hermes Agent on a VPS: complete setup guide (2026)",
    },
    {
      slug: "how-to-self-host-openclaw",
      title: "How to self-host OpenClaw: complete setup guide (2026)",
    },
    {
      slug: "keep-claude-code-running-24-7",
      title: "How to keep Claude Code running 24/7 (even when your laptop closes)",
    },
  ],
};
