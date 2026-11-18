import type { ComparePage } from "./types";
import { HOSTED_COMPUTE_NEEDS_PLAN_SHORT } from "@/lib/blog/plan-facts";
import { formatCheckedMonth, COMPETITOR_FACTS_CHECKED } from "./competitor-facts";
import { formatPlanSize, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { CLI_RUN_LIFETIME, SERVER_SIDE_AGENTS_KEEP_WORKING } from "@/lib/blog/runtime-facts";
import { HIVRA_AGENTS_CELL } from "./shared-copy";
import {
  AI_ACCESS_CELL,
  CLOSING,
  DECISION_SECTION,
  ENTRY_PRICE_PROSE,
  HOSTING_COST_CALCULATOR_HREF,
  REFUND_LINKED,
  PRICES_AS_OF_STAMP,
  STAYS_ON,
  AI_USAGE,
  cautionSection,
  paragraphs,
  priceSources,
  relatedLinks,
} from "./shared-copy";

/**
 * The five comparison pages that are not about one named competitor: self-hosting,
 * Railway, Render, moving from OpenClaw to Hermes, and the broader hosting options.
 * They used to sit inside app/compare/[slug]/page.tsx.
 *
 * The wording is the October 2026 copy (scratchpad batches/b04, files 02, 03, 07, 08
 * and 09). The corrections the claim audit of 2026-10-20 required are in place:
 * Hermes ships its own dashboard and cron, Railway shows metrics and logs and has
 * community Hermes templates, Fly describes Sprites as persistent computers, and
 * Hermes' own `hermes claw migrate` command imports a good deal of an OpenClaw setup.
 * Hivra still has no import tool of its own, and nothing here says otherwise.
 *
 * Competitor figures on these pages were read from the vendors' own pages: Hetzner,
 * DigitalOcean and Railway on 2026-09-24, Render on 2026-10-09, and all of them again
 * for the audit of 2026-10-20 (they matched, except where the copy now says otherwise).
 * The vs-self-hosted page's Hetzner and DigitalOcean figures were re-read on 2026-11-17.
 * Update the figures and the claims tests together when a vendor changes a price.
 */

// Hermes' own OpenClaw migration guide (`hermes claw migrate`); Hivra has no
// OpenClaw import of its own.
export const HERMES_OPENCLAW_MIGRATION_GUIDE = "https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw";

export const GENERAL_COMPARISONS: Record<string, ComparePage> = {
  "vs-self-hosted": {
    slug: "vs-self-hosted",
    browserTitle: "Self-hosting Hermes or using Hivra: control has a cost | Hivra",
    h1: "Self-hosting Hermes or using Hivra: control has a cost",
    metaDescription: `Hetzner can cost less if in stock; Hivra is ${ENTRY_PRICE_PROSE} and does upkeep. Where self-hosting wins. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "A self-hosted Linux server is often the cheapest way to run an AI agent in direct infrastructure spend. It is also the way to get the most control. You decide what to install, how traffic is routed, where data sits and when software is upgraded. For some people, that is exactly the appeal.",
          "The other side of that control is that the server is yours to look after. Hivra is the opposite trade: you give up root access and a free choice of location, and in return a computer for your agent exists, stays on and is maintained by someone else. Neither is the right answer for everyone, and the honest comparison is about who does the upkeep, not only who has the lower number.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          `Hetzner's cost-optimized page lists the CX23, with 2 vCPU, 4 GB of RAM and 40 GB of NVMe, from €5.99 per month before VAT, and its footnote says the price includes IPv4. As of ${formatCheckedMonth()} the same page marks that row as currently unavailable, and Hetzner says the number of available servers in this range is limited. Its regular performance range has a 2 vCPU, 4 GB server (CPX22, 80 GB of NVMe) from €16.99 per month before VAT in Helsinki and €19.99 in Nuremberg, also shown as unavailable when we looked. Hetzner raised prices for new orders and rescales across its cloud plans on 15 June 2026, and existing servers keep their terms.`,
          `Hivra's managed computer starts at ${ENTRY_PRICE_PROSE}. On the server bill alone, a cost-optimized Hetzner server is cheaper when you can order one. The regular performance server of the same size lists higher than Hivra's entry price, and Hivra's price is not a like-for-like server price: it includes the agent being installed and kept running for you. Hetzner prices are in euros before VAT and Hivra's are in dollars, so convert at today's rate and add VAT before comparing.`,
          "DigitalOcean lists a 2 vCPU, 4 GiB Basic Droplet with 80 GiB of SSD at $24 a month, billed per second (with a 60 second minimum) up to that monthly price. It also offers an OpenClaw 1-Click Droplet: the docs list the Droplet price and no separate app fee. They quote about $12 a month for the smallest Droplet but size a personal setup at 4 GB and 2 CPU, which is $24 a month on the Droplet pricing page. DigitalOcean's pricing for its Harness Runtime, which runs agents such as Claude Code, Codex CLI and Hermes Agent in managed sandboxes, is a different model again: CPU at $0.044 per vCPU-hour of CPU actually used, with the charge falling to zero while an agent waits, plus separate memory and storage charges. Its agent plans and persistent workspaces are in public preview.",
          `None of these prices include AI usage. ${AI_USAGE}`,
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          "The difference is the work you take on. You need safe SSH access, firewalls, TLS, agent installation, secret handling, backups, updates and monitoring. None of that is impossible, but problems tend to appear when you are busy doing something else. If you already automate server maintenance, Hivra may offer less advantage.",
          `On Hivra the computer is created from the dashboard and you open it from there. ${STAYS_ON} Hermes on a Hivra computer is the official Hermes Agent, unmodified, with its own web UI behind your Hivra sign-in, and you update it with \`hermes update\` or the Update Hermes button. Hivra is open source and links its [repository](https://github.com/ashneil12/hivra); self-hosting the whole platform is a preview, not a finished path.`,
          "Hivra is not affiliated with or endorsed by Hetzner, DigitalOcean or Nous Research. It runs agents that other people make, and those makers are not involved in how Hivra sells them.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Self-hosting also wins when you need root privileges, specialised dependencies, strict data locality, or the freedom to run unrelated services. Hivra is not a replacement for full ownership of a machine. It is an option for people who would rather spend less time administering one.",
          "It also wins on price when you can get a cost-optimized server, when you already have Terraform or Ansible habits and a machine to spare, and when you want Hermes next to a database, a reverse proxy or other services on the same box. Hetzner offers a REST API and CLI, private networks and firewalls, and DigitalOcean's 1-Click OpenClaw comes with a gateway token, firewall rate limiting and a Docker sandbox. If you are comfortable with SSH, those are real advantages, and Hivra's way in is the dashboard and its Terminal tab.",
        ),
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and a self-hosted VPS compared",
            rows: [
              { criterion: "Price model", hivra: "Fixed monthly price per computer, from $9.99/mo for 2 vCPU and 4 GB (managed), in dollars", alternative: "Hetzner: a monthly price with an hourly rate, so deleting before month end bills only the hourly rate. DigitalOcean: per second up to a monthly price, with a 60 second minimum. Hetzner prices are in euros before VAT and Hivra's are in dollars, so convert and add VAT before comparing" },
              { criterion: "Entry server price", hivra: "$9.99/mo for 2 vCPU and 4 GB", alternative: "Hetzner CX23 (2 vCPU, 4 GB, 40 GB) from €5.99/mo before VAT, shown unavailable when we looked; CPX22 (2 vCPU, 4 GB, 80 GB) from €16.99/mo before VAT (Helsinki; €19.99 Nuremberg). DigitalOcean 2 vCPU, 4 GiB: $24/mo" },
              { criterion: "What you get", hivra: "A computer with the agent installed, opened from the dashboard", alternative: "An unmanaged Linux server. Hetzner's cloud server pages describe a general-purpose Linux server, not an agent product. DigitalOcean also sells an OpenClaw 1-Click Droplet" },
              { criterion: "What stays on", hivra: STAYS_ON, alternative: "The server runs until you delete it. On Hetzner a server that is off is still billed until deleted" },
              { criterion: "Persistence", hivra: "Files, sessions and login stay on the computer while it exists", alternative: "Disk persists until you delete the server. Hetzner's saved server images persist until deleted" },
              { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "Anything that runs on Linux, installed by you" },
              { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Your own keys or accounts; no AI usage in the server price" },
              { criterion: "Access method", hivra: "Dashboard and its Terminal tab", alternative: "SSH, plus Hetzner's REST API and CLI" },
              { criterion: "Agent dashboard", hivra: "Built-in, on a computer that stays on and is not paused for inactivity", alternative: "Hermes ships its own dashboard; you set up its login and access yourself" },
              { criterion: "Setup effort", hivra: "No server setup: launch from the dashboard", alternative: "You set up the server yourself, so it depends on your experience" },
              { criterion: "Who maintains it", hivra: "Hivra keeps the computer running; Hermes updates are yours to start from the dashboard", alternative: "You: OS updates, firewall, TLS, monitoring and restarts" },
              { criterion: "Data and security", hivra: "Ask us which region before you buy; no external audit is claimed", alternative: "You choose the location. Hetzner lists Germany, Finland, Ashburn, Hillsboro and Singapore and calls its cloud GDPR-compliant" },
              { criterion: "Limits", hivra: "Compute is shared by the agent computers on one account", alternative: "Hetzner applies a default per-customer resource limit, raised by support ticket, and says cost-optimized supply is limited" },
              { criterion: "Exit and portability", hivra: "Download memory files; JSON export on Claude Code and Codex agents. The platform is open source", alternative: "Hermes can export sessions from its dashboard; otherwise copy its data folder. It is your server" },
              { criterion: "Best for", hivra: "People who want an agent computer without running a server", alternative: "People who need root, a chosen location or other services on the same machine" },
            ],
          },
        ],
      },
      {
        heading: "Who should pick which",
        blocks: [
          {
            kind: "entries",
            items: [
              { lead: "Priya, a backend developer who already uses Terraform and Ansible:", text: "She wants Hermes next to a Postgres database and a webhook service on one machine. Pick a self-hosted server. She has the habits to keep it patched, and a Hivra computer would not give her the root access her other services need." },
              { lead: "Tom, a solo founder who wants an agent with its own computer:", text: "He wants to open it, not build it, and has no wish to learn firewalls. Pick Hivra. The monthly price is higher than a cost-optimized server, but he is not the one doing the upkeep." },
              { lead: "Lena, a consultant whose client data must stay in Germany or Finland:", text: "Pick a self-hosted server in a location she chooses. Hetzner lists Germany and Finland, and Germany costs €19.99 a month for the regular performance 2 vCPU, 4 GB size. She should ask Hivra which region a computer would run in and check it against her contract before using it for that client's data." },
              { lead: "Sam, who runs long Claude Code jobs and checks them from a phone:", text: "Pick Hivra. The computer stays on, and a run started inside tmux in its Terminal tab keeps going after he closes the laptop. He can do the same on a server, but he would build and maintain the setup himself." },
              { lead: "Aisha, a developer already paying for a DigitalOcean account who wants OpenClaw:", text: "Pick the DigitalOcean 1-Click OpenClaw Droplet if she is happy with SSH setup and a 4 GB, 2 CPU Droplet at $24 a month. Pick Hivra if she would rather not manage the Droplet. Both run the OpenClaw project; Hivra is not affiliated with it." },
              { lead: "Marcus, who already has a spare Hetzner server and is curious about Hivra:", text: "Use both. Keep the server for what it does well and start a Hivra computer for the agent, and check the refund terms before paying. Then keep whichever one he actually opens." },
              { lead: "Jordan, who wants the lowest possible monthly bill for a small agent:", text: "Pick a cost-optimized server if one is in stock, and budget for the time you spend on it. If none can be ordered, the regular performance 2 vCPU, 4 GB server costs more than Hivra's entry size on the bill, so pick Hivra unless you need root or a chosen location." },
            ],
          },
        ],
      },
      {
        heading: "How to try both",
        blocks: [
          {
            kind: "steps",
            items: [
              { lead: "Choose one small job.", text: "An ordinary task, a scheduled task and a task that writes a file. Use the same job on both so the comparison is fair." },
              { lead: "Start the server.", text: "On Hetzner, deleting a server before month end bills only the hourly rate, but a server that is switched off still bills until you delete it. Set up SSH, a firewall, TLS and the agent, and write down the steps." },
              { lead: "Start a Hivra computer.", text: `A paid Hivra Cloud computer is ${ENTRY_PRICE_PROSE}, with a ${REFUND_LINKED}. Every Hivra Cloud computer needs a paid plan; a free account works with a server you connect yourself.` },
              { lead: "Restart both and check.", text: "Confirm that files, credentials, sessions and task history survived a restart, and that scheduled tasks still run." },
              { lead: "Add up a full month.", text: `Include the server or plan, any extras such as Hetzner backups or saved server images, extra traffic, the time you spent, and AI usage. The [hosting cost calculator](${HOSTING_COST_CALCULATOR_HREF}) takes your own hours and rate.` },
              { lead: "Keep one and remove the other.", text: "Export what you need first: Hermes can export sessions from its dashboard, and on Hivra you can download memory files." },
            ],
          },
        ],
      },
      {
        heading: "What survives, and for how long",
        blocks: paragraphs(
          `On a self-hosted server, files live on its disk until you delete the server. Hetzner's saved server images persist until deleted. Hetzner also lists a backup feature with seven slots, and those are deleted with the server. Nothing on either vendor's pages covers an agent's memory or sessions: those live in whatever folder the agent uses, so copying that folder is your own job.`,
          `${CLI_RUN_LIFETIME} Hivra does not promise backups, so keep your own copy of anything you cannot lose. Memory stays on the agent's computer for as long as the agent exists.`,
        ),
      },
      cautionSection(),
    ],
    sources: {
      intro: `Hetzner and DigitalOcean figures come from their own pages and the Hermes dashboard from the Hermes documentation, as of ${formatCheckedMonth()}. Vendors change prices, so check the source before you pay.`,
      notes: [
        "Hetzner prices are shown in euros before VAT. The CX23 and CPX22 rows were marked currently unavailable on the pages we read, and Hetzner says supply in its cost-optimized range is limited.",
        "DigitalOcean's OpenClaw docs quote about $12 a month for the smallest Droplet but size a personal setup at 4 GB and 2 CPU, which is $24 a month on the Droplet pricing page. DigitalOcean's Harness Runtime agent plans and persistent workspaces are in public preview.",
        "We did not read refund or cancellation terms for Hetzner or DigitalOcean, so this page does not compare them. Check each provider's terms before paying.",
      ],
      links: [
        { label: "Hetzner Cost-Optimized cloud", href: "https://www.hetzner.com/cloud/cost-optimized/" },
        { label: "Hetzner Regular Performance cloud", href: "https://www.hetzner.com/cloud/regular-performance/" },
        { label: "Hetzner price adjustment, 15 June 2026", href: "https://www.hetzner.com/pressroom/standardization-and-price-adjustment-of-our-server-products/" },
        { label: "DigitalOcean Droplet pricing", href: "https://www.digitalocean.com/pricing/droplets" },
        { label: "DigitalOcean OpenClaw 1-Click docs", href: "https://docs.digitalocean.com/products/marketplace/catalog/openclaw/" },
        { label: "DigitalOcean Harness Runtime pricing", href: "https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/details/pricing/" },
        { label: "DigitalOcean Harness Runtime docs", href: "https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/" },
        { label: "Hermes web dashboard (Nous Research)", href: "https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard" },
      ],
    },
    faqs: [
      {
        q: "Is a VPS cheaper than Hivra?",
        a: `Often in direct server cost. Hetzner lists a 2 vCPU, 4 GB cost-optimized server from 5.99 euros a month before VAT, though it showed as unavailable when we looked, while Hivra is ${ENTRY_PRICE_PROSE}. A regular performance server of that size lists higher. Hetzner prices are in euros before VAT and Hivra's are in dollars, so convert and add VAT before comparing. The comparison changes when you include the time and responsibility of maintaining it.`,
      },
      {
        q: "Is Hivra suitable for strict data residency?",
        a: "Only if its available hosting region, processing arrangements and contractual terms meet your requirements. A self-hosted system gives you more direct location control.",
      },
      {
        q: "Can I use both a VPS and Hivra?",
        a: "Yes. Many people keep a server for other services and run the agent on a Hivra computer, or the other way round. A Hivra account costs nothing to open; every Hivra Cloud computer is paid, and a free account works with a server you connect yourself.",
      },
      {
        q: "Can I keep my agent running 24/7 on each?",
        a: "On a server you control, it runs until you stop or delete it, and keeping it healthy is your job. A paid Hivra Cloud computer stays on and is not paused for inactivity.",
      },
      {
        q: "Does the server price include AI usage?",
        a: `No, on either side. Hetzner and DigitalOcean sell the server. ${AI_USAGE}`,
      },
      {
        q: "Which is better for Hermes?",
        a: "Hermes runs on either. Self-hosted gives you the most control and the lowest bill if you can order a cheap server and maintain it. Hivra runs the official Hermes Agent on a computer you open from the dashboard, so it suits people who do not want to administer a server.",
      },
      {
        q: "What about DigitalOcean's OpenClaw 1-Click?",
        a: "DigitalOcean lists an OpenClaw 1-Click Droplet and the docs list the Droplet price and no separate app fee. They size a personal setup at 4 GB and 2 CPU, and setup is over SSH. It suits people who want a DigitalOcean server and are comfortable administering it.",
      },
      {
        q: "What happens to my data if I leave Hivra or a server?",
        a: "On Hivra you can download memory files, with a JSON export on Claude Code and Codex agents. On your own server you copy the agent's data folder, and Hermes can export sessions from its dashboard. Hivra does not promise backups, so copy what you need before you delete anything.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-railway", "vs-hostinger", "vs-render", "ai-agent-hosting-alternatives"],
      blog: ["self-hosting-hermes-guide", "managed-vs-self-hosted-ai-agents", "cost-of-running-ai-agent"],
      agents: ["hermes"],
      docs: ["connect-your-own-server"],
      pricing: true,
      extra: [{ label: "Cost calculator", href: HOSTING_COST_CALCULATOR_HREF }],
    }),
  },

  "vs-railway": {
    slug: "vs-railway",
    browserTitle: "Railway vs Hivra: a platform for apps or a home for an agent | Hivra",
    h1: "Railway vs Hivra: a platform for apps or a home for an agent",
    metaDescription: `Railway deploys apps; Hivra hosts a persistent agent from ${ENTRY_PRICE_PROSE}. How the two differ. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "Railway is a capable platform for deploying software. If you are building an application with services, deployments, databases and environment management, those are compelling reasons to use it. Hivra solves a narrower job: running a persistent AI agent on a computer of its own, one you open and work in, without turning its installation and upkeep into a separate project.",
          `The two overlap more than they used to. Railway now offers virtual machines with coding agents preinstalled, as well as community templates that deploy Hermes Agent as a service, so "can Railway run an agent" has a plain answer: yes, in more than one way. The useful question is which shape of the thing you want. Railway is a platform you build on and bill by usage. Hivra is a computer you keep, at a fixed monthly price, with the agent already set up. As of ${formatCheckedMonth()}, this page sets out where each one fits and where Railway is simply the better choice.`,
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          `Railway bills usage. Its plans doc states container rates of $20 per vCPU per month and $10 per GB of RAM per month, $0.15 per GB per month for volume storage and $0.05 per GB of egress, with builds free (as of ${formatCheckedMonth()}). The paid plans are a minimum spend that is credited as usage: Hobby is $5 a month with $5 of usage included and Pro is $20 a month with $20 included, and only usage above the credit is billed. The credit resets each billing cycle and does not carry over. It also lists a Free plan at $0 a month that starts with a 30-day trial with $5 of credit and then gives $1 of credit a month.`,
          "Usage billing means the number depends on what your service does. By our arithmetic from those rates, a container that used 2 vCPU and 4 GB of RAM all month would be about $80 before any included credit, while a service that sits mostly idle would cost far less. That is a real advantage for bursty work and a poor fit if you want to know next month's bill in advance. Hivra's entry size is the same 2 vCPU and 4 GB, always on, so the gap is the always on, full use case; for a lightly used service Railway can cost less. Railway's virtual machines for sandboxes and cloud agents have their own rates, $50 per vCPU per month and $50 per GB of RAM per month on the plans doc, so they are not the same line as a container.",
          "What the usage figure leaves out is the assembly. A durable filesystem means attaching a volume. A login means setting one. Updates mean redeploying. Models are not part of anyone's hosting price, and neither is the time you spend putting it together. A container that deploys successfully is not automatically a useful persistent workspace, and a template that deploys is not automatically one you can leave alone.",
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          `Hivra gives each agent a computer of its own, and you open it: a terminal, files, a browser and Git sit beside the agent in the dashboard. The agents are the ones people already use: ${HIVRA_AGENTS_CELL}. Claude Code and Codex are the vendors' own command line tools, and Hermes is the official Hermes Agent. Hivra is not affiliated with, endorsed by or a partner of Railway, Anthropic, OpenAI, Nous Research or the makers of any other agent it runs.`,
          `The price is ${ENTRY_PRICE_PROSE}, or ${formatPlanSize("larger")}, before AI model spending, with a ${REFUND_LINKED}. ${STAYS_ON} ${AI_USAGE} A Hivra account costs nothing and works with a server you connect yourself, while every Hivra Cloud computer is paid.`,
          "The trade is plain. Hivra is not a place to host your web application, your database or your customers' traffic, and it does not try to be. If your need is a persistent agent that you can open and use every day, a fixed price and a prepared environment are the point. If your need is software infrastructure, Railway is the better tool.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Choose Railway when you are shipping an application. Services, databases, private networking, environments, build pipelines and usage-based scaling are what it is for, and Hivra offers none of them. It can also run a Hermes template as one service among others, which suits a team that already deploys everything there and wants the agent in the same project.",
          "Choose Railway when usage should set the bill. A service that is idle most of the month can cost less than a fixed price, and Railway scales a service far past what one Hivra computer offers: its plans doc lists up to 48 vCPU and 48 GB of RAM per service on Hobby and far more on Pro. Choose it too if you want to try a coding agent on a disposable machine first. Its Free VM page describes a 2 vCPU, 2 GB machine with Claude Code, Codex, OpenCode and others preinstalled, that is deleted with its files if nobody claims it. It has a 60 minute build window and then 24 hours to claim it, uses a shared AI budget (the page's example is $3.00), and is capped per region when demand is high.",
          "There is also no need to pick only one. A web application can live on Railway while an agent runs on Hivra, with an authenticated webhook or API connecting them. If you already have strong deployment automation on Railway, using it for both can still be reasonable.",
        ),
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and Railway compared",
            rows: [
              {
                criterion: "Price model",
                hivra: `Flat monthly price for a computer, from ${formatPlanSize("entry", "compact")}`,
                alternative: "Usage-based: $20/vCPU and $10/GB RAM per month, plus plan fee. The fee is a minimum credited as usage: Hobby $5, Pro $20",
              },
              {
                criterion: "What you get",
                hivra: "A computer of its own with the agent set up: terminal, files, browser and Git beside it",
                alternative: "A platform for services, databases and deployments. Separate VMs with coding agents preinstalled, billed at their own rates",
              },
              {
                criterion: "What stays on",
                hivra: STAYS_ON,
                alternative: "A service runs while deployed. With Serverless on, a service with no outbound traffic can go to sleep, and waking it can take a while and may return a 502",
              },
              {
                criterion: "Persistence",
                hivra: "Pre-configured, on the agent's own disk. No backup promise",
                alternative: "Manual volume + backup setup. One volume per service, no replicas with volumes, brief downtime on redeploy",
              },
              {
                criterion: "Agents supported",
                hivra: HIVRA_AGENTS_CELL,
                alternative: "Anything you can containerise. Community Hermes templates exist; the VMs ship with Claude Code, Codex, OpenCode and others",
              },
              {
                criterion: "Hermes-specific configuration",
                hivra: "Pre-configured out of the box on a paid Hivra Cloud plan (the official Hermes Agent)",
                alternative: "Community one-click Hermes templates exist; you still pick the size, the login and the updates. One shows an unpinned :latest image",
              },
              {
                criterion: "Models and AI cost",
                hivra: AI_ACCESS_CELL,
                alternative: "Not part of Railway's hosting price. You supply keys and pay the model vendor",
              },
              {
                criterion: "Access method",
                hivra: "Open the computer in the dashboard: terminal, files, browser",
                alternative: "Dashboard and CLI for services. The Free VM is reached over SSH. A template may add its own admin page and need a messaging channel for chat",
              },
              {
                criterion: "Agent dashboard & monitoring",
                hivra: "The agent's own interface plus the Manage and Tasks tabs in the dashboard",
                alternative: "No agent dashboard from Railway (Hermes brings its own); Railway shows service metrics and logs, and alerts need Pro",
              },
              {
                criterion: "Scheduled tasks",
                hivra: "Depends on the agent. Hermes has its own scheduler and runs on the computer; Aeon's scheduled work runs on your own GitHub Actions",
                alternative: "Hermes has its own cron; a Railway cron job is a separate service that must exit when its task finishes, at least 5 minutes apart",
              },
              {
                criterion: "Setup effort",
                hivra: "Launch from the dashboard. No server to administer",
                alternative: "You choose the size, attach a volume, set the login and redeploy for updates",
              },
              {
                criterion: "Who maintains it",
                hivra: "Hivra runs the computer. Agent updates are yours, from the Manage tab where offered",
                alternative: "Railway runs the platform. A community template's author maintains the template; you maintain what you deploy",
              },
              {
                criterion: "Data and security",
                hivra: "Each agent runs on a Hivra computer you open and control. No external attestation claimed",
                alternative: "Its pricing page lists a 99.9% (Hobby) and 99.99% (Pro) availability target, SOC 2 and audit logs; which plan includes each is not clear on the page, so confirm before relying on it",
              },
              {
                criterion: "Limits",
                hivra: "The plan's compute is shared by the agent computers on one account",
                alternative: "Per service: Hobby up to 48 vCPU and 48 GB RAM with a 5 GB volume; Pro up to 1,000 vCPU and 1 TB RAM",
              },
              {
                criterion: "Exit and portability",
                hivra: "Your files are on the computer you can open. Copy out what you need",
                alternative: "Standard containers and volumes. Volume data is deleted 60 days after a Hobby plan ends and 90 after Pro",
              },
              {
                criterion: "General-purpose app hosting",
                hivra: "Not the focus. Hivra does not host web applications or databases",
                alternative: "Its main purpose: services, databases, private networking and environments",
              },
              {
                criterion: "Best for",
                hivra: "A fixed bill and an agent you open and keep using",
                alternative: "Applications, databases and teams that already deploy on Railway",
              },
            ],
          },
        ],
      },
      {
        heading: "Who should pick which",
        blocks: [
          {
            kind: "entries",
            items: [
              {
                lead: "Dana, who ships a SaaS product and needs an API, a database and a worker:",
                text: "Pick Railway. That is the job it is built for, and Hivra does not host application services.",
              },
              {
                lead: "Priya, a developer who wants Claude Code on a machine that stays on, reachable from any laptop:",
                text: `Pick Hivra. It is ${ENTRY_PRICE_PROSE}, the computer is not paused for inactivity, and you open its terminal and files without assembling anything. Railway's VMs list Claude Code too, but billing and upkeep are yours.`,
              },
              {
                lead: "Leo, whose team already deploys everything on Railway and wants one Hermes service beside it:",
                text: "Pick Railway. A community template puts Hermes in the same project, with the same billing and the same people on call. Pin the image and set a real login first.",
              },
              {
                lead: "Tom, an AI power user who wants to know next month's bill before it starts:",
                text: `Pick Hivra for the hosting part, at ${ENTRY_PRICE_PROSE}. The monthly price does not move with activity, while usage billing follows what the service does. Model usage is separate on both, so budget it either way.`,
              },
              {
                lead: "Ines, who wants to try a coding agent on a throwaway machine this afternoon:",
                text: "Try Railway's Free VM. It is built for that, and unclaimed machines are deleted with their files, so nothing lingers. Move to a computer you keep once the agent has earned a place in your week.",
              },
              {
                lead: "Marcus, who wants Hermes working on a schedule with its files and memory kept in one place:",
                text: "Pick Hivra. Memory and scheduling are pre-configured on the agent's own disk. On Railway you would attach a volume, set up backups and run the cron inside Hermes or as a separate service.",
              },
              {
                lead: "Raj, who runs a Proxmox server at home:",
                text: "Pick Hivra with a free account and connect that server, so the agents run on hardware you own. Railway hosts on its own platform.",
              },
            ],
          },
        ],
      },
      {
        heading: "How to try both",
        blocks: [
          {
            kind: "steps",
            items: [
              { lead: "Pick one real workload.", text: "An ordinary task, a scheduled task and a task that writes a file. Use the same agent on both so the comparison is about the host." },
              {
                lead: "Run it on Railway.",
                text: "Deploy a Hermes template or the Free VM, pin the image, set a login, attach a volume and check what the usage page shows after a day idle and a day working. Read what a template's own page says about its size and login.",
              },
              {
                lead: "Run it on Hivra.",
                text: `Create an account, launch the agent on a paid Hivra Cloud computer at ${ENTRY_PRICE_PROSE}, and open its terminal and files. The ${REFUND_LINKED} covers the test if you decide against it.`,
              },
              { lead: "Restart both.", text: "Redeploy the Railway service, restart the Hivra computer, then confirm files, credentials and task history survived on each." },
              { lead: "Count model usage separately.", text: "Neither hosting price includes it. Add it to each side so the month is a real number." },
              { lead: "Decide, then clean up.", text: "Take the cheaper full month you also trust. Delete the Railway test service so its usage stops, and remove any volume you no longer need." },
            ],
          },
        ],
      },
      {
        heading: "What survives, and for how long",
        blocks: [
          {
            kind: "entries",
            items: [
              {
                lead: "On Railway:",
                text: "A volume keeps data at its mount path across redeploys, but a redeploy of a service with a volume causes brief downtime. Railway's volume page does not describe what happens to files outside the volume, so treat anything you need as belonging on it. Railway's own backups run daily, weekly and monthly and are kept 6, 27 and 89 days, restore only into the same project, and are billed at the volume rate. Wiping a volume deletes its backups. A sleeping service's pages do not say what state persists across sleep.",
              },
              {
                lead: "When a plan ends or a balance runs out:",
                text: "Railway's plans doc says volume data is deleted 30 days after a Free or Trial plan ends, 60 days after Hobby and 90 days after Pro. If you pay with credits and the balance reaches zero, the subscription is cancelled and workloads are stopped. A deleted volume is removed within 48 hours, and restorable in that window.",
              },
              {
                lead: "On Hivra:",
                text: `${CLI_RUN_LIFETIME} Hivra does not promise backups, so copy out anything you cannot lose, on either host.`,
              },
            ],
          },
        ],
      },
      cautionSection(COMPETITOR_FACTS_CHECKED),
    ],
    sources: priceSources(
      [
        { label: "Railway pricing", href: "https://railway.com/pricing" },
        { label: "Railway plans", href: "https://docs.railway.com/pricing/plans" },
        { label: "Railway Free VM", href: "https://railway.com/free-vm" },
        { label: "Railway Serverless (app sleeping)", href: "https://docs.railway.com/reference/app-sleeping" },
        { label: "Railway volumes", href: "https://docs.railway.com/volumes/reference" },
        { label: "Railway volume backups", href: "https://docs.railway.com/volumes/backups" },
        { label: "Railway cron jobs", href: "https://docs.railway.com/cron-jobs" },
        { label: "Railway observability", href: "https://docs.railway.com/observability" },
        { label: "Railway fair use policy", href: "https://railway.com/legal/fair-use" },
        { label: "Railway Hermes template (Heimdall)", href: "https://railway.com/deploy/hermes-agent-ai" },
        { label: "Railway Hermes template (codestorm)", href: "https://railway.com/deploy/hermes-agent-official" },
        { label: "Hermes Docker setup (Nous Research)", href: "https://hermes-agent.nousresearch.com/docs/user-guide/docker" },
      ],
      [
        "Nothing quoted above is a sale price. The $80 figure is our own arithmetic from Railway's published container rates, not a Railway quote, and Railway's pricing page states per-second rates, from which the monthly rates on its plans doc follow.",
        "Railway's pricing page lists one week of log history on Hobby and 30 days on Pro, and lists SOC 2, SSO and audit logs as features without making clear which plan includes each. Its pages did not state a refund policy where we read them (its refunds page would not load for us), what a service keeps across Serverless sleep, or how a claimed Free VM idles or what it costs afterward. The Hermes templates are by third-party authors, not Railway or Nous Research.",
      ],
    ),
    faqs: [
      {
        q: "Is Railway cheaper than Hivra for an AI agent?",
        a: `It depends on how busy the agent is. Railway bills usage at $20 per vCPU and $10 per GB of RAM per month, so an idle service can cost less than a fixed price, while a container using 2 vCPU and 4 GB all month would be about $80 on our arithmetic before any included credit. Hivra is ${ENTRY_PRICE_PROSE}. Neither includes model usage.`,
      },
      {
        q: "Can Railway run AI agents?",
        a: "Yes. It hosts applications and services, has community templates for Hermes Agent, and offers a Free VM with Claude Code, Codex, OpenCode and other agents preinstalled. A volume, a login and updates are yours to configure.",
      },
      {
        q: "Can I use Railway and Hivra together?",
        a: "Yes. Keep your application on Railway and run the agent on Hivra, connected through appropriately authenticated interfaces. A web service on one and a persistent agent on the other is a common split.",
      },
      {
        q: "Does Hivra include AI usage in the monthly price?",
        a: `No. ${AI_USAGE}`,
      },
      {
        q: "Can I keep an agent running 24/7 on each?",
        a: `On Hivra, ${STAYS_ON} On Railway, a deployed service runs while deployed, but with Serverless turned on a service with no outbound traffic can go to sleep, and the first request after that may be slow.`,
      },
      {
        q: "Where does my agent's data live on Railway?",
        a: "On a volume you attach, which keeps data at its mount path across redeploys. A volume belongs to one service, cannot be used with replicas and can grow but not shrink. Volume data is deleted 30 days after a Free plan ends, 60 after Hobby and 90 after Pro.",
      },
      {
        q: "Which is better for Hermes Agent?",
        a: "Hivra if you want Hermes already configured on a computer you open (Hermes launches on Hivra Cloud on a paid plan). Railway if you want it as one service among others in a project you already run, using a community template. You choose the size, login and updates on Railway.",
      },
      {
        q: "Does Railway have a free option?",
        a: "Railway lists a Free plan at $0 a month that starts with a 30-day trial with $5 of credit and then gives $1 of credit a month. It also offers a Free VM that is deleted with its files if unclaimed. A Hivra account costs nothing and works with a server you connect yourself, but every Hivra Cloud computer is paid.",
      },
      {
        q: "Can I move from Railway to Hivra later?",
        a: `Yes. Copy your agent's files and settings off the Railway volume, launch the same agent on a Hivra computer and copy them in. How much carries over depends on the agent, so test with one real workload first. The Hivra test is covered by the ${MONEY_BACK_GUARANTEE}.`,
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-render", "vs-self-hosted", "ai-agent-hosting-alternatives", "vs-fly-sprites"],
      blog: ["cost-of-running-ai-agent", "managed-vs-self-hosted-ai-agents"],
      agents: ["hermes"],
      docs: ["plans-and-billing"],
      pricing: true,
    }),
  },

  "vs-render": {
    slug: "vs-render",
    browserTitle: "Running Hermes on Render or on Hivra | Hivra",
    h1: "Running Hermes on Render or on Hivra",
    metaDescription: `Render's Hermes template runs on a $25 web service plus a disk; Hivra is ${ENTRY_PRICE_PROSE}. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "Render publishes a one-click Hermes template, so the comparison is not whether Render can run an agent. It can. Render is a general cloud platform for web services, workers, databases and static sites, and the template puts Hermes on it as one more service. The useful question is how much of the agent's environment, access control and upkeep you want to run yourself.",
          `Hivra solves a narrower job. It gives an agent a computer of its own, one you open and work in, with the agent already installed. For Hermes that is the official Hermes Agent, and it is ${ENTRY_PRICE_PROSE}. As of ${formatCheckedMonth()}, this page sets out what each route costs, what you assemble on each, and where Render is simply the better choice.`,
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          `Render's pricing page lists a workspace plan and then compute on top. As of ${formatCheckedMonth()} the workspace plans are Hobby at $0 a month, Pro at $25 a month and Scale at $499 a month, with compute billed separately and prorated to the second. Hobby covers up to 25 services and 5 GB of included bandwidth a month, Pro 25 GB, and overage is $0.15 per GB.`,
          "Services and background workers share one price table. The plan with 1 CPU and 2 GB of RAM is listed at $25 a month, 2 CPU and 4 GB at $85, 4 CPU and 8 GB at $175, and the largest listed size, 12 CPU and 96 GB, at $1,500. Render's Hermes template says the Standard plan gives enough resources to run the dashboard and gateway in one container. The pricing table names its plans by size, such as 1c-2g, and does not list one called Standard, so our reading is that the template means the 1 CPU, 2 GB tier. The template page does not state a price for it.",
          "The template also uses a 5 GB persistent disk for skills, sessions, memories and config files. Disks are listed at $0.25 per GB a month, so 5 GB is $1.25. That puts the entry template at around $26.25 a month in compute and disk, before any workspace plan fee and before AI usage. The template page does not say which workspace plan it needs, so check that before you count the fee in or out.",
          `On Hivra the same job is ${ENTRY_PRICE_PROSE}, with Hermes already installed and the disk included in the computer. Like Render's, that price does not cover models. ${AI_USAGE} Render's 2 CPU, 4 GB service is $85 a month, but the two are not the same product: Render sells a service that you build on, and Hivra sells a computer that you keep.`,
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          `Hivra gives each agent a computer of its own, and you open it: a terminal, files, a browser and Git sit beside the agent in the dashboard. The agents are the ones people already use: ${HIVRA_AGENTS_CELL}. Hermes is the official Hermes Agent, and Hivra is not affiliated with or endorsed by Render, Nous Research or the makers of any other agent it runs.`,
          `${STAYS_ON} The plan includes a ${REFUND_LINKED}. A Hivra account costs nothing and works with a server you connect yourself, while every Hivra Cloud computer is paid.`,
          "On Render you assemble the pieces. You deploy the template, enter a model provider key in the dashboard's API Keys tab, decide how the Hermes dashboard is reached and secured, choose the size and keep the service updated. The template page does not describe how access to the Hermes dashboard is secured, so read the template's own instructions and set up a login or private access before you rely on it. Hivra opens Hermes behind the Hivra sign-in.",
          "The trade is plain. Hivra is not a place to host your web application, your database or your customers' traffic, and it does not try to be. If you need a persistent agent that you open and use every day, a fixed price and a prepared computer are the point. If you need software infrastructure, Render is the better tool.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Choose Render when your other services already run there. A Hermes service that lives in the same workspace as your API, your database and your workers shares one bill, one set of deploys and one place to look when something breaks. Hivra offers none of those application services.",
          "Choose Render when you need scale or breadth that one Hivra computer does not offer. Its table runs up to 12 CPU and 96 GB of RAM, it bills to the second, and it hosts static sites that its pricing page calls always free to deploy. A free web service or a free Postgres database is also a cheap way to try things that are not an agent. Render's docs say free Postgres databases expire 30 days after creation.",
          "Choose Render when you want an agent to be one service among many that your team already knows how to operate. Its disks are also copied every 24 hours, with the copies kept for seven days, which is a recovery feature Hivra does not promise.",
          "There is no need to pick only one. A web application can stay on Render while the agent runs on Hivra, with an authenticated webhook or API between them.",
        ),
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and Render compared",
            rows: [
              {
                criterion: "Price model",
                hivra: `Flat monthly price for a computer, from ${formatPlanSize("entry", "compact")}`,
                alternative: "Workspace plan (Hobby $0, Pro $25, Scale $499 a month) plus per-instance compute, prorated to the second",
              },
              {
                criterion: "What you get",
                hivra: "A computer of its own with the agent set up: terminal, files, browser and Git beside it",
                alternative: "A cloud platform for services, workers, databases and static sites. A Hermes template deploys the agent as a service",
              },
              {
                criterion: "Cheapest size the Hermes template needs",
                hivra: formatPlanSize("entry", "compact"),
                alternative: "$25/mo (1 CPU, 2 GB) plus the 5 GB disk at $1.25, before any workspace fee",
              },
              {
                criterion: "Monthly cost with 4 GB of RAM",
                hivra: formatPlanSize("entry", "compact"),
                alternative: "$85/mo (2 CPU, 4 GB) plus disk",
              },
              {
                criterion: "Always-on (no sleep)",
                hivra: STAYS_ON,
                alternative: "Free web services spin down after 15 minutes without inbound traffic (Render docs). We found no Render page on idle behaviour for paid instances, so confirm it",
              },
              {
                criterion: "Persistence",
                hivra: "Hermes keeps its memory and files on the agent's own disk. No backup promise",
                alternative: "A paid-only disk, mounted for one instance. Adding one prevents zero-downtime deploys. Disk copies every 24 hours, kept seven days",
              },
              {
                criterion: "Supported agents",
                hivra: HIVRA_AGENTS_CELL,
                alternative: "The template is Hermes only. Anything else you can put in a container, set up by you",
              },
              {
                criterion: "Models and AI cost",
                hivra: AI_ACCESS_CELL,
                alternative: "Not part of Render's price. Provider keys go in the Hermes dashboard's API Keys tab and you pay the model vendor",
              },
              {
                criterion: "Access method",
                hivra: "Open the computer in the dashboard: terminal, files, browser. Hermes opens behind the Hivra sign-in",
                alternative: "The Hermes dashboard on your service's address. The template page does not say how that access is secured",
              },
              {
                criterion: "Setup effort",
                hivra: "Launch from the dashboard. No server to administer",
                alternative: "Deploy the template, add a key, secure the dashboard, choose the size and redeploy for updates",
              },
              {
                criterion: "Who maintains it",
                hivra: "Hivra runs the computer. Agent updates are yours, from the Manage tab where offered",
                alternative: "Render runs the platform. You maintain what you deploy and its updates",
              },
              {
                criterion: "Data and security",
                hivra: "Each agent runs on its own computer. No external attestation claimed",
                alternative: "Security and trust pages were not read for this page, so nothing is claimed here. Read them before you decide",
              },
              {
                criterion: "Limits",
                hivra: `Two sizes: ${formatPlanSize("entry", "compact")} and ${formatPlanSize("larger", "compact")}`,
                alternative: "Sizes from under 1 CPU up to 12 CPU and 96 GB. A disk limits the service to one instance and can grow but not shrink",
              },
              {
                criterion: "Exit and portability",
                hivra: "Your files are on the computer you can open. Copy out what you need",
                alternative: "Skills, sessions, memories and config sit on the disk at /opt/data. Copy them out before you delete the service",
              },
              {
                criterion: "Best for",
                hivra: "A fixed bill and an agent you open and keep using",
                alternative: "Teams that already run services on Render and want Hermes beside them",
              },
            ],
          },
        ],
      },
      {
        heading: "Who should pick which",
        blocks: [
          {
            kind: "entries",
            items: [
              {
                lead: "Dana, whose team already runs an API, a database and workers on Render:",
                text: "Pick Render, and add Hermes there if you want it beside the rest. One workspace, one bill and one place for deploys and on-call, with the agent as one more service. Set up a login or private access for the Hermes dashboard before anyone relies on it. Hivra does not host application services.",
              },
              {
                lead: "Priya, a developer who wants Hermes on a machine that stays on, reachable from any laptop:",
                text: `Pick Hivra. It is ${ENTRY_PRICE_PROSE}, the computer is not paused for inactivity, and you open its terminal and files without assembling a service, a disk and a login.`,
              },
              {
                lead: "Tom, an AI power user who wants to know next month's bill before it starts:",
                text: "Pick Hivra for the hosting part. The monthly price is fixed. Render's is predictable for a fixed-size instance too, but a workspace fee, bandwidth overage and a disk all sit on top. Model usage is separate on both, so budget it either way.",
              },
              {
                lead: "Ines, who wants to try an idea this afternoon at no cost:",
                text: "Try Render's free web service for a small, non-agent experiment. Free web services have no persistent disk and sleep after 15 minutes without inbound traffic, so they are a poor home for an agent that must keep its memory. Move to a computer you keep once the idea has earned a place in your week.",
              },
              {
                lead: "Marcus, who wants Hermes working on a schedule with its files and memory kept in one place:",
                text: "Pick Hivra. Hermes keeps its memory and files on the agent's own disk on Hivra. On Render the disk is an add-on to a paid service, and adding it prevents zero-downtime deploys.",
              },
            ],
          },
        ],
      },
      {
        heading: "How to try both",
        blocks: [
          {
            kind: "steps",
            items: [
              { lead: "Pick one real workload.", text: "An ordinary task, a scheduled task and a task that writes a file. Use Hermes on both so the comparison is about the host." },
              {
                lead: "Run it on Render.",
                text: "Deploy the Hermes template on a paid instance with its 5 GB disk, enter a model key in the API Keys tab and set up a login or private access for the dashboard first. Check what the billing page shows after a day idle and a day working.",
              },
              {
                lead: "Run it on Hivra.",
                text: `Create an account, launch Hermes on a paid Hivra Cloud computer at ${ENTRY_PRICE_PROSE}, and open its terminal and files. The ${REFUND_LINKED} covers the test if you decide against it.`,
              },
              { lead: "Restart both.", text: "Redeploy the Render service, restart the Hivra computer, then confirm skills, sessions, memories and credentials survived on each." },
              { lead: "Count model usage separately.", text: "Neither hosting price includes it. Add it to each side so the month is a real number." },
              { lead: "Decide, then clean up.", text: "Keep the cheaper full month you also trust. Delete the Render test service so its compute and disk stop billing, and copy out any files you want first." },
            ],
          },
        ],
      },
      {
        heading: "What survives, and for how long",
        blocks: [
          {
            kind: "entries",
            items: [
              {
                lead: "On Render:",
                text: "Files written outside the disk do not survive a redeploy, so the template keeps skills, sessions, memories and config on its disk at /opt/data. A disk attaches to a paid web service, private service or background worker, is used by a single instance and can grow but not shrink. Render copies it every 24 hours and keeps each copy for seven days, and a restore discards changes made after that copy.",
              },
              {
                lead: "When the service is free or idle:",
                text: "A free web service has no persistent disk. It spins down after 15 minutes without inbound traffic, with waking taking about one minute. Render's docs say its local filesystem is ephemeral, so changes are lost on redeploy, restart or spin-down. Do not store agent state there.",
              },
              {
                lead: "On Hivra:",
                text: `${CLI_RUN_LIFETIME} Hivra does not promise backups, so copy out anything you cannot lose, on either host.`,
              },
            ],
          },
        ],
      },
      cautionSection(COMPETITOR_FACTS_CHECKED),
    ],
    sources: priceSources(
      [
        { label: "Render pricing", href: "https://render.com/pricing" },
        { label: "Render free instance limits", href: "https://render.com/docs/free" },
        { label: "Render persistent disks", href: "https://render.com/docs/disks" },
        { label: "Render's Hermes template", href: "https://render.com/templates/hermes-on-render" },
      ],
      [
        "Nothing quoted above is a sale price. The $26.25 figure is our own arithmetic from Render's listed 1 CPU, 2 GB price and its per-gigabyte disk price, not a Render quote.",
        "Render's pricing page states no refund policy and points refund questions to its support address. We did not read Render's terms, security pages, regions pages or background worker docs, so none of those is claimed here, and the template's own README was not read for this page. The template page does not state a price for the Standard plan or the disk.",
      ],
    ),
    faqs: [
      {
        q: "Does Render offer a Hermes template?",
        a: "Yes. Render publishes a one-click Hermes template that runs the dashboard and gateway in one container with a 5 GB persistent disk. Check its current plan requirements and instructions before you deploy.",
      },
      {
        q: "How much does it cost to run Hermes on Render?",
        a: "Render lists its 1 CPU, 2 GB tier at $25 a month and a persistent disk at $0.25 per GB a month, so a 5 GB disk is $1.25. That is around $26.25 a month on our arithmetic, before any workspace plan fee and before AI usage. These are Render's figures as of November 2026 and may have changed.",
      },
      {
        q: "Is Hivra cheaper than Render for Hermes?",
        a: `For one always-on Hermes agent, Hivra is ${ENTRY_PRICE_PROSE}, against Render's $25 a month for 1 CPU and 2 GB plus disk. They are different products: Render is a platform for many kinds of services. Neither price includes AI model usage.`,
      },
      {
        q: "Can I use Render and Hivra together?",
        a: "Yes. Keep your application on Render and run the agent on Hivra, connected through appropriately authenticated interfaces. A web service on one and a persistent agent on the other is a common split.",
      },
      {
        q: "Does Hivra include AI usage in the monthly price?",
        a: `No. ${AI_USAGE}`,
      },
      {
        q: "Can I keep an agent running 24/7 on each?",
        a: `On Hivra, ${STAYS_ON} On Render, a free web service spins down after 15 minutes without inbound traffic. We found no Render page on idle behaviour for paid instances, so confirm that on your own plan.`,
      },
      {
        q: "Where does my agent's data live on Render?",
        a: "On a persistent disk you attach to a paid service. It is used by one instance, can grow but not shrink, and adding it prevents zero-downtime deploys. Render copies it every 24 hours and keeps each copy for seven days. Free web services do not support disks.",
      },
      {
        q: "Does Render have a free option?",
        a: "Render lists a Hobby workspace at $0 a month and free web services that sleep when idle and have no disk, so they are not suited to an agent that keeps memory. A Hivra account costs nothing and works with a server you connect yourself, but every Hivra Cloud computer is paid.",
      },
      {
        q: "Which is better for Hermes Agent?",
        a: "Hivra if you want the official Hermes Agent already set up on a computer you open, at a fixed price. Render if you want Hermes as one service among others in a workspace you already run. On Render you choose the size, the login and the updates.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-railway", "vs-self-hosted", "ai-agent-hosting-alternatives", "vs-xcloud"],
      blog: ["cost-of-running-ai-agent", "self-hosting-hermes-guide"],
      agents: ["hermes"],
      docs: ["hermes"],
      pricing: true,
    }),
  },

  "openclaw-to-hermes": {
    slug: "openclaw-to-hermes",
    browserTitle: "Moving from OpenClaw to Hermes on Hivra | Hivra",
    h1: "Moving from OpenClaw to Hermes on Hivra",
    metaDescription:
      "Hivra can host OpenClaw or Hermes on a paid computer. Hermes has its own command to move an OpenClaw setup. What carries over and what you rebuild.",
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "Switching agent frameworks and switching hosting providers are not the same decision, and this page keeps them apart. If OpenClaw already does what you need, Hivra can host it on a paid Hivra Cloud computer, just as it hosts Hermes. You do not have to adopt Hermes simply to stop maintaining your own machine.",
          "Whether Hermes is the better agent for you depends on skills, memory, messaging channels and habits, which no feature table settles. The three paths are to stay on OpenClaw where it runs now, run OpenClaw on a Hivra computer, or move to Hermes on a Hivra computer with Hermes' own import command. This page shows what each costs.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          "Moving frameworks costs you attention, not a licence fee. The attention goes on four things: working out what your OpenClaw setup actually contains, running the import, rebuilding what the import does not carry, and checking that the new agent behaves the way the old one did. Hivra itself has no import tool. Hermes' own `hermes import-agent openclaw` command (installed with `hermes plugins install agent-importers`; the older `hermes claw migrate` spelling also works once the plugin is installed) imports your persona, memory, skills, MCP servers, and model and messaging settings. Its `--dry-run` flag previews the result without changing anything.",
          "Hosting is a separate line. " + "Every Hivra Cloud computer is paid: " + ENTRY_PRICE_PROSE + ", with a " + REFUND_LINKED + ". A free account works with a computer or server you connect yourself. " + AI_USAGE,
          "If you run OpenClaw yourself today, the comparison is your own machine against that monthly price. If you already run a machine all day, self-hosting adds little hosting cost, though you still spend time on updates and recovery. If you do not, compare the Hivra monthly price with the cost of a small VPS from its provider's own pricing page, and remember that a VPS leaves the setup and upkeep to you.",
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          "On Hivra, Hermes runs as the official Hermes Agent, not a fork: Hivra creates the computer, runs Hermes' own installer, and opens Hermes' own web interface behind your Hivra sign-in. You update it the way Hermes' own documentation describes, with `hermes update` in the Terminal tab or the Update Hermes button on the agent's Manage tab. OpenClaw also launches on Hivra, so the same computer-of-its-own model applies whichever agent you choose.",
          "OpenClaw lists a wider range of messaging channels in its docs, so check that every channel you use is supported by Hermes before you move. Hermes suits people who want its own skills, memory and cron approach. A hosted computer removes infrastructure work, but it does not make the two frameworks interchangeable. " + STAYS_ON + " " + SERVER_SIDE_AGENTS_KEEP_WORKING,
          "Hivra is not affiliated with the OpenClaw project or with Nous Research, the makers of Hermes. It runs their software, and their documentation, not Hivra's, is the authority on how each behaves.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Staying on OpenClaw is a perfectly good decision, and sometimes the better one. If your setup is stable, your channels are paired and your schedules run, a framework change gives you risk without a clear reward. Hermes' own migration guide lists cron jobs, plugins, hooks and webhooks, channel bindings and a multi-agent list as archived for you to recreate by hand, and WhatsApp has to be paired again. The more of those you rely on, the more rebuilding you take on.",
          "Hivra does not convert OpenClaw memory, plugins or configuration for you, and Hermes' own command does not bring everything across. Third-party integrations may need to be authorised again. Keep the old setup available until essential workflows have been checked. If you want a hosted computer but not a new framework, run OpenClaw on Hivra and skip the migration altogether.",
          "OpenClaw's own documentation also has a guide for importing a Hermes setup into OpenClaw. It needs a fresh OpenClaw setup, so a move to Hermes is not a one-way door, but moving back takes some work.",
        ),
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hermes on Hivra and self-hosted OpenClaw compared",
            rows: [
              { criterion: "Price model", hivra: `A fixed monthly price per computer: from ${formatPlanSize("entry", "compact")}. ${REFUND_LINKED}`, alternative: "You supply the machine and the model access, so your cost is hardware or hosting plus usage" },
              { criterion: "What you get", hivra: "A computer of its own running the official Hermes Agent, opened in the browser", alternative: "OpenClaw on a laptop, a home server or a VPS you set up" },
              { criterion: "What stays on", hivra: STAYS_ON, alternative: "Whatever your own machine does: it runs while it is switched on and connected" },
              { criterion: "Persistence", hivra: "Memory, skills and files live on the computer. Hermes conversations persist until you send /new or /reset", alternative: "OpenClaw keeps memory and workspace files such as SOUL.md and AGENTS.md in its workspace, on a machine you keep running" },
              { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "OpenClaw. Other agents are your own installs" },
              { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Hosted and local providers, set up in OpenClaw's configuration" },
              { criterion: "Scheduled tasks", hivra: "Hermes' own cron on a computer that is not paused for inactivity", alternative: "OpenClaw's built-in cron automations, running while your machine is on" },
              { criterion: "Access method", hivra: "Open the computer from the Hivra dashboard, with Hermes' web interface behind your Hivra sign-in", alternative: "Whatever you configure: OpenClaw's channels and control UI, plus any remote access you set up yourself (such as SSH on your own server)" },
              { criterion: "Setup effort", hivra: "Launch the computer, then run the import where your OpenClaw directory is and rebuild the archived items", alternative: "Nothing to move. You keep configuring and updating it yourself" },
              { criterion: "Who maintains it", hivra: "Hivra runs the computer. Updates to Hermes are yours to apply, with `hermes update` or the Update Hermes button", alternative: "You: the operating system, OpenClaw updates, restarts and recovery" },
              { criterion: "Data and security", hivra: "Secrets come across only if you pass --migrate-secrets. Review what the agent can reach before unattended runs", alternative: "Your keys and data stay on hardware you control, and so does the responsibility for locking it down" },
              { criterion: "Limits", hivra: "A paid computer has a fixed size, and Hermes needs at least 1 CPU and 2 GB", alternative: "Whatever your hardware allows. No size ceiling except your own machine" },
              { criterion: "Exit and portability", hivra: "Hermes keeps its data under ~/.hermes and can back it up and restore it with `hermes import`. OpenClaw's docs describe importing a Hermes setup into a fresh OpenClaw setup", alternative: "Hermes' guide describes importing an OpenClaw setup, with the archived items recreated by hand" },
              { criterion: "Best for", hivra: "People who want Hermes' approach to skills and memory on a machine they do not have to look after", alternative: "People whose OpenClaw setup is working, with channels and schedules they would rather not rebuild" },
            ],
          },
        ],
      },
      {
        heading: "Who should pick which",
        blocks: [
          {
            kind: "entries",
            items: [
              { lead: "Dana runs OpenClaw on a home server, with Telegram and Slack channels and several cron jobs that work.", text: "Stay on OpenClaw. A new framework would mean recreating her schedules and channel bindings for little gain. If the home server is the only thing that bothers her, hosting OpenClaw itself on Hivra solves that without a migration." },
              { lead: "Marcus is a developer whose OpenClaw agent lives on his laptop and sleeps when he does.", text: "Hermes on Hivra, if he is curious about it, or OpenClaw on Hivra if he is not. Either way the agent stops depending on his laptop. He should run the import in preview mode first and decide from what it lists." },
              { lead: "Aiko uses OpenClaw across WhatsApp and several other channels, with a multi-agent setup.", text: "Stay on OpenClaw. Hermes' guide says WhatsApp needs pairing again, and channel bindings and the multi-agent list are archived for manual setup. Her working arrangement is worth more than the novelty." },
              { lead: "Tom wants an always-on agent and has no opinion about frameworks.", text: "Either, but Hermes on Hivra is the simpler start: nothing to import and nothing to rebuild. He can switch later if he wants OpenClaw's integrations." },
              { lead: "Lena is curious about Hermes' skills and memory but does not want to disturb a working OpenClaw bot.", text: "Hermes on a separate Hivra computer, with the OpenClaw bot left alone. She should rebuild one workflow at a time, point Hermes at test accounts first, and switch the old bot off only when she trusts the new one." },
              { lead: "Omar has an OpenClaw install on a VPS with a custom Docker stack and root-level tooling.", text: "Stay on his VPS. If he later wants the agent on a managed computer, he can try OpenClaw on Hivra and see whether the stack fits, but his existing server is doing the job." },
              { lead: "Sam tried Hermes for a month and wants OpenClaw back.", text: "Move back. OpenClaw's guide covers importing a Hermes setup (`openclaw migrate hermes --dry-run`, then `openclaw migrate apply hermes --yes`). It needs a fresh OpenClaw setup, and items such as pre-registered OAuth client settings go to manual review. Hivra does not lock him in to either framework." },
            ],
          },
        ],
      },
      {
        heading: "A migration that does not lose your working setup",
        blocks: [
          {
            kind: "steps",
            items: [
              { lead: "Inventory what matters.", text: "Record the messaging channels, schedules, credentials, MCP servers and installed skills the agent uses. Note which API keys are stored in the OpenClaw config, in its .env file or in a secret reference that points at a file or command, because those last ones are not resolved automatically." },
              { lead: "Start a separate test computer.", text: "Launch Hermes on Hivra without taking the existing OpenClaw bot offline. Avoid pointing both agents at the same production accounts unless you understand the consequences, and avoid pointing both agents at the same tokens." },
              { lead: "Preview the import.", text: "The command reads ~/.openclaw by default, or a path you give with `--source`, so run it where that directory is. If OpenClaw lives on another machine, copy the directory across yourself. Install the importer once with `hermes plugins install agent-importers` (`hermes setup` on a fresh install can offer it too), then start with `hermes import-agent openclaw --dry-run` and read the list before applying anything." },
              { lead: "Apply it, deliberately.", text: "Hermes saves a zip backup of ~/.hermes/ first (skip it with --no-backup), and you can restore it with `hermes import`. Pass `--migrate-secrets` only if you want API keys to come across. If platform tokens came across, restart the gateway with `systemctl --user restart hermes-gateway`. Start a new Hermes session afterwards, since imported skills and memory take effect in new sessions, and run `hermes status` to check provider authentication." },
              { lead: "Rebuild one workflow at a time.", text: "Test reading, drafting and scheduled tasks before authorising write actions or unattended activity. Recreate cron jobs with `hermes cron create` and pair WhatsApp again with `hermes whatsapp` if you use it." },
              { lead: "Verify the real output.", text: "Check that the message was delivered, that the file was written, or that the record changed, rather than trusting a success-looking response." },
              { lead: "Cut over deliberately.", text: "Turn off duplicate schedules and revoke old credentials you no longer need. Hermes' guide offers `hermes claw cleanup`, which moves leftover OpenClaw directories into .pre-migration/ so they do not confuse later work. Run it only when you are sure." },
            ],
          },
        ],
      },
      {
        heading: "What will not transfer automatically",
        blocks: paragraphs(
          "Hermes' migration guide lists cron jobs, plugins, webhooks and channel bindings as archived for you to set up again by hand, and WhatsApp needs pairing again. The identity and tools notes, the heartbeat file and the multi-agent list are archived too, with a suggestion for how to recreate each in Hermes. API keys come across only with `--migrate-secrets`, and secret references that point at a file or a command have to be added by hand. Idle and daily session reset timers are not imported either: Hermes conversations persist until you send /new or /reset. Treat migration as a controlled rebuild, not a guaranteed import.",
        ),
      },
      {
        heading: "What survives, and for how long",
        blocks: paragraphs(
          "On the OpenClaw side, nothing is deleted by the import: it reads your existing directory, so the old setup is still there until you remove it. On the Hermes side, persona, memory entries and skills land under the Hermes home directory on the computer, with imported skills in their own openclaw-imports folder. The memory files from OpenClaw are merged and de-duplicated into Hermes' memory, so check the result before you trust it.",
          "On a paid Hivra computer, files, logins and settings stay on the computer and it is not paused for inactivity. That is persistence, not a promise of a copy somewhere else, so keep your own copy of anything you cannot afford to lose, the OpenClaw directory included, until you are certain the move worked.",
          "What does not survive is anything tied to a live session: a paired WhatsApp login, an authorised third-party integration or an approval you gave to one agent. Those need doing again on the new one.",
        ),
      },
      cautionSection(COMPETITOR_FACTS_CHECKED),
    ],
    sources: {
      heading: "Where these facts come from",
      intro: `The migration steps come from Hermes' own migration guide and OpenClaw's page on migrating from Hermes, as of ${formatCheckedMonth()}. Both projects change quickly: Hermes' guide names the command as hermes import-agent, installed with the agent-importers plugin, with the older hermes claw migrate spelling also working once the plugin is installed. Open the guide before you migrate.`,
      notes: [
        "This page quotes no competitor prices. Hivra's own price comes from its checkout and pricing page.",
        "Nothing here is sale-priced, sign-in-only or in beta. OpenClaw's comparison page says it reflects a source review from August 2026, not a live test.",
      ],
      links: [
        { label: "Hermes docs: Migrate from OpenClaw", href: HERMES_OPENCLAW_MIGRATION_GUIDE },
        { label: "Hermes documentation (including hermes update)", href: "https://hermes-agent.nousresearch.com/docs" },
        { label: "Hivra pricing", href: "/pricing" },
        { label: "Hivra agents", href: "/agents" },
        { label: "OpenClaw docs: Migrating from Hermes", href: "https://docs.openclaw.ai/install/migrating-hermes" },
        { label: "OpenClaw docs: OpenClaw and Hermes Agent", href: "https://docs.openclaw.ai/start/why-openclaw/openclaw-and-hermes-agent" },
        { label: "OpenClaw documentation", href: "https://docs.openclaw.ai" },
        { label: "OpenClaw on GitHub", href: "https://github.com/openclaw/openclaw" },
      ],
    },
    faqs: [
      {
        q: "Do I need to leave OpenClaw to use Hivra?",
        a: `No. Hivra can host OpenClaw as well as Hermes. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT}`,
      },
      {
        q: "Can I transfer every OpenClaw skill and memory?",
        a: "Do not assume so. Hivra itself has no import tool. If you move to Hermes, hermes import-agent openclaw (installed with hermes plugins install agent-importers; the older hermes claw migrate spelling also works once the plugin is installed) brings across your persona, memory, skills, MCP servers, model and messaging settings, and API keys if you choose. Cron jobs, plugins, webhooks and channel bindings need setting up again by hand.",
      },
      {
        q: "How do I preview the move before changing anything?",
        a: "Run the import with its --dry-run flag. Hermes' own command always shows a preview first and asks you to confirm, and the dry run stops after showing what it would migrate, so nothing on either side changes.",
      },
      {
        q: "Will my API keys move across?",
        a: "Only if you ask. Hermes' guide says no preset imports secrets unless you pass --migrate-secrets. Keys stored as a reference to a file or a command cannot be resolved automatically and have to be added by hand.",
      },
      {
        q: "Can I run OpenClaw and Hermes side by side while I test?",
        a: "Yes, on separate computers. Keep the existing OpenClaw bot running, launch Hermes on a separate Hivra computer, and avoid pointing both at the same production accounts or tokens. Every Hivra Cloud computer is paid, so a second computer is a second monthly price.",
      },
      {
        q: "Does a Hivra computer keep running when I close the browser?",
        a: "Yes. A paid Hivra Cloud computer stays on and is not paused for inactivity. Hermes, OpenClaw and Agent Zero run on the computer itself, so none of them needs an open browser.",
      },
      {
        q: "Can I move back from Hermes to OpenClaw?",
        a: "OpenClaw's own documentation describes importing a Hermes setup (openclaw migrate hermes --dry-run previews it). It needs a fresh OpenClaw setup, and items such as pre-registered OAuth client settings go to manual review, so keep your original files until you have checked the result.",
      },
      {
        q: "Which is better, OpenClaw or Hermes?",
        a: "Neither wins everywhere. Hermes suits people who want its approach to skills, memory and recurring tasks. OpenClaw suits people with working messaging integrations and schedules they do not want to rebuild. Hivra hosts both, so the hosting choice does not have to decide it.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-self-hosted", "ai-agent-hosting-alternatives", "vs-railway"],
      blog: ["what-is-hermes-agent", "self-hosting-hermes-guide"],
      features: [{ slug: "openclaw-alternative", label: "OpenClaw alternative" }, { slug: "persistent-memory", label: "Persistent memory" }],
      agents: ["openclaw", "hermes"],
      docs: ["openclaw", "hermes"],
      pricing: true,
    }),
  },

  "ai-agent-hosting-alternatives": {
    slug: "ai-agent-hosting-alternatives",
    browserTitle: "AI agent hosting in 2026: choose the kind of computer first | Hivra",
    h1: "AI agent hosting in 2026: choose the kind of computer first",
    metaDescription: `Fly Sprites, E2B, Railway, Orgo, Cloudways, a VPS or Hivra: which kind of computer suits an AI agent, with prices. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "There is no useful “best AI agent host” until you say what you are hosting. An assistant you open every day and expect to find as you left it is one job. A code interpreter that a product starts for thirty seconds per customer request is another. A browser-driven desktop that an agent clicks through is a third. Each is sold by a different kind of provider, billed in a different way, and breaks in a different way when you pick the wrong one.",
          `This page sorts the options by the kind of computer they give you: metered computers that sleep (Fly Sprites), short-lived sandboxes you create from code (E2B), desktops for computer-use agents (Orgo), managed agent servers (Cloudways and DigitalOcean), a platform's virtual machines (Railway), a plain server you run yourself (Hetzner, DigitalOcean Droplets), and Hivra, which gives an agent a computer of its own at a fixed monthly price. Vendor figures are as of ${formatCheckedMonth()}. Where the other option is the better choice, the page says so.`,
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: [
          {
            kind: "p",
            text: "Three things sit inside any hosting price: the compute, the disk that keeps your files, and the time until the machine goes away. Providers differ most on the third. Some bill only while the computer is working, some keep it on all month, and some delete it after a session. Model usage is a separate bill on almost all of them, so add it to every figure below.",
          },
          {
            kind: "entries",
            items: [
              {
                lead: "Fly Sprites and E2B:",
                text: `Built for programmatically creating working environments. E2B is aimed at short-lived code sandboxes, while Fly describes Sprites as persistent computers whose disk survives sleep. Fly bills a Sprite by the hour of actual use: $0.0385 per CPU-hour, $0.021875 per GB-hour of memory and about $0.50 per GB-month of hot storage, with nothing charged for a Sprite that is doing nothing beyond its storage. Its own examples are $0.23 for a four-hour Claude Code session and $1.05 a month for a web app awake 30 hours. Fly's example is its own assumption, not a typical bill. It also sells subscription plans, Hero at $100 a month with usage allowances included. E2B bills by the second, about $0.17 an hour for a default 2 vCPU, 4 GiB sandbox by our arithmetic from its rates. Hobby has a $100 one-time usage credit and sessions up to 1 hour. Pro is $150 a month plus usage, with sessions up to 24 hours. Pausing and resuming resets the session limit. A pause can fall back to filesystem-only and lose memory. We found no pause storage price on the pages we read.`,
              },
              {
                lead: "Orgo:",
                text: "Desktops for agents that use a screen. Orgo lists a Medium computer (2 vCPU, 8 GB, 40 GB disk) at $0.055 an hour running and a fraction of that stopped, and says that by the hour it comes to about $40 a month. Its $29 monthly plan keeps one Medium always on, and it states that paid plans are never auto-suspended.",
              },
              {
                lead: "Cloudways Managed AI Agents and DigitalOcean:",
                text: "More integrated options, particularly for teams already paying those providers. Cloudways lists four sizes: Scout at $9.99 a month (1 vCPU, 2 GB, 50 GB), Operator at $19.99 (2 vCPU, 4 GB, 80 GB), Squad at $39.99 (4 vCPU, 8 GB, 160 GB) and Swarm at $79.99 (8 vCPU, 16 GB, 320 GB). It includes 50 to 320 GB of storage and says model usage is billed separately by your AI provider. Its page currently advertises a Black Friday code, BFCM802, for 80% off the first 2 months, with the end date shown as both December 4 and December 6, so the prices quoted here are the regular monthly prices. For like-for-like sizes, Operator at $19.99 (2 vCPU, 4 GB) and Squad at $39.99 (4 vCPU, 8 GB) match the sizes of Hivra's two plans. DigitalOcean sells a 2 vCPU, 4 GiB Droplet at $24 a month that you run yourself, and agent products it describes as public preview, with CPU billed on use.",
              },
              {
                lead: "Railway:",
                text: "A deployment platform. Its containers bill at $20 per vCPU and $10 per GB of RAM per month, but sandboxes and cloud agents run on Railway's virtual machine primitive, which its plans page bills at higher VM rates of $50 per vCPU and $50 per GB of RAM per month at full use, so the VM rates are the ones that apply to an agent host. Its Free VM is a machine with coding agents preinstalled, with 2 vCPU, 2 GB, 24 hours to claim it and a shared $3 AI budget. A Free VM you do not claim within 24 hours is deleted with its files, and we did not find what happens to a claimed one. Useful for trying an agent, so keep anything important elsewhere until you know.",
              },
              {
                lead: "A plain VPS:",
                text: "Full root control and responsibility for the whole machine, often with the lowest direct infrastructure cost. Hetzner lists a 2 vCPU, 4 GB cost-optimized server from €5.99 a month before VAT, though the row showed as unavailable when we looked, and Hetzner says the number of available cost-optimized servers is limited. What the price leaves out is the assembly, the updates and the security of the box.",
              },
            ],
          },
        ],
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          `Hivra gives each agent a computer of its own, and you open it: a terminal, files and a browser sit beside the agent in the dashboard. It is aimed at developers and AI power users who want to keep their own agent running on a predictable monthly computer, rather than assemble one. The agents are ${HIVRA_AGENTS_CELL}. Claude Code and Codex are the vendors' own command line tools. Hivra is independent and is not affiliated with or endorsed by the vendors named on this page, Anthropic, OpenAI or Nous Research.`,
          `The price is ${ENTRY_PRICE_PROSE}, or ${formatPlanSize("larger")}, before AI model spending, with a ${REFUND_LINKED}. ${STAYS_ON} ${AI_USAGE} A Hivra account costs nothing and works with a server you connect yourself, while every Hivra Cloud computer is paid.`,
          "The trade is plain. Hivra is not an API that creates thousands of isolated per-request sandboxes, it is not a screen-driving product built for computer-use agents through an API, and it does not give SSH access to a Hivra Cloud computer. If your need is a persistent agent you open and use every day, a fixed price and a prepared environment are the point.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Choose a sandbox API such as E2B when your product needs a fresh environment per job or per customer. Creating and discarding environments from code is what it is built for, and a monthly computer is the wrong shape for it. Choose Fly Sprites when the agent works in bursts: a computer that is billed mostly while it runs can cost far less than a fixed price. Fly's own example, at an average of 30% of 2 CPUs and 1.5 GB, costs $0.23 for four hours. A busier agent costs more, and a sleeping Sprite still pays for the storage it uses. Its disk survives sleep, so the files are there when it wakes.",
          "Choose Orgo when the agent has to operate a screen. A graphical desktop with a browser, reachable by API, is a different tool from a terminal workspace, and a general-purpose computer should not be assumed to replace it. Test it against your own task first.",
          "Choose a VPS when you have strong Linux skills and want root, a location of your choice or the lowest bill. Hetzner and DigitalOcean give you that control, and it comes with the upkeep. Choose Cloudways or DigitalOcean when your team already pays them and wants the agent under the same account. And if you are only trying an agent for an afternoon, Railway's Free VM is built for that.",
        ),
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and the other hosting options compared",
            rows: [
              { criterion: "Price model", hivra: "Flat monthly price per computer", alternative: "Varies: Fly and E2B meter by usage (E2B Pro adds $150 a month), Orgo by the hour or $29 a month, Cloudways and Railway by plan or usage, a VPS by the month" },
              { criterion: "What you get", hivra: "A computer of its own with the agent set up, opened from the dashboard", alternative: "Metered computers (Fly), sandboxes (E2B), desktops (Orgo), managed agent servers (Cloudways), or a bare Linux server" },
              { criterion: "What stays on", hivra: STAYS_ON, alternative: "Fly: a Sprite goes warm or cold when idle and is not billed. E2B: sessions end after 1 hour on Hobby and 24 hours on Pro. Orgo: paid plans are never auto-suspended. Cloudways says its servers are persistent" },
              { criterion: "Persistence", hivra: "Files, sessions and login stay on the computer while it exists. No backup promise", alternative: "Fly disk survives sleep, but checkpoints restore files, not running processes. E2B pause keeps files and memory. Orgo and Cloudways keep disks. Railway Free VM is deleted if unclaimed" },
              { criterion: "Agents supported", hivra: HIVRA_AGENTS_CELL, alternative: "Fly lists Claude Code, Codex, OpenClaw, Hermes and more. Cloudways lists OpenClaw and Hermes but its FAQ says OpenClaw only. E2B, Orgo and a VPS run whatever you install" },
              { criterion: "Hermes-specific tooling", hivra: "Check the Hivra agent catalog for whether Hermes can be launched today, and on which plan", alternative: "Hermes brings its own dashboard on any host. Fly lists Hermes among its agents" },
              { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Not part of the hosting price on these. Cloudways says model usage is billed by your AI provider" },
              { criterion: "Price of the entry size", hivra: "$9.99/month for 2 vCPU and 4 GB RAM, or $19.99/month for 4 vCPU and 8 GB RAM", alternative: "Cloudways Scout $9.99/mo is 1 vCPU and 2 GB, so the like-for-like sizes are Operator $19.99/mo for 2 vCPU and 4 GB and Squad $39.99/mo for 4 vCPU and 8 GB. Hetzner 2 vCPU, 4 GB from €5.99/mo before VAT (shown unavailable). DigitalOcean Droplet 2 vCPU, 4 GiB $24/mo" },
              { criterion: "Access method", hivra: "Open the computer in the dashboard: terminal, files, browser. No SSH", alternative: "Fly: CLI, REST API, SDKs, MCP server and per-Sprite URLs. E2B: SDK. Orgo: desktop, API and CLI. Cloudways: dashboard, terminal and SSH. A VPS: SSH" },
              { criterion: "Browser automation", hivra: "A Browser tab on the computer. Which agents use it for automation depends on the agent", alternative: "Orgo desktop-native; others DIY or bundled tools" },
              { criterion: "Scheduled tasks", hivra: "Native agent scheduling", alternative: "DIY on a VPS, Railway, Render or serverless; Hermes has its own cron and OpenClaw has its own scheduler" },
              { criterion: "Setup effort", hivra: "Launch from the dashboard. No server to administer", alternative: "Low on managed hosts, CLI or API work on Fly and E2B, full server work on a VPS" },
              { criterion: "Who maintains it", hivra: "Hivra runs the computer. Agent updates are yours, from the Manage tab where offered", alternative: "The provider runs the platform on managed options. On a VPS you maintain the whole machine" },
              { criterion: "Data and security", hivra: "Each agent runs on its own computer, isolated from other customers' computers. No external attestation or compliance certification is claimed", alternative: "Fly describes hardware-isolated microVMs. Cloudways describes a dedicated instance per customer. Other pages are not covered here, so read them" },
              { criterion: "Limits", hivra: "The plan's compute is shared by the agent computers on one account", alternative: "Fly: 100 GB volume per Sprite. E2B: 10 GiB disk on Hobby, 20 GiB on Pro. Orgo: sizes up to 150 GB disk" },
              { criterion: "Exit and portability", hivra: "Your files are on the computer you can open. Copy out what you need", alternative: "Fly describes a standard POSIX filesystem. A VPS gives you root. We found no export statement for Orgo. Cloudways keeps the latest backup 14 days after an instance is deleted" },
              { criterion: "Money-back guarantee", hivra: `Yes: ${REFUND_LINKED}`, alternative: "Not stated on the pages we read for Fly, E2B and Cloudways. Orgo states that credit-paid amounts are not refunded. Check each vendor's terms" },
              { criterion: "Best for", hivra: "A fixed bill and an agent you open and keep using", alternative: "Fly: bursty work. E2B: per-job sandboxes. Orgo: desktop control. VPS: root and lowest cost" },
            ],
          },
        ],
      },
      {
        heading: "Who should pick which",
        blocks: [
          {
            kind: "entries",
            items: [
              { lead: "Maya, who runs a SaaS product that starts an isolated environment for every customer job:", text: "Pick E2B. Creating a sandbox per request from code is what it is for, and a monthly computer is the wrong shape. Hivra does not offer a sandbox API." },
              { lead: "Priya, a developer who wants Claude Code on a machine that stays on, reachable from any laptop:", text: `Pick Hivra. It is ${ENTRY_PRICE_PROSE}, the computer is not paused for inactivity, and you open its terminal and files without assembling anything. Hivra offers no SSH and no backup promise. If you are comfortable with a server and want root, a VPS or Cloudways, at $19.99 a month for 2 vCPU and 4 GB or $39.99 for 4 vCPU and 8 GB, is the alternative.` },
              { lead: "Sam, who runs a coding agent a few times a week and would rather pay nothing while it is idle:", text: `Pick Fly Sprites. It bills for compute only while a Sprite is running, its disk survives sleep, and Fly's own example, at an average of 30% of 2 CPUs and 1.5 GB, puts a four-hour Claude Code session at $0.23. If it runs 40 hours in a month at that load, the compute is still well below ${ENTRY_PRICE_PROSE}, but run it hot all day and compare with the plan, and remember that stored data is billed while it sleeps.` },
              { lead: "Chloe, whose agent has to click through a desktop browser and a few GUI-only tools:", text: "Pick Orgo. It is built around graphical desktops that agents drive, and Hivra is not built as a desktop API for computer-use agents." },
              { lead: "Tomás, who is comfortable with Linux and wants root, a chosen location and the lowest bill:", text: "Pick a VPS from Hetzner or DigitalOcean. The server price can be lower than Hivra's, and the updates, firewall and security of the box are yours." },
              { lead: "Marcus, who wants Hermes working on a schedule with its files and memory kept in one place:", text: "Hermes has its own cron and brings its own dashboard, so it runs on any host that gives it a persistent disk. Fly lists Hermes among its agents, and a VPS runs it with full root control. Check the Hivra agent catalog before planning around Hivra, because what can be launched there changes as releases ship, and compare a full month including model usage." },
              { lead: "Raj, who runs a Proxmox server at home and uses Claude Code or OpenClaw:", text: "Pick Hivra with a free account and connect that server, so those agents run on hardware he owns. A free account works with a server you connect; Hermes runs on Hivra Cloud only." },
            ],
          },
        ],
      },
      {
        heading: "How to try both",
        blocks: [
          {
            kind: "steps",
            items: [
              { lead: "Pick one real workload.", text: "An ordinary task, a scheduled task and a task that writes a file. Use the same agent on every option so the comparison is about the host." },
              { lead: "Run it on the alternative.", text: "On Fly, E2B or Orgo, use the starting credit the vendor offers and watch the usage page after a day idle and a day working. On a VPS or Cloudways, start the smallest size." },
              { lead: "Run it on Hivra.", text: `Create an account, launch the agent on a paid Hivra Cloud computer at ${ENTRY_PRICE_PROSE}, and open its terminal and files. The ${REFUND_LINKED} covers the test if you decide against it.` },
              { lead: "Restart both.", text: "Stop and wake the Sprite or sandbox, restart the Hivra computer, then confirm files, credentials and task history survived on each." },
              { lead: "Count model usage separately.", text: "Hosting prices on these options do not include it. Add it to each side so the month is a real number." },
              { lead: "Decide, then clean up.", text: "Take the cheaper full month you also trust. Delete the test machines so their usage stops, and copy out any file you need." },
            ],
          },
        ],
      },
      {
        heading: "What survives, and for how long",
        blocks: [
          {
            kind: "entries",
            items: [
              { lead: "On Fly Sprites:", text: "The disk survives sleep with the same paths and contents. Automatic checkpoints restore files but not running processes. A Sprite stays awake for an open request, a connected session or an active task, and Fly says redirecting output to a file or detaching tmux does not count, so a background agent can go to sleep." },
              { lead: "On E2B:", text: "Its docs say a paused sandbox saves the filesystem and memory, including running processes, and is kept indefinitely until you delete it. A running session ends after 1 hour on Hobby and 24 hours on Pro." },
              { lead: "On Orgo, Cloudways and Railway:", text: "Orgo says paid-plan computers are always on and never auto-suspended, and a stopped computer keeps its disk. Cloudways says it runs agents on persistent servers and keeps the latest backup for 14 days after an instance is deleted. Railway's Free VM is deleted with its files if nobody claims it." },
              { lead: "On Hivra:", text: `${CLI_RUN_LIFETIME} Hivra does not promise backups, so copy out anything you cannot lose, on any host.` },
            ],
          },
        ],
      },
      cautionSection(COMPETITOR_FACTS_CHECKED),
    ],
    sources: priceSources(
      [
        { label: "Fly Sprites", href: "https://fly.io/sprites" },
        { label: "E2B pricing", href: "https://e2b.dev/pricing" },
        { label: "E2B sandbox persistence docs", href: "https://e2b.dev/docs/sandbox/persistence" },
        { label: "Orgo pricing", href: "https://www.orgo.ai/pricing.md" },
        { label: "Cloudways Managed AI Agents", href: "https://www.cloudways.com/en/managed-ai-agents.php" },
        { label: "Railway free VM", href: "https://railway.com/free-vm" },
        { label: "Railway plans", href: "https://docs.railway.com/pricing/plans" },
        { label: "DigitalOcean Droplet pricing", href: "https://www.digitalocean.com/pricing/droplets" },
        { label: "DigitalOcean Agent Droplets pricing", href: "https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/details/pricing/" },
        { label: "Hetzner Cost-Optimized cloud", href: "https://www.hetzner.com/cloud/cost-optimized/" },
      ],
      [
        "The E2B hourly figure is our own arithmetic from its per-second rates, not an E2B quote. Fly's Hero plan and its other tiers are subscriptions with allowances, and only Hero's price is quoted here. Cloudways advertises the Black Friday code BFCM802 for 80% off the first 2 months, shows the end date as both December 4 and December 6, and its page lists Hermes as available in one place and says OpenClaw only in an FAQ. Hetzner's CX23 row showed as currently unavailable.",
        "We did not find a refund policy on the Fly, E2B or Cloudways pages we read, and Orgo's page states only specific non-refund rules, such as credit-paid amounts, so the page does not compare guarantees like for like. Orgo's page was read only in part. Fly's page does not list regions for Sprites, and we did not read security or compliance pages for any of these vendors. DigitalOcean's agent products are in public preview. Railway, DigitalOcean and Hetzner figures were re-read on 2026-11-17.",
      ],
      true,
    ),
    faqs: [
      {
        q: "Which AI agent hosting option is cheapest?",
        a: `It depends on how busy the agent is. A metered computer such as a Fly Sprite is billed only while it runs, so a mostly idle agent can cost very little, while a VPS or a managed plan is a fixed monthly price. Hivra is ${ENTRY_PRICE_PROSE}. None of these include model usage.`,
      },
      {
        q: "Which is best for many short-lived tasks?",
        a: "A sandbox or metered-compute API may suit that workload better than a monthly always-on computer. E2B bills by the second and is aimed at short-lived code sandboxes, and Fly Sprites bill by actual use.",
      },
      {
        q: "Can I use a free VM for a persistent agent?",
        a: "Some free environments expire or sleep. A Railway Free VM you do not claim within 24 hours is deleted with its files, and we did not find what happens to a claimed one. Check persistence, quotas and deletion policies before relying on one.",
      },
      {
        q: "What is the difference between a sandbox and a persistent computer?",
        a: "A sandbox is created for a job and discarded, with sessions that end after a set time, such as 1 hour on E2B Hobby. A persistent computer keeps its files and login between sessions. Fly Sprites sleep when idle but keep their disk, and a Hivra Cloud computer stays on.",
      },
      {
        q: "Which hosting suits a browser or desktop agent?",
        a: "Orgo is built around graphical desktops that agents drive through an API. A Hivra computer is a different tool, not a desktop API for computer-use agents, so test a desktop product against your own task.",
      },
      {
        q: "Can I use Hivra and another host together?",
        a: "Yes. Keep per-job sandboxes on an API such as E2B, a web application on a platform such as Railway, or a server you manage on a VPS, and run the persistent agent on Hivra, connected through authenticated interfaces.",
      },
      {
        q: "Does the Hivra price include AI usage?",
        a: `No. ${AI_USAGE}`,
      },
      {
        q: "Can I keep an agent running 24/7 on each option?",
        a: `On Hivra, ${STAYS_ON} On Fly a Sprite goes warm or cold when idle, and Fly says redirecting output to a file or detaching tmux does not keep it awake. E2B sessions end after 1 hour on Hobby and 24 hours on Pro, and Orgo says paid plans are never auto-suspended.`,
      },
      {
        q: "Is a VPS a better choice than Hivra?",
        a: "If you have strong Linux skills and want root access and the lowest server price, a VPS can be the better choice, and the updates and security of the machine are yours. Hivra suits people who want the agent set up and the computer kept running without administering a server.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-fly-sprites", "vs-e2b", "vs-self-hosted", "vs-railway"],
      blog: ["ai-agent-hosting-guide", "managed-vs-self-hosted-ai-agents", "cost-of-running-ai-agent"],
      agents: ["hermes", "claude-code"],
      docs: ["plans-and-billing"],
      pricing: true,
      extra: [{ label: "Cost calculator", href: HOSTING_COST_CALCULATOR_HREF }],
    }),
  },
};
