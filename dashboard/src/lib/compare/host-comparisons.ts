import type { ComparePage } from "./types";
import { ENTRY_PLAN_PRICE, formatPlanSize } from "@/lib/blog/plan-facts";
import { CLI_RUN_LIFETIME, SERVER_SIDE_AGENTS_KEEP_WORKING } from "@/lib/blog/runtime-facts";
import { COMPETITOR_FACTS, COMPETITOR_FACTS_CHECKED, formatCheckedMonth, type CompetitorSlug } from "./competitor-facts";
import {
  AI_ACCESS_CELL,
  AI_USAGE,
  CLOSING,
  DECISION_SECTION,
  ENTRY_PRICE_PROSE,
  HIVRA_AGENTS_CELL,
  HOSTING_COST_CALCULATOR_HREF,
  REFUND_LINKED,
  STAYS_ON,
  PRICES_AS_OF_STAMP,
  cautionSection,
  paragraphs,
  priceSources,
  relatedLinks,
} from "./shared-copy";

/**
 * Comparison pages against the four hosts people search for by name. Every
 * competitor number here is in competitor-facts.ts with its source and check
 * date; a test keeps the two in step. Each page says where the other host is
 * the better choice, because a comparison that only flatters us is not one a
 * reader or an answer engine will trust.
 *
 * The wording is the October 2026 copy (scratchpad batches/b04, files 04, 05, 06
 * and 10), with these corrections that the claim audit of 2026-10-20 required:
 * nothing is stated as fact that a vendor's own pages contradict or no longer show,
 * and no line talks about "the source". Where a figure here is behind the vendor's
 * live page (Hostinger's sale prices for the managed plan and KVM 2, Nous Portal prices) the copy says so.
 * Refreshed 2026-10-21: Hostinger $4.99 and $8.79, Agent 37 plans up to $99.99, Nous prices called the last published,
 * and Paperclip added to xCloud's agents (xcloud.host/paperclip-hosting/).
 *
 * Copy rules that matter here: Hivra sizes are always stated as price plus size
 * ($9.99 is 2 vCPU and 4 GB, $19.99 is 4 vCPU and 8 GB); the guarantee is
 * 7 days on card payments only; no trial, no timing claims, no backup promise.
 */

const sourcesFor = (slug: CompetitorSlug) => COMPETITOR_FACTS[slug].sources;

export const HOST_COMPARISONS: Record<CompetitorSlug, ComparePage> = {
  "vs-agent-37": {
    slug: "vs-agent-37",
    browserTitle: "Agent 37 vs Hivra: a meter or a monthly computer? | Hivra",
    h1: "Agent 37 vs Hivra: a meter or a monthly computer?",
    metaDescription: `Hivra is ${ENTRY_PRICE_PROSE}. Agent 37 lists $4.76 a month, always on. Where each wins. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          `Agent 37 and Hivra both give an agent a machine that does not depend on your laptop, and they charge for it in opposite ways. Agent 37's Cloud API is a meter: you fund a prepaid balance, and compute and disk draw it down by the minute, with no plan fee. Hivra is a monthly computer, ${ENTRY_PRICE_PROSE}, a fixed figure whether the agent is busy or idle. For a standard, shared sandbox with 2 vCPU, 4 GB and 4 GB of disk running 730 hours, Agent 37 states $4.76 and Hivra is ${ENTRY_PLAN_PRICE}.`,
          "It is not the whole story, because the two sell different things around the meter. Agent 37 is built for products and teams that create sandboxes through an API, and it also sells flat managed plans for individuals. Hivra is built for a developer or AI power user who wants a computer of its own for an agent, one you open and work in, and a bill that does not move. The useful question is what your agent does all month and whether you want the bill to follow it.",
          "Shopping for a personal agent rather than a sandbox API? [Compare the Agent 37 Personal tiers](/compare/agent37) with Hivra Cloud by price, storage, uptime and included AI.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          `On Agent 37's metered Cloud API the rate card is $0.80 per vCPU, $0.70 per GB of RAM and $0.09 per GB of disk, per 730-hour month, metered by the minute. Its pricing page calls the entry figure an estimate, not a subscription: a standard 2 vCPU, 4 GB sandbox with 4 GB of persistent disk is $4.76 for 730 running hours, $0.36 of it disk, (figures as of ${formatCheckedMonth()}). The page shows no total for a larger shape: on our arithmetic from the rate card, a 4 vCPU, 8 GB sandbox with 6 GB of disk would be about $9.34 for the same hours. A standard sandbox shares host resources. A VM, which its pages describe as a whole Linux machine with its own kernel, costs 2.5 times the compute rate, and a Performance sandbox on dedicated cores costs 4 times. Disk stays the same price. By our arithmetic from its rate card, the 2 vCPU, 4 GB shape as a VM would be about $11.36 for 730 running hours, so compare like with like before you compare it with Hivra.`,
          "A meter bills what the machine does, so read what it bills while the agent waits. Compute stops when a sandbox sleeps, but disk keeps billing while it is retained, and Agent 37's terms say usage is metered against the balance including while an instance is stopped or sleeping. An awake instance pays for compute even when idle, so an agent that is asked for something once an hour gains little from being awake all month unless it is set to sleep. Deleting an instance stops the meter. Hosting also leaves out models and tools, which are metered from the same balance with a per-instance spend cap, or you bring your own keys.",
          "Three terms matter when you plan a month on a prepaid balance. Auto top-up is on by default after your first top-up. If the balance runs out, Agent 37 says it may pause your instances until you top up. And top-ups are non-refundable, outside the first-month subscription refund described below. None of these is unusual for a meter, so set a balance alert before you rely on it. New accounts also get a $5 starter credit after adding a card, which Hivra has no equivalent of, and the pricing page carries a price-match offer to refund the difference on a cheaper sandbox, with no published terms.",
          `Hivra's price is a different shape. ${ENTRY_PRICE_PROSE} buys a computer for the agent, and ${formatPlanSize("larger")} buys more room. You split the plan's vCPU and RAM across your agents. ${AI_USAGE} AI usage is paid separately, so a Hivra month can move too. A Hivra account costs nothing and works with a server you connect yourself, while every Hivra Cloud computer is paid.`,
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          `Hivra gives each agent a computer of its own, and you open it: a terminal, files and a browser sit beside the agent in the dashboard, and the agents are the ones people already use. ${HIVRA_AGENTS_CELL}. Claude Code and Codex are the vendors' own command line tools, and Hermes is the Hermes Agent installed with its own installer on your Hivra computer. Hivra is independent and is not affiliated with Agent 37, Anthropic, OpenAI or Nous Research.`,
          `The fit is a person who wants the cost fixed and the machine kept on. ${STAYS_ON} Agent 37 says it may pause instances when the balance runs out, and auto top-up is on by default after the first top-up, so set a balance alert there. The price is ${ENTRY_PRICE_PROSE}, or ${formatPlanSize("larger")}, with a ${REFUND_LINKED}. There is no balance to watch, no auto top-up and no instance to remember to put to sleep. The trade is plain: if your agent is idle most of the month, a meter will usually charge less than a fixed price, and on raw compute Agent 37's standard sandbox is cheaper.`,
          "Assurance is the other difference. Agent 37's site states SOC 2 Type I, with Type II in progress, and its trust centre lists SOC 2 as in progress. Its privacy policy says the Type I report and a readiness report are available to business customers on request under an NDA, so ask for the report rather than assuming it. Hivra claims no external attestation. Open source code is not equivalent to an audit, and this page does not pretend it is.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Choose Agent 37 when your usage pattern is the point, because a meter helps when the machine is mostly idle: a sandbox that sleeps costs only its disk, and a job that runs briefly each day costs only that compute. Its standard 2 vCPU, 4 GB sandbox is also cheaper than Hivra for an always-on agent, and its managed plans start at $3.99 a month.",
          "Choose it too if you are building a product where each customer gets an agent. It has a REST API for sandboxes and agents, its terms say you are welcome to build the Service into your own product, but reselling bare access needs a written agreement, and it will create and delete instances by the minute, which a fixed monthly computer does not do. Hivra is not built for that.",
          "Choose it if a vendor can hand you a SOC 2 Type I report under an NDA and that is what your buyer asks for. And choose it if you want a free managed agent to try something: Agent 37's free agent (1 vCPU, 4 GB of RAM and 2 GB of storage, with messaging apps only on Basic and above) sleeps after 15 minutes idle and wakes when you message it, with a card on file and nothing charged. The Cloud API also gives a $5 starter credit after you add a card. Neither option makes unsafe agent permissions safe.",
        ),
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and Agent 37 compared",
            rows: [
              {
                criterion: "Price model",
                hivra: "Fixed monthly price for a computer",
                alternative: "Cloud API: prepaid balance, metered by the minute, no plan fee. Managed plans: flat monthly, from $3.99/mo",
              },
              {
                criterion: "Always-on 2 vCPU, 4 GB",
                hivra: `${formatPlanSize("entry", "compact")}`,
                alternative: "$4.76/mo for 730 running hours on a standard, shared sandbox, including 4 GB of disk. A VM from Agent 37 with the same listed resources is about $11.36 by our arithmetic from its rate card",
              },
              {
                criterion: "Always-on 4 vCPU, 8 GB (our arithmetic)",
                hivra: `${formatPlanSize("larger", "compact")}`,
                alternative: "About $9.34/mo for 730 running hours on a standard sandbox, with 6 GB of disk, on our arithmetic from its rate card. Its pricing page shows no total for this shape",
              },
              {
                criterion: "What you get and how you reach it",
                hivra: "A computer of its own: you open the agent with a terminal, files and a browser beside it",
                alternative: "A sandbox or VM with a task board, web terminal, file browser, live desktop and scheduled jobs, plus a REST API. WhatsApp, Telegram, Discord and Slack on Basic and above",
              },
              {
                criterion: "What stays on",
                hivra: STAYS_ON,
                alternative: "A sleeping sandbox stops compute. Its pages say a paid managed agent stays up between scheduled jobs. The free managed agent sleeps after 15 minutes idle",
              },
              {
                criterion: "Persistence",
                hivra: "Files, sessions and login stay on the computer while it runs. No backup promise",
                alternative: "Disk is kept while the instance exists and keeps billing while asleep. Its docs describe backup and restore to an earlier version",
              },
              { criterion: "Agents hosted", hivra: HIVRA_AGENTS_CELL, alternative: "Hermes, OpenClaw, Claude Code, Codex, OpenCode, Grok, or your own Docker image" },
              {
                criterion: "Models and AI cost",
                hivra: AI_ACCESS_CELL,
                alternative: "Not in the hosting price. Managed models are metered from the same balance with a per-instance spend cap, or bring your own keys. Managed plans bundle some model credit",
              },
              {
                criterion: "Setup effort",
                hivra: "Launch from the dashboard. No server to administer",
                alternative: "Create an instance in the dashboard or by API, then set auto-sleep and your own balance alerts",
              },
              {
                criterion: "Who maintains it",
                hivra: "Hivra runs the computer. Agent updates are yours, such as the Update Hermes button on the Manage tab",
                alternative: "Agent 37 runs the platform. Its pages do not name the infrastructure provider or hosting regions",
              },
              {
                criterion: "Data and security",
                hivra: "No external attestation claimed",
                alternative: "Says it does not collect or review prompts, responses or file contents, and encrypts in transit and at rest. SOC 2 Type I stated, Type II in progress. Ask for the report",
              },
              {
                criterion: "Limits",
                hivra: "You split the plan's vCPU and RAM across your agents",
                alternative: "Memory running at once is capped: 32 GB before the first top-up, 40 GB after, 200 GB at $50 of total top-ups, then more with email. Sleeping sandboxes do not count",
              },
              {
                criterion: "Refund",
                hivra: REFUND_LINKED,
                alternative: "A subscription is refunded in full if you ask in the first month and before the second billing cycle. Fees and prepaid top-ups are otherwise non-refundable",
              },
              {
                criterion: "Exit and portability",
                hivra: "Your files are on the computer you can open. Copy out what you need",
                alternative: "Workspace is plain files, downloadable from the file browser or terminal. A deleted Cloud instance leaves a recovery copy for a week",
              },
              { criterion: "Open source and self-host", hivra: "Open source, with the code on [GitHub](https://github.com/ashneil12/hivra). Self-hosting the whole platform is a preview", alternative: "Its pages we read do not mention a self-hosted release" },
              {
                criterion: "Best for",
                hivra: "A fixed bill and a machine you open and keep using",
                alternative: "Intermittent work, products with an agent per customer, and buyers who want a SOC 2 report",
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
                lead: "Maya, who is building a product that gives every customer an agent:",
                text: "Pick Agent 37. It has an API for sandboxes and agents, and its terms welcome building the Service into your own product, though reselling bare access needs a written agreement. Hivra is not built to create and delete machines for your customers.",
              },
              {
                lead: "Daniel, who needs an agent for a short job each Friday and nothing the rest of the week:",
                text: "Pick Agent 37's meter. A sandbox that sleeps stops compute and costs only its disk, so a brief weekly job costs far less than a monthly price. Set auto-sleep and a balance alert.",
              },
              {
                lead: "Priya, a developer who wants Claude Code on a machine that stays on, reachable from any laptop:",
                text: `Pick Hivra. It is ${ENTRY_PRICE_PROSE}, the computer is not paused for inactivity, and you open its terminal and files rather than managing a balance. Agent 37 lists Claude Code too and is a sound choice if you would rather meter it.`,
              },
              {
                lead: "Tom, an AI power user who wants to know next month's bill before it starts:",
                text: "Pick Hivra for the hosting part. The monthly price does not move with activity, while a meter plus an auto top-up and metered model usage can. Hivra credits for AI usage also vary, so budget model usage either way.",
              },
              {
                lead: "Sam, a founder whose customer asks for a vendor's SOC 2 report:",
                text: "Pick Agent 37 and ask for the report. Its pages state SOC 2 Type I with Type II in progress, and its privacy policy offers the reports under an NDA. Hivra claims no external attestation.",
              },
              {
                lead: "Lena, a hobbyist who wants to try an agent before spending anything:",
                text: "Start with Agent 37's free managed agent, which sleeps when idle and has 1 vCPU, 4 GB of RAM, 2 GB of storage and no messaging apps (those start on Basic). The Cloud API also gives a $5 starter credit after you add a card. A Hivra account costs nothing, but every Hivra Cloud computer is paid, so the free route on Hivra is a server you connect yourself.",
              },
              {
                lead: "Raj, who already runs a Proxmox server at home:",
                text: "Pick Hivra with a free account and connect that server, so the agents run on hardware you own. Agent 37 hosts instances on its own platform, and its pages do not describe a way to connect your own machine.",
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
                lead: "Run it on Agent 37.",
                text: "Fund a small balance, since top-ups are not refundable, create a standard 2 vCPU, 4 GB sandbox, set auto-sleep and check the auto top-up setting before you leave it. Note what the balance shows after a day of idle and after a day of work.",
              },
              {
                lead: "Run it on Hivra.",
                text: `Create an account, launch the agent on a paid Hivra Cloud computer at ${ENTRY_PRICE_PROSE}, and open its terminal and files. Hivra's ${REFUND_LINKED} covers the test if you decide against it.`,
              },
              { lead: "Restart both.", text: "Restart the environment, then confirm the files, credentials and task history are still there on each." },
              { lead: "Count model usage separately.", text: "Neither price includes it. Add it to each side so the month is a real number." },
              {
                lead: "Decide, then clean up.",
                text: "Take the cheaper full month that you also trust. Delete the test sandbox on Agent 37 so the meter stops, and remember its deleted-instance recovery copy lasts a week.",
              },
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
                lead: "On Agent 37:",
                text: "Files and keys live in your container, and its docs say stop and restart keep files. A sleeping instance keeps its disk and keeps billing for it. The free managed agent is removed after 30 days asleep, with an email a week before. A deleted Cloud instance leaves a recovery copy for a week, then it is purged. Account deletion removes data within 30 days except legal and tax records. If a balance runs out, its terms say it may pause your instances until you top up. The pages we read do not say how long a paused instance's data is kept, so ask before relying on it.",
              },
              {
                lead: "On Hivra:",
                text: `${CLI_RUN_LIFETIME} Hivra does not promise backups, so copy out anything you cannot lose, on either host.`,
              },
              {
                lead: "Other agents on Hivra:",
                text: SERVER_SIDE_AGENTS_KEEP_WORKING,
              },
            ],
          },
        ],
      },
      cautionSection(COMPETITOR_FACTS_CHECKED),
    ],
    sources: priceSources(sourcesFor("vs-agent-37"), [
      "Also on Agent 37's pages: flat managed plans from $3.99 a month (1 vCPU and 4 GB of RAM), through $9.99 a month, then $29.99 a month (2 vCPU and 8 GB of RAM), to $99.99 a month for teams (4 vCPU and 16 GB of RAM), and a free managed agent that sleeps when idle and is removed after 30 days asleep.",
      "Nothing quoted above is a sale price or sits behind a sign-in. The $4.76 figure is an estimate Agent 37 publishes for 730 running hours of a standard sandbox. The $9.34 and $11.36 figures are our own arithmetic from its published rate card (with 6 GB of disk assumed for the $9.34 shape), not totals Agent 37 publishes. Agent 37's pages do not state hosting regions or a named infrastructure provider, and its SOC 2 reports are on request, not published.",
      "Agent 37's trust centre refused a direct request from us, so its SOC 2 and founding lines come from a search copy of that page. Its privacy policy and managed plans page were read directly.",
    ]),
    faqs: [
      {
        q: "Is Agent 37 cheaper than Hivra?",
        a: `Compare the machine as well as the bill. An always-on 2 vCPU, 4 GB standard sandbox is $4.76 a month on Agent 37's metered Cloud API, against Hivra at ${ENTRY_PRICE_PROSE}. That price assumes a funded balance, includes 4 GB of disk and leaves out model usage. A VM on Agent 37 costs 2.5 times the compute rate, about $11.36 by our arithmetic. The $4.76 is for a standard, shared sandbox with 4 GB of disk over 730 hours. For work that is mostly idle a meter costs less, and for steady work you should add up a full month.`,
      },
      {
        q: "Does Hivra include AI usage in the monthly price?",
        a: `No. ${AI_USAGE}`,
      },
      {
        q: "Can I use Agent 37 and Hivra together?",
        a: "Yes. Nothing ties an account on one to the other. A common split is a metered Agent 37 sandbox for occasional jobs or a product's API, and a Hivra computer for the agent you open and use every day.",
      },
      {
        q: "Can I keep an agent running all day on each?",
        a: `On Hivra it is simple. ${STAYS_ON} On Agent 37, an awake sandbox pays for compute for as long as it runs, and its pages say a paid managed agent stays up between scheduled jobs. A free managed agent sleeps after 15 minutes idle and wakes when you message it.`,
      },
      {
        q: "What happens to my files when an Agent 37 sandbox sleeps or the balance runs out?",
        a: "Compute stops when a sandbox sleeps, but its disk is kept and keeps billing. If the balance runs out, Agent 37's terms say it may pause your instances until you top up. The pages we read do not say how long a paused instance's data is kept, so ask before relying on it. A free managed agent is removed after 30 days asleep.",
      },
      {
        q: "Which is better for Claude Code or Codex?",
        a: "Both run them. Agent 37 lists Claude Code and Codex among its agents, and Hivra runs the vendors' own command line tools on a computer you open. Pick Hivra if you want a fixed monthly price and a terminal and files beside the agent, and Agent 37 if you want to pay by the minute for occasional runs.",
      },
      {
        q: "Which is better for a product with an agent per customer?",
        a: "Agent 37. It has a REST API for sandboxes and agents, and its terms say you are welcome to build the Service into your own product, but reselling bare access needs a written agreement. Hivra is built for one person's computers, not for provisioning machines for your customers.",
      },
      {
        q: "Is there a free option on each?",
        a: "Agent 37 offers a free managed agent (1 vCPU, 4 GB of RAM and 2 GB of storage, with messaging apps only on Basic and above) that sleeps after 15 minutes idle, with a card on file and nothing charged. Its Cloud API also gives a $5 starter credit after you add a card. A Hivra account costs nothing and works with a server you connect yourself, but every Hivra Cloud computer is paid.",
      },
      {
        q: "Does Agent 37 have SOC 2, and does Hivra?",
        a: "Agent 37 states SOC 2 Type I with Type II in progress, and its trust centre lists SOC 2 as in progress. Its privacy policy says the reports are available to business customers on request under an NDA, so ask for the report. Hivra claims no external attestation.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-hostinger", "vs-xcloud", "vs-nous-hermes-cloud", "ai-agent-hosting-alternatives"],
      blog: ["cost-of-running-ai-agent", "ai-agent-hosting-guide"],
      agents: ["hermes"],
      docs: ["plans-and-billing"],
      pricing: true,
      extra: [{ label: "Cost calculator", href: HOSTING_COST_CALCULATOR_HREF }],
    }),
  },

  "vs-hostinger": {
    slug: "vs-hostinger",
    browserTitle: "Hostinger vs Hivra: prepaid savings or managed agent computers | Hivra",
    h1: "Hostinger vs Hivra: prepaid savings or managed agent computers",
    metaDescription: `Hostinger's prepaid 24-month sale price against Hivra at ${ENTRY_PRICE_PROSE}, and when its VPS wins. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          `Hostinger can be the cheaper way to keep an agent running, especially if you accept a long prepaid term. Its managed Hermes Agent plans are sold on a 24-month term paid upfront, and the headline figure is a Black Friday sale price. Hivra is for people who would rather buy a computer for their agent one month at a time, at ${ENTRY_PRICE_PROSE}, and open it like a machine of their own.`,
          "Both give an agent a place to run that does not depend on your laptop, so the choice is not about whether the agent stays up. It is about how you pay (a long prepaid term or a monthly bill), how much of the machine you want to touch, and what happens when the sale price ends. Hostinger also sells a general VPS, which is a different product and sometimes the better answer.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          `Hostinger's managed-agent promotion is $4.99 a month on a 24-month commitment, renewing at $9.99 a month for APP 1, the smallest size. Its page shows that size as 1 vCPU, 4 GB of RAM and 25 GB of NVMe storage, with 2 TB of bandwidth. The $4.99 is not a rolling monthly subscription: it is $119.76 for 24 months, as Hostinger's page shows, paid upfront, and Hostinger labels it a Black Friday sale ("up to 67% off"), so it may not be there when you read this. Do not multiply the sale number by twelve and call it a yearly cost. Compare the whole term and the renewal.`,
          `The larger sizes follow the same pattern on the same page, all as 24-month terms paid upfront. APP 2 is $6.99 a month (2 vCPU, 6 GB, 50 GB) and renews at $12.99. APP 3 is $9.99 a month (3 vCPU, 8 GB, 100 GB) and renews at $15.99. APP 4 is $11.99 a month (4 vCPU, 10 GB, 150 GB) and renews at $18.99. Against those renewals Hivra's monthly figure holds still: ${ENTRY_PRICE_PROSE}, or ${formatPlanSize("larger")}. At the sale price Hostinger is cheaper for each shape. At the same $9.99 a month, Hostinger's APP 3 lists 3 vCPU, 8 GB and 100 GB against Hivra's 2 vCPU and 4 GB, so Hostinger wins on raw hardware at sale prices. At renewal the gap closes: APP 1 renews at $9.99 a month for 1 vCPU and 4 GB, the same price as Hivra's 2 vCPU and 4 GB, and APP 4 at $18.99 is close to Hivra's $19.99 for 4 vCPU and 8 GB. You pay for two years up front, with a 30-day money-back guarantee stated on Hostinger's page, so decide inside that window.`,
          "The managed plans bundle some AI credit, but Hostinger's pages do not state the amount. They describe access to 200+ models through OpenRouter, or directly through Anthropic, OpenAI and custom endpoints, with credit top-ups from the dashboard and an option to use your own OpenAI or Anthropic accounts. Budget model usage on both sides, because it is not the same line item as the machine.",
          "Hostinger shows both the managed plan and the KVM 2 VPS at sale prices, so confirm the current figures before you compare. KVM 2 is 2 vCPU, 8 GB of RAM and 100 GB of NVMe at $8.79 a month on a 24-month term ($210.96 upfront), renewing at $14.99. It is a server you administer: updates and security are yours. Hostinger's page lists free weekly backups on every VPS plan.",
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          `Hivra gives each agent a computer of its own, and you open it: a terminal, files, a browser and Git sit beside the agent in the dashboard. The agents are the ones people already use: ${HIVRA_AGENTS_CELL}. Claude Code and Codex are the vendors' own command line tools. Hivra is not affiliated with, endorsed by or a partner of Hostinger, Nous Research, Anthropic, OpenAI or the makers of any other agent it runs.`,
          `The price is ${ENTRY_PRICE_PROSE}, or ${formatPlanSize("larger")}, billed monthly with a ${REFUND_LINKED}. ${STAYS_ON} There is no term to commit to and no renewal price to read in advance, because the price you see is the price you pay each month. ${AI_USAGE} A Hivra account costs nothing and works with a server you connect yourself, while every Hivra Cloud computer is paid.`,
          "The trade is plain. Hostinger's managed plans are cheaper per month at their sale prices and list root access on every plan. Hivra asks for more per month, takes no long commitment and is built around opening the agent's computer rather than configuring a hosting product.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "If you know Linux, plan to stay for two years and value root access, Hostinger can be a very sensible choice. At its sale price the managed plan costs less per month than Hivra, its sizes are published, and its pages list root access on every plan. If you would rather run your own server, KVM 2 gives you 2 vCPU, 8 GB of RAM and 100 GB of NVMe to install whatever you like, which Hivra does not offer as a general-purpose server.",
          "Hostinger is also the better choice if you want one provider for an agent and for ordinary websites or other services, if you are happy to pay once for two years, or if its model access and chat channels (Telegram connected from the start, with Discord, Slack, WhatsApp, Signal and email listed) are what you want built in. Its pages also state a 30-day money-back guarantee on products, a longer window than Hivra's.",
          "If you want an agent computer on a monthly bill with no term, pick Hivra.",
        ),
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and Hostinger compared",
            rows: [
              {
                criterion: "Price model",
                hivra: "Fixed monthly price for a computer",
                alternative: "Prepaid 24-month terms on the managed agent plans. A sale price now, a higher renewal later",
              },
              {
                criterion: "Entry price",
                hivra: `${formatPlanSize("entry", "compact")}`,
                alternative: "$4.99/mo on a 24-month prepaid term for APP 1: 1 vCPU, 4 GB RAM, 25 GB NVMe. Black Friday sale price",
              },
              { criterion: "Commitment", hivra: "Monthly", alternative: "Paid upfront for the term ($119.76 for 24 months, as Hostinger's page shows). Its page says cancel anytime" },
              { criterion: "Renewal", hivra: "The listed monthly price", alternative: "$9.99/mo for APP 1, $12.99 for APP 2, $15.99 for APP 3 and $18.99 for APP 4, for the same 24-month term" },
              {
                criterion: "Larger sizes",
                hivra: `${formatPlanSize("larger", "compact")}`,
                alternative: "APP 2: 2 vCPU, 6 GB, 50 GB. APP 3: 3 vCPU, 8 GB, 100 GB. APP 4: 4 vCPU, 10 GB, 150 GB",
              },
              {
                criterion: "What you get and how you reach it",
                hivra: "A computer of its own: you open the agent with a terminal, files, a browser and Git beside it",
                alternative: "Managed Hermes Agent with a visual UI, the Hermes CLI, an AI web console and chat channels such as Telegram, Discord, Slack, WhatsApp, Signal and email. Root access listed on every plan",
              },
              {
                criterion: "What stays on",
                hivra: STAYS_ON,
                alternative: "Its page says the agent works 24/7, even when your laptop is closed. It states nothing about idle behaviour or session timeouts",
              },
              {
                criterion: "Persistence",
                hivra: "Files, sessions and login stay on the computer while it runs. Hivra does not promise backups",
                alternative: "Its pages say skills, session history and memories are kept through restarts and upgrades. Backups are marked coming soon on the managed plans",
              },
              { criterion: "Agents hosted", hivra: HIVRA_AGENTS_CELL, alternative: "Hermes Agent on the managed page, OpenClaw on its OpenClaw pages, and Agent Zero, Paperclip and n8n templates on its VPS page" },
              {
                criterion: "Models and AI cost",
                hivra: AI_ACCESS_CELL,
                alternative: "Some AI credit is bundled, amount not published. 200+ models through OpenRouter, or Anthropic, OpenAI and custom endpoints, with top-ups or your own accounts",
              },
              {
                criterion: "Setup effort",
                hivra: "Launch from the dashboard. No server to administer",
                alternative: "Managed plans are deployed from Hostinger's dashboard. The KVM 2 VPS is yours to set up and maintain",
              },
              {
                criterion: "Who maintains it",
                hivra: "Hivra runs the computer. Agent updates are yours, from the Manage tab where offered",
                alternative: "Hostinger says security is managed for you on the managed plans. On a VPS you run the server",
              },
              {
                criterion: "Data and security",
                hivra: "Each agent runs on its own private VM. No external attestation claimed",
                alternative: "Each agent runs in an isolated container with a custom security gateway, and Hostinger says data and conversations are kept private. Its pages do not state data center locations",
              },
              { criterion: "VPS alternative", hivra: "No general-purpose server", alternative: "KVM 2 at $8.79/mo: 2 vCPU, 8 GB, 100 GB NVMe, renewing at $14.99. You administer it, weekly backups listed" },
              {
                criterion: "Refund",
                hivra: REFUND_LINKED,
                alternative: "30-day money-back guarantee on its product pages. Its refund policy does not name the managed agent plans, excludes AI and Hostinger credits, and has VPS conditions",
              },
              {
                criterion: "Exit and portability",
                hivra: "Your files are on the computer you can open. Copy out what you need",
                alternative: "Root access is listed, so you can copy files out. Its pages do not describe an export tool",
              },
              { criterion: "Open source platform", hivra: "Apache-2.0 source. Self-hosting the whole platform is a preview", alternative: "Not applicable: a hosted service" },
              {
                criterion: "Best for",
                hivra: "A monthly bill with no term and a machine you open and keep using",
                alternative: "The lowest monthly cost on a long term, a general VPS, or one provider for sites and agents",
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
                lead: "Marta, a backend developer who is comfortable with Linux and wants the lowest bill for the next two years:",
                text: "Pick Hostinger. At the sale price a managed plan or a KVM 2 costs less per month than Hivra, and root access is listed. Read the renewal price first, because it is higher.",
              },
              {
                lead: "Jonas, who runs several small sites and wants a personal agent on the same account:",
                text: "Pick Hostinger. One provider for hosting and an agent is its strength, and a VPS lets him install anything alongside it.",
              },
              {
                lead: "Priya, a developer who wants Claude Code on a machine that stays on, reachable from any laptop:",
                text: `Pick Hivra. It is ${ENTRY_PRICE_PROSE}, the computer is not paused for inactivity, and Claude Code is a listed agent with a terminal and files beside it. On Hostinger you would install it yourself, using root access.`,
              },
              {
                lead: "Tom, an AI power user who does not want to pay for two years before he knows the agent is useful:",
                text: "Pick Hivra. The first month is the commitment, and the guarantee covers card payments for a week. A prepaid term only pays off if you stay for it.",
              },
              {
                lead: "Aisha, a founder who wants an agent reachable from Telegram and a visual interface straight away:",
                text: "Pick Hostinger if the visual UI with Telegram connected from the start matters most, as its page lists. Pick Hivra if you want Claude Code on a Telegram tab plus a terminal on the computer.",
              },
              {
                lead: "Raj, who already runs a Proxmox server at home:",
                text: "Pick Hivra with a free account and connect your Proxmox VE server with SSH details, so the agents run on hardware you own. Check STATUS.md for which agents run there.",
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
                lead: "Run it on Hostinger.",
                text: "Read the term, the upfront total and the renewal before you pay, because the managed plans are billed for 24 months. Its 30-day guarantee is the window to decide, and its policy does not name the managed agent plans, so ask support before you rely on it.",
              },
              {
                lead: "Run it on Hivra.",
                text: `Create an account, launch the agent on a paid Hivra Cloud computer at ${ENTRY_PRICE_PROSE}, and open its terminal and files. The ${REFUND_LINKED} covers the test if you decide against it.`,
              },
              { lead: "Restart both.", text: "Restart the environment, then confirm the files, credentials and task history are still there on each." },
              { lead: "Count model usage separately.", text: "Neither price is the whole bill. Add model usage to each side so the month is a real number." },
              {
                lead: "Price the second year.",
                text: "Use Hostinger's renewal for the size you tested, not the sale price. Take the cheaper full period that you also trust.",
              },
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
                lead: "On Hostinger:",
                text: "Its pages say Hermes keeps skills, session history and memories through restarts and upgrades, and that files, chats and installed tools on the OpenClaw page are kept on the data disk through restarts and updates. Backups and custom docker-compose are marked coming soon. Its pages do not state what happens to your data after a term ends or a plan is cancelled.",
              },
              {
                lead: "On Hivra:",
                text: `${CLI_RUN_LIFETIME} Hivra does not promise backups, so copy out anything you cannot lose, on either host.`,
              },
              {
                lead: "Other agents on Hivra:",
                text: SERVER_SIDE_AGENTS_KEEP_WORKING,
              },
            ],
          },
        ],
      },
      cautionSection(COMPETITOR_FACTS_CHECKED),
    ],
    sources: priceSources(sourcesFor("vs-hostinger"), [
      `Hostinger's [Docker OpenClaw page](https://www.hostinger.com/vps/docker/openclaw) shows the same APP 1 to APP 4 plans, and its [OpenClaw hosting page](https://www.hostinger.com/vps/openclaw-hosting) lists a separate AI automation apps plan at $4.99 a month for 24 months, renewing at $11.99, with shorter terms at higher monthly prices. That page shows no specs or limits.`,
      "The managed plan prices are a Black Friday sale ('up to 67% off') and the KVM 2 price is a sale price too, so both may change. The $119.76 and $210.96 totals are the figures on Hostinger's pages for 24 months, and the 24-month totals for Hivra are not stated anywhere on this page. Nothing quoted here sits behind a sign-in.",
      "Hostinger shows no end date for the Black Friday sale. Only APP 1 is 67% off, and APP 3 and APP 4 are 60% off. Tax is not included in the figures shown. Hostinger's pages do not state data center locations, the amount of bundled AI credit or a monthly billing option on the managed Hermes page, and its refund policy does not list the managed agent plans.",
    ], false, COMPETITOR_FACTS_CHECKED),
    faqs: [
      {
        q: "Why does the Hostinger headline price look lower than Hivra?",
        a: "The $4.99 is a sale price on a 24-month term paid upfront, for a plan of 1 vCPU, 4 GB of RAM and 25 GB of NVMe. It renews at $9.99 a month for that size. Check the upfront total, the renewal and the exact size before you compare it with a monthly price.",
      },
      {
        q: "How much does Hostinger's managed agent plan cost after the sale?",
        a: "On Hostinger's managed Hermes page, the 24-month renewal is $9.99 a month for APP 1, $12.99 for APP 2, $15.99 for APP 3 and $18.99 for APP 4, as of November 2026. The page labels the sale prices as a Black Friday promotion, so they may not last.",
      },
      {
        q: "Can I use Hostinger and Hivra together?",
        a: "Yes. Nothing ties an account on one to the other. A common split is a Hostinger VPS or managed plan for sites and long-term services, and a Hivra computer for the agent you open and use every day.",
      },
      {
        q: "Can I keep an agent running 24/7 on each?",
        a: `On Hivra, ${STAYS_ON} Hostinger's managed page says the agent works 24/7, even when your laptop is closed. Its pages do not state anything about idle behaviour or session timeouts.`,
      },
      {
        q: "Does Hostinger give me root access?",
        a: "Hostinger's managed agent pages list root access on every plan, and a KVM VPS is a server you administer. Hivra does not give you a general-purpose server, but you open the agent's terminal and files on its own computer.",
      },
      {
        q: "What happens to my data if I leave Hostinger or Hivra?",
        a: "Hostinger's pages say the agent keeps skills, session history and memories through restarts and upgrades, and they do not describe what happens after cancellation. Hivra keeps files on the computer while it runs and does not promise backups. On either one, copy out anything you cannot lose before you leave.",
      },
      {
        q: "Does Hostinger include AI usage in the price?",
        a: "Hostinger's managed plans include some AI credit, but its pages do not state the amount, and you can top up or use your own accounts. Hivra does not include AI usage in the plan. Bring your own account or key where the agent supports it, or pay with Hivra credits.",
      },
      {
        q: "Which is better for a beginner who wants a personal AI agent?",
        a: "If you want the lowest price and are happy to pay for two years upfront, Hostinger's managed plan is worth a look. If you would rather start month to month and open a computer of your own for the agent, Hivra is the simpler commitment, with a 7-day money-back guarantee on card payments.",
      },
      {
        q: "Which is better if I want a general VPS?",
        a: "Hostinger. Its KVM 2 plan is 2 vCPU, 8 GB of RAM and 100 GB of NVMe at $8.79 a month on a 24-month sale term, renewing at $14.99, and you control the server. Hivra is built around agent computers, not general-purpose servers.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-agent-37", "vs-xcloud", "vs-self-hosted", "ai-agent-hosting-alternatives"],
      blog: ["self-hosting-hermes-guide", "cost-of-running-ai-agent"],
      agents: ["hermes", "openclaw"],
      docs: ["plans-and-billing"],
      pricing: true,
      extra: [{ label: "Cost calculator", href: HOSTING_COST_CALCULATOR_HREF }],
    }),
  },

  "vs-xcloud": {
    slug: "vs-xcloud",
    browserTitle: "xCloud vs Hivra: a managed server or a computer you open | Hivra",
    h1: "xCloud vs Hivra: a managed server or a computer you open",
    metaDescription: `xCloud lists 4 vCPU and 6 GB at $24.99 a month; Hivra is ${ENTRY_PRICE_PROSE}. Where each wins. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          `xCloud and Hivra both host an AI agent on a server that is not your laptop, and both ask you to pay a fixed monthly price. They shape the product differently. As of ${formatCheckedMonth(COMPETITOR_FACTS_CHECKED)}, xCloud sells a dedicated virtual server for an agent such as OpenClaw, Hermes Agent, DeepSeek Harness or Paperclip, set up from its dashboard and managed there, with you supplying the model key. Hivra gives an agent a computer of its own that you open: a terminal, files, a browser and Git sit beside the agent in the dashboard.`,
          `On price, the entry servers are not the same machine. xCloud's smallest agent server is $24.99 a month for 4 vCPU, 6 GB of RAM and 100 GB of NVMe storage. Hivra is ${ENTRY_PRICE_PROSE}, and ${formatPlanSize("larger")}. So the honest question is not which headline is lower. It is whether you want xCloud's managed server workflow, with 100 GB of NVMe at entry, or a computer you work in alongside the agent. Hivra does not publish a disk figure, so compare xCloud's 100 GB with the disk you need.`,
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          `xCloud lists "OpenClaw in Cloud VPS 6GB" at $24.99 a month: 6 GB of RAM, 4 vCPU, 100 GB of NVMe storage and 30 TB of bandwidth, described as one always-on agent (figures as of ${formatCheckedMonth(COMPETITOR_FACTS_CHECKED)}). Its 16 GB size is $59.99 a month with 6 vCPU and 200 GB of NVMe, which its pages describe as room for tooling and browser work. Paperclip is sold on the same sizes. xCloud's OpenClaw and pricing pages show prices only for 6 GB and 16 GB. Its Paperclip page shows 24 GB at $84.99 a month with 8 vCPU and 300 GB of NVMe, and xCloud states that every agent uses the same sizes and prices. The 48, 64 and 120 GB sizes are listed without a price. The 16 GB size lists unlimited agents, while Hivra's plan compute is shared by the agent computers on one account, so weigh how many agents you will run.`,
          "Billing is monthly, or you can pick 12 or 24 months and save, but the discounted amounts are not stated on the pages we read. xCloud says there are no contracts or commitments. Its pages show no promotional price and no renewal price for agent hosting, so the figure you see is the figure we use. If a promotion appears later, compare the price after it ends, not the first month.",
          `What the xCloud price leaves out is the model. You supply your own provider key or account: its page lists Anthropic (an API key or a Claude Code CLI token), OpenAI (an API key or a ChatGPT sign-in for Codex), Google Gemini, OpenRouter, Z.AI and Moonshot AI now, with Groq, xAI and Mistral marked as coming soon. Paperclip's model costs are paid to your provider separately. Hivra's plan does not include AI usage either: ${AI_USAGE} Either way, add the model bill to the hosting bill to get a real month.`,
          `Hivra's price is for a computer. ${ENTRY_PRICE_PROSE} buys one computer for the agent, ${formatPlanSize("larger")} buys more room, and the plan's compute is shared by the agent computers on one account. For comparison, Hivra's larger plan is ${formatPlanSize("larger")}, which is below xCloud's $24.99 entry price. Hivra does not publish a disk figure for either plan. A Hivra account costs nothing and works with a server you connect yourself, while every Hivra Cloud computer is paid.`,
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          `Hivra is for a developer or AI power user who wants to open the agent's computer, not only message it. You get a terminal, files, a browser and Git next to the agent, and the agents are the ones people already use: ${HIVRA_AGENTS_CELL}. Claude Code and Codex are the vendors' own command line tools, and Hermes is the official Hermes Agent, unmodified. Hivra is not affiliated with, endorsed by or a partner of xCloud, Anthropic, OpenAI, Nous Research or the makers of any other agent it runs.`,
          `The keep-running story is plain. ${STAYS_ON} The price is ${ENTRY_PRICE_PROSE}, or ${formatPlanSize("larger")}, with a ${REFUND_LINKED}. If you do not want to bring a model key, Hivra credits can pay for usage where the agent supports it.`,
          "The trade is equally plain. xCloud lists 100 GB of NVMe at its entry size while Hivra publishes no disk figure, so compare that with the disk you need. It also lists Paperclip hosting, which Hivra's agent list does not include, and it is managed from a control panel with no terminal required. If those are what you need, Hivra is not the better fit.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Choose xCloud if its server fits the job you actually have. That means a dedicated 4 vCPU, 6 GB server with 100 GB of NVMe storage for one OpenClaw, Hermes Agent or DeepSeek Harness agent, or Paperclip on the same sizes, set up from a control panel without touching a terminal. A disk that size matters if your agent keeps large files, repositories or browser profiles.",
          "Choose xCloud too if you want a size above what Hivra's pricing page lists. xCloud shows a 16 GB size at $59.99 a month with 6 vCPU and 200 GB of NVMe, and Paperclip up to 24 GB, so compare those against the sizes on Hivra's pricing page. And choose it if you already have your own server: its pages describe a bring-your-own-server option with a 14-day money-back guarantee, which is separate from its managed servers.",
          "Neither option makes an unrestricted agent safe. xCloud's own page describes OpenClaw as having full system access on a dedicated VM that is not a sandbox, so review permissions wherever you run it.",
        ),
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and xCloud compared",
            rows: [
              {
                criterion: "Price model",
                hivra: "Fixed monthly price for a computer",
                alternative: "Fixed monthly price for a dedicated server. Monthly, or 12 or 24 months at a saving it does not state",
              },
              {
                criterion: "Entry price",
                hivra: formatPlanSize("entry", "compact"),
                alternative: "$24.99/mo for 4 vCPU, 6 GB RAM and 100 GB NVMe. No promotional or renewal price shown",
              },
              {
                criterion: "More room",
                hivra: `${formatPlanSize("larger", "compact")}. Below xCloud's $24.99 entry price. No disk figure published`,
                alternative: "$59.99/mo for 16 GB RAM, 6 vCPU and 200 GB NVMe, with unlimited agents listed. Paperclip page: 24 GB at $84.99/mo. 48, 64 and 120 GB listed without prices",
              },
              {
                criterion: "What you get and how you reach it",
                hivra: "A computer of its own: you open the agent with a terminal, files, a browser and Git beside it",
                alternative: "A dedicated server for the agent, managed from the xCloud dashboard with no SSH or terminal required. Telegram is connected at setup",
              },
              {
                criterion: "What stays on",
                hivra: STAYS_ON,
                alternative: "Its pages say the agent runs 24/7 on a dedicated server, with 24/7/365 expert support and one-click restore stated",
              },
              {
                criterion: "Persistence",
                hivra: "Files, sessions and login stay on the computer while it runs. No backup promise",
                alternative: "Files, memory and settings sit on your server. Reset deletes memory, chat history, settings and the Telegram connection. Rebuilding wipes the disk",
              },
              { criterion: "Agents", hivra: HIVRA_AGENTS_CELL, alternative: "OpenClaw, Hermes Agent, DeepSeek Harness, Paperclip (which can hire Claude Code and Codex)" },
              {
                criterion: "Models and AI cost",
                hivra: AI_ACCESS_CELL,
                alternative: "Not in the server price. Your own provider key or account: Anthropic, OpenAI, Gemini, OpenRouter, Z.AI and Moonshot listed",
              },
              {
                criterion: "Setup effort",
                hivra: "Launch from the dashboard. No server to administer",
                alternative: "Create the server and connect a model key and Telegram from the xCloud dashboard. No terminal required",
              },
              {
                criterion: "Who maintains it",
                hivra: "Hivra runs the computer. Agent updates are yours, from the Manage tab where offered",
                alternative: "xCloud lists managed security patches, a firewall and login protection, with 24/7 support stated",
              },
              {
                criterion: "Data and security",
                hivra: "Each agent gets its own computer on your account. No external attestation claimed",
                alternative: "A dedicated VM, not a sandbox, with strict defaults per its page. Support cannot reach your server without your Support Access Code",
              },
              {
                criterion: "Limits",
                hivra: "The plan's compute is shared by the agent computers on one account",
                alternative: "A dedicated server of the size you pick, with 30 TB of bandwidth. The 6 GB size is sold for one always-on agent and the 16 GB size lists unlimited agents",
              },
              {
                criterion: "Refund",
                hivra: REFUND_LINKED,
                alternative: "Managed servers: pro-rated unused value when you delete the server before the paid term ends, by request. Its policy limits refunds to invoices paid by card and deducts usage and up to a 10% Stripe fee. 14 days for bring-your-own-server",
              },
              {
                criterion: "Exit and portability",
                hivra: "Your files are on the computer you can open. Copy out what you need",
                alternative: "Files are on your server. Back up before a reset or rebuild. Deleting the server cancels the subscription",
              },
              { criterion: "Server locations", hivra: "Not published", alternative: "30+ stated (31 for xCloud overall). No agent-specific list" },
              {
                criterion: "Best for",
                hivra: "A fixed bill and a machine you open and keep using",
                alternative: "A larger disk at entry, Paperclip, and a control-panel workflow with no terminal",
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
                lead: "Noor, who wants OpenClaw on its own server and never wants to open a terminal:",
                text: "Pick xCloud. It sets the agent up from its dashboard, connects Telegram at setup and manages the server for you. It does that for $24.99 a month at the size it lists, with 100 GB of NVMe.",
              },
              {
                lead: "Marcus, who keeps large repositories and browser profiles on his agent's disk:",
                text: "Pick xCloud. Its 6 GB server has 100 GB of NVMe at $24.99 a month and its 16 GB server has 200 GB at $59.99. Hivra publishes no disk figure, so compare that with your repositories and browser profiles first, and move to Hivra only if its disk covers them.",
              },
              {
                lead: "Ines, who wants OpenClaw alone at the lowest price and does not need a big disk:",
                text: `Pick Hivra's entry plan at ${ENTRY_PRICE_PROSE} if you are happy to open a computer and fit your files in what it offers. Pick xCloud's 6 GB server at $24.99 a month if you would rather have a dedicated server with 100 GB of NVMe, managed from a control panel with no terminal. Either way, add your own model bill.`,
              },
              {
                lead: "Priya, a developer who wants Claude Code on a machine that stays on, reachable from any laptop:",
                text: `Pick Hivra. It is ${ENTRY_PRICE_PROSE}, the computer is not paused for inactivity, and you open its terminal and files beside the agent. On xCloud, Claude Code appears only as an agent you can hire inside Paperclip, with your own credentials, and it is not one of the agents on its OpenClaw, Hermes Agent and DeepSeek Harness hosting pages. Hivra runs the Claude Code command line tool directly in the computer's terminal.`,
              },
              {
                lead: "Elena, who wants to run Paperclip:",
                text: "Pick xCloud. It sells Paperclip hosting on its sizes, from $24.99 a month, and Hivra's agent list does not include Paperclip. Paperclip's model costs go to your own provider either way.",
              },
              {
                lead: "Tom, an AI power user who wants to work inside the agent's computer and pay for model usage without a separate key:",
                text: `Pick Hivra. You open the terminal, files and browser, and Hivra credits can pay for usage where the agent supports it. xCloud asks you to bring your own provider key or account.`,
              },
              {
                lead: "Sam, who already rents a VPS and wants a dashboard on top of it:",
                text: "Look at xCloud's bring-your-own-server route, which its pages describe with a 14-day money-back guarantee. On Hivra, a free account can connect a Proxmox server you own, but it does not manage a rented VPS from another host.",
              },
              {
                lead: "Raj, who runs a Proxmox server at home:",
                text: "Pick Hivra with a free account and connect that server, so the agents run on hardware you own. A Hivra account costs nothing, while every Hivra Cloud computer is paid.",
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
              { lead: "Pick one real workload.", text: "An ordinary task, a scheduled task and a task that writes a file. Use the same agent on both if you can, such as OpenClaw or Hermes, so the comparison is about the host." },
              {
                lead: "Run it on xCloud.",
                text: "Create the 6 GB OpenClaw server, connect your own model key and Telegram, and run the workload. Note the size and bill. Remember that refunds are by request after you delete the server, and its policy covers card invoices only.",
              },
              {
                lead: "Run it on Hivra.",
                text: `Create an account, launch the agent on a paid Hivra Cloud computer at ${ENTRY_PRICE_PROSE}, and open its terminal and files. The ${REFUND_LINKED} covers the test if you decide against it.`,
              },
              { lead: "Restart both.", text: "Restart the environment, then confirm the files, credentials and task history are still there on each. Do not use xCloud's reset for this test, because it deletes memory, chat history, settings and the Telegram connection." },
              { lead: "Count model usage separately.", text: "Neither price includes it. Add provider or credit spend to each side so the month is a real number." },
              {
                lead: "Decide, then clean up.",
                text: "Keep the one you trust for a full month. If you leave xCloud, back up first, then delete the server, which cancels the subscription, and claim any refund from its Billing page afterwards.",
              },
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
                lead: "On xCloud:",
                text: "Files, memory and settings are stored on your server and its pages describe a one-click restore and repair. Reset deletes memory, chat history, settings and the Telegram connection. Rebuilding a server wipes the disk, so xCloud says to back up first. Deleting the server cancels the subscription.",
              },
              {
                lead: "On Hivra:",
                text: `${CLI_RUN_LIFETIME} Hivra does not promise backups, so copy out anything you cannot lose, on either host.`,
              },
              {
                lead: "Other agents on Hivra:",
                text: SERVER_SIDE_AGENTS_KEEP_WORKING,
              },
            ],
          },
        ],
      },
      cautionSection(COMPETITOR_FACTS_CHECKED),
    ],
    sources: priceSources(sourcesFor("vs-xcloud"), [
      `Nothing quoted above from xCloud is shown as a sale price. We found no promotional or renewal price for agent hosting on its pricing, OpenClaw or Paperclip pages in ${formatCheckedMonth(COMPETITOR_FACTS_CHECKED)}, and its pages state no discounted amount for 12 or 24 months.`,
      "Two xCloud details are not stated on the pages we read: whether its 14-day money-back guarantee applies to managed servers (its OpenClaw page ties it to bring-your-own-server), and how it behaves when the agent is idle. Its OpenClaw deploy guide in its docs labels the managed OpenClaw feature beta with limited support, so read that guide and its Support Scope page before you rely on it. Its backups are mentioned without a schedule or retention period.",
      "xCloud's OpenClaw and pricing pages show prices only for 6 GB and 16 GB. Its Paperclip page shows 24 GB at $84.99 a month with 8 vCPU and 300 GB of NVMe, and xCloud states that every agent uses the same sizes and prices. The 48, 64 and 120 GB sizes are listed without a price. Refund terms come from its refund policy (card invoices, deletion before the eligibility deadline) and its pricing and OpenClaw pages (up to a 10% Stripe fee on usage). Hivra publishes no disk figure.",
    ]),
    faqs: [
      {
        q: "How much does xCloud cost compared with Hivra?",
        a: `As of ${formatCheckedMonth(COMPETITOR_FACTS_CHECKED)}, xCloud lists $24.99 a month for 4 vCPU, 6 GB of RAM and 100 GB of NVMe, and $59.99 a month for 16 GB of RAM, 6 vCPU and 200 GB. Hivra is ${ENTRY_PRICE_PROSE}, and ${formatPlanSize("larger")}. Neither price includes model usage.`,
      },
      {
        q: "Does xCloud have a promotional or renewal price?",
        a: "Its pricing, OpenClaw and Paperclip pages showed no promotional or renewal price when we read them. It offers monthly billing, or 12 or 24 months at a saving it does not state. Check the price you are shown before you pay.",
      },
      {
        q: "Can I use xCloud and Hivra together?",
        a: "Yes. Nothing ties an account on one to the other. A common split is an xCloud server for an agent you manage from its panel, and a Hivra computer for an agent you open and work in.",
      },
      {
        q: "Does Hivra include AI usage in the monthly price?",
        a: `No. ${AI_USAGE} xCloud's server price does not include a model either: you supply your own provider key or account.`,
      },
      {
        q: "Can I keep an agent running all day on each?",
        a: `${STAYS_ON} xCloud's pages say OpenClaw runs 24/7 on a dedicated server and describe the 6 GB size as one always-on agent.`,
      },
      {
        q: "What happens to my data if I reset or rebuild an xCloud server?",
        a: "xCloud says a reset deletes the agent's memory, chat history, settings and Telegram connection, and that rebuilding a server wipes the disk, so you should back up first. It offers one-click restore and repair, and mentions backups without a schedule or retention period.",
      },
      {
        q: "Which is better for OpenClaw?",
        a: `Both host OpenClaw. xCloud sets it up on a dedicated server from its dashboard with no terminal, and its entry server has 100 GB of NVMe. Hivra runs it on a computer you open, at ${ENTRY_PRICE_PROSE}. If you never want to open a terminal, pick xCloud. If you want a terminal, files and a browser beside the agent, pick Hivra.`,
      },
      {
        q: "Does xCloud host Paperclip, and does Hivra?",
        a: "xCloud has a Paperclip hosting page, with sizes from $24.99 a month. Paperclip is open source, and xCloud's page says it is not Paperclip Cloud, a separate waitlist product. Hivra's agent list does not include Paperclip.",
      },
      {
        q: "Can I get a refund on each?",
        a: "Hivra has a 7-day money-back guarantee on card payments. xCloud refunds managed servers as pro-rated unused value when you delete the server before the paid term ends, by request. Its refund policy limits refunds to invoices paid by card, and its pricing and OpenClaw pages say usage plus up to a 10% Stripe fee is deducted. Its 14-day money-back text is tied to bring-your-own-server.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-hostinger", "vs-agent-37", "vs-nous-hermes-cloud", "ai-agent-hosting-alternatives"],
      blog: ["cost-of-running-ai-agent", "managed-vs-self-hosted-ai-agents"],
      agents: ["openclaw", "hermes"],
      docs: ["plans-and-billing"],
      pricing: true,
      extra: [{ label: "Cost calculator", href: HOSTING_COST_CALCULATOR_HREF }],
    }),
  },

  "vs-nous-hermes-cloud": {
    slug: "vs-nous-hermes-cloud",
    // The supplied title is 76 characters with the brand; the rule for finished titles is 70
    // (62 before the " | Hivra" the template used to add), so "the" and "a" are left out.
    browserTitle: "Nous Hermes Cloud vs Hivra: official cloud or multi-agent home | Hivra",
    h1: "Nous Hermes Cloud vs Hivra: the official cloud or a multi-agent home",
    metaDescription: `Nous Hermes Cloud bills by usage or plan; Hivra is ${ENTRY_PRICE_PROSE}. Not affiliated with Nous. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          `There is an obvious reason to consider Nous Hermes Cloud: it comes from the team behind Hermes itself. Hivra is not affiliated with Nous Research. It is an independent hosting option for Hermes and other supported agents, and this page is written from that side of the table, so it tries to say plainly where Nous is the better choice.`,
          `The two sell the same idea in different shapes. Nous Hermes Cloud runs a Hermes agent in its own container, bills compute by the second from prepaid credit (or bundles one cloud agent into a monthly Portal plan), and is built around Hermes alone. Hivra is a monthly computer, ${ENTRY_PRICE_PROSE}, that you open and work in, and it can host other agents beside Hermes. The useful question is whether you want the vendor's own Hermes with its own meter, or a fixed-price computer that also fits whatever agent you try next.`,
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          `Nous has two routes, and its pages describe both (figures as of ${formatCheckedMonth()}). The first is credit. Cloud agents are charged from your Nous credit once a day, in arrears, on actual use: while an agent runs, compute is metered to the second plus storage, and while it is stopped you pay storage only. Inference and tool usage are billed separately from the same credit balance. Its page asks for at least $2 in credits, or an active subscription, to deploy a cloud agent. Top-ups are $10, $20, $50, $100 or $200, and the pages state no minimum top-up.`,
          `Nous's public pages do not list per-size prices. They say instance prices are per day, exclude inference and tool usage, and are shown only in the Portal deploy screen, so this page quotes no daily figure. Read the rate for the size you want there before you confirm, and compare on what is public: the plan prices and RAM and disk below, and the $2 credit minimum.`,
          `The second route is a plan. Nous lists Plus at $20 a month with one cloud agent (4 GB of RAM and 25 GB of disk), Super at $100 a month with five times Plus usage and one cloud agent (4 GB of RAM and 100 GB of disk), and Ultra at $200 a month with ten times Plus usage and one cloud agent (8 GB of RAM and 100 GB of disk). Its pages say bigger sizes and extra agents use credits, billed by the day. The pages we read do not state a vCPU count for these plans, and a plan's price covers more than hosting, because it includes Nous model usage.`,
          `Hivra's price is a different shape. ${ENTRY_PRICE_PROSE} buys a computer for the agent, and ${formatPlanSize("larger")} buys more room. ${AI_USAGE} A Hivra account costs nothing, but every Hivra Cloud computer is paid, and Hermes runs only on Hivra Cloud. A Proxmox server you connect yourself runs OpenClaw, Agent Zero, Claude Code, Codex and Aeon, not Hermes.`,
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          `Hivra gives each agent a computer of its own, and you open it: a terminal, files, a browser and Git sit beside the agent in the dashboard. Hermes on Hivra is the official Hermes Agent, unmodified, and the other agents are the ones people already use: ${HIVRA_AGENTS_CELL}. Hivra is not affiliated with, endorsed by or a partner of Nous Research, Anthropic, OpenAI or the makers of any other agent it runs.`,
          `The fit is a person who wants a predictable monthly machine, or who expects to run more than one kind of agent over time, each on its own computer. ${STAYS_ON} The price is ${ENTRY_PRICE_PROSE}, or ${formatPlanSize("larger")}, with a ${REFUND_LINKED}. There is no credit balance to top up and no daily charge to read.`,
          "The trade is plain. If you only run Hermes in occasional short sessions, a usage meter may be more economical than a full month of hosting. If you want the vendor's own Hermes cloud, with its Portal, its models on the same bill and a plan that bundles an agent, Nous is the more direct route. Hivra claims no external security attestation.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Use Nous if its native tooling and usage-based model match your work. It is the first-party Hermes cloud, it keeps an agent's workspace whether the agent is running or stopped, and compute is metered to the second, so an agent that sits idle most of the week may cost less than a flat monthly price, depending on the per-size daily rate shown in the Portal. The cheapest Nous plan is $20 a month, so the credit route is the only one that can undercut Hivra's flat price. Its pages also say agents scale to zero when idle, without saying whether that is automatic.",
          "Use Nous too if you want one bill for the agent and the models. Its plans bundle usage and one cloud agent, and its credit pays for inference, tools and hosting from a single balance. Hivra's plan does not include AI usage, so on Hivra the model side is a separate line.",
          "Use Nous if you only ever run Hermes and you want the vendor behind it to be the vendor that hosts it. Use Hivra if you want a predictable monthly machine, or you expect to run different agent frameworks on separate computers over time.",
        ),
      },
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and Nous Hermes Cloud compared",
            rows: [
              { criterion: "Price model", hivra: "Fixed monthly price for a computer", alternative: "Prepaid credit charged daily in arrears, or a monthly Portal plan ($20, $100 or $200) with one bundled cloud agent" },
              { criterion: "Always-on cost, smaller size", hivra: "$9.99/mo for 2 vCPU and 4 GB RAM", alternative: "Per-size daily prices are shown only in the Portal deploy screen. The cheapest plan is $20/mo with 4 GB RAM and 25 GB disk, plus model usage beyond it" },
              { criterion: "Used a few hours a week", hivra: "Same flat price", alternative: "A stopped agent is billed for storage only, at a rate shown in the Portal. Jobs that need a running agent do not run while it is stopped" },
              { criterion: "Larger size", hivra: "4 vCPU and 8 GB RAM at $19.99/mo", alternative: "Plans list 4 GB RAM at $20 or $100/mo and 8 GB at $200/mo. Bigger sizes use credits at a daily rate shown in the Portal" },
              { criterion: "What you get and how you reach it", hivra: "A computer of its own: you open the agent with a terminal, files, a browser and Git beside it", alternative: "A Hermes agent in its own container with a browser dashboard from the Portal, and channels such as Telegram, Discord, Slack, WhatsApp, email and CLI" },
              { criterion: "What stays on", hivra: STAYS_ON, alternative: "A running agent is metered while it works, and its pages say agents scale to zero when idle. A stopped agent keeps its workspace but its jobs do not run" },
              { criterion: "Persistence", hivra: "Files, sessions and login stay on the computer while it runs. No backup promise", alternative: "Each agent has a dedicated persistent workspace. Files, memory and configuration remain whether it is running or stopped. Disks never shrink" },
              { criterion: "Agents", hivra: HIVRA_AGENTS_CELL, alternative: "Hermes Agent only" },
              { criterion: "Hermes version", hivra: "The official Hermes Agent, installed with its own installer and updated with hermes update or the Update Hermes button on the Manage tab", alternative: "First-party from Nous" },
              { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Not in the instance price. Inference and tool usage draw from the same credit balance, and plans bundle some usage" },
              { criterion: "Setup effort", hivra: "Launch from the dashboard. No server to administer", alternative: "Deploy from the Portal with at least $2 in credits or a subscription. Its pages do not ask you to run a server" },
              { criterion: "Data and security", hivra: "Each agent runs on its own private VM. No external attestation claimed", alternative: "Every agent gets its own hardened container. Its privacy policy says Privacy Mode covers inference payloads, and that other service data may be used or shared for AI training in aggregated or provider-supported forms. Its pages do not state encryption, certifications or data location. Read it before putting sensitive work on either host" },
              { criterion: "Refund", hivra: REFUND_LINKED, alternative: "Its terms say all fees are non-refundable and give no refund for unused time. They do not say what happens to unspent credit" },
              { criterion: "Exit and portability", hivra: "Your files are on the computer you can open. Copy out what you need", alternative: "Stop or delete an agent from its dashboard. Its pages do not describe how to export an agent's workspace. Its terms keep your data up to six months after termination, with earlier deletion on request" },
              { criterion: "Regions", hivra: "Hivra does not publish a region or data location", alternative: "14 cities listed. Its page says it picks the closest location with availability" },
              { criterion: "Best for", hivra: "A fixed bill, a machine you open, and room for other agents", alternative: "Hermes only, mostly idle work, and one bill for the agent and its models" },
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
                lead: "Elena, a developer who wants the official Hermes cloud and Nous's model access (the Portal lists 200+ models) on one bill:",
                text: "Pick Nous. A Portal plan bundles a cloud agent with usage, and its credit pays for hosting, inference and tools from one balance. That is a tidier arrangement than a separate model account beside a host.",
              },
              {
                lead: "Marcus, who runs a Hermes agent for a few scheduled jobs a week and leaves it alone otherwise:",
                text: "Nous suits occasional interactive sessions, where you stop the agent between uses. Scheduled jobs need a running agent, and its pages say jobs that need a running agent do not run while it is stopped, so for scheduled work compare Hivra's flat price with Nous's always-on cost from the Portal deploy screen. Its pages do not explain whether scale to zero is automatic, so check that on the deploy screen before you rely on it.",
              },
              {
                lead: "Priya, a developer who wants Hermes on one computer and Claude Code on another, at a fixed price:",
                text: `Pick Hivra. Each agent gets a computer of its own at ${ENTRY_PRICE_PROSE}, the computer is not paused for inactivity, and you open a terminal and files rather than reading a daily charge. Nous hosts Hermes only.`,
              },
              {
                lead: "Dana, an AI power user who only ever runs Hermes and wants one monthly figure that includes models:",
                text: "Pick a Nous plan and read its usage limits. Hivra's plan does not include AI usage, so the model side would be a second bill. Hivra is the better fit only if you also want other agents or a machine you open.",
              },
              {
                lead: "Sam, whose team wants to try Hermes, OpenClaw and Codex side by side and keep whichever wins:",
                text: `Pick Hivra. One platform and one monthly price hosts them all, on separate computers, and you can launch another without learning a second vendor. Nous's cloud product is Hermes only.`,
              },
              {
                lead: "Lena, a hobbyist who wants to try an agent before spending anything:",
                text: "A Hivra account costs nothing, but every Hivra Cloud computer is paid, and Hermes needs a paid Hivra Cloud computer. Pick Nous's $2 minimum if you only want to see Hermes run, knowing that fee is non-refundable. Pick Hivra's $9.99 entry plan (2 vCPU and 4 GB) if you want a refundable month on a card payment.",
              },
              {
                lead: "Raj, who already runs a Proxmox server at home:",
                text: "On a Proxmox server you connect, Hivra runs OpenClaw, Agent Zero, Claude Code, Codex and Aeon, not Hermes. If Hermes is what you want, pick Nous or a paid Hivra Cloud computer. If another agent is what you want, a free Hivra account and your own server keeps it on hardware you own. Nous's pages describe its own hosted instances and do not describe connecting your own machine.",
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
              { lead: "Pick one real workload.", text: "An ordinary task, a scheduled task and a task that writes a file. Use Hermes on both so the comparison is about the host and not the agent." },
              {
                lead: "Run it on Nous.",
                text: "Add the minimum credit or a plan, deploy a Hermes agent from the Portal, and read the size and daily price on its deploy screen before you confirm. After a day, read the daily charge. Then stop the agent and read the next charge, so you see both rates.",
              },
              {
                lead: "Run it on Hivra.",
                text: `Create an account, launch Hermes on a paid Hivra Cloud computer at ${ENTRY_PRICE_PROSE}, and open its terminal and files. The ${REFUND_LINKED} covers the test if you decide against it.`,
              },
              { lead: "Restart both.", text: "Restart the environment, then confirm the files, credentials, memory and scheduled tasks are still there on each." },
              { lead: "Count model usage separately.", text: "Neither hosting price includes it, and a Nous plan bundles only some. Add each side's model usage so the month is a real number." },
              {
                lead: "Decide, then clean up.",
                text: "Take the cheaper full month that you also trust. Stop or delete the test agent on Nous so its meter stops, and remember its terms say all fees are non-refundable and give no refund for unused time. They do not say what happens to unspent credit, so top up only what you will use.",
              },
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
                lead: "On Nous:",
                text: "Each agent has a dedicated persistent workspace, and its pages say files, memory and configuration remain whether the agent is running or stopped. Stopping drops the agent to the storage-only rate. A deleted instance is no longer billed. Its terms say an account is permanently deleted within six months of termination, your data is stored for six months to allow reopening, and earlier deletion can be requested. Its privacy policy says account deletion takes effect a week after the request, and that Privacy Mode covers inference payloads while other service data may be used or shared for AI training in aggregated or provider-supported forms. Read it before putting sensitive work on either host.",
              },
              {
                lead: "On Hivra:",
                text: `${CLI_RUN_LIFETIME} Hivra does not promise backups, so copy out anything you cannot lose, on either host.`,
              },
              {
                lead: "Other agents on Hivra:",
                text: SERVER_SIDE_AGENTS_KEEP_WORKING,
              },
            ],
          },
        ],
      },
      cautionSection(COMPETITOR_FACTS_CHECKED),
    ],
    sources: priceSources(sourcesFor("vs-nous-hermes-cloud"), [
      "Nous Hermes Cloud's page asks for at least $2 of credit, or an active subscription, to deploy. Per-size daily prices are shown only in the Portal deploy screen, so none are quoted here.",
      "Not stated on the Nous pages we read: per-size instance prices on its public pages, a vCPU count for its plans, how unspent credit is refunded, a numeric uptime commitment, and where data is stored or how it is encrypted. Its terms promise commercially reasonable efforts to keep services available, and its Hermes Agent docs describe self-hosting without mentioning Cloud Agents.",
      "Nothing quoted above is a sale price. The plan prices and credit minimum are read from the Portal's public pages.",
    ]),
    faqs: [
      {
        q: "Is Hivra affiliated with Nous Research?",
        a: "No. Nous makes Hermes. Hivra is an independent platform that offers Hermes hosting, and it is not affiliated with, endorsed by or a partner of Nous Research.",
      },
      {
        q: "How much does Nous Hermes Cloud cost?",
        a: `Nous lists monthly plans at $20, $100 and $200, each with one cloud agent, and bills extra or larger agents by the day from credit. Its public pages do not list per-size daily prices, which are shown only in the Portal deploy screen. The $2 credit minimum is the cheapest way in, and the cheapest plan is $20 a month. Hivra is ${ENTRY_PRICE_PROSE}. Figures as of ${formatCheckedMonth()}.`,
      },
      {
        q: "When does metered hosting make sense?",
        a: "When an agent is idle for substantial periods and you do not need it running continuously. Nous bills compute by the second while an agent runs and storage only while it is stopped, but jobs that need a running agent do not run while it is stopped.",
      },
      {
        q: "Can I use Nous Hermes Cloud and Hivra together?",
        a: "Yes. Nothing ties an account on one to the other. A common split is a Nous agent for Hermes on its own models and a Hivra computer for the other agents you open and use every day.",
      },
      {
        q: "Does Hivra include AI usage in the monthly price?",
        a: AI_USAGE,
      },
      {
        q: "Can I keep a Hermes agent running all day on each?",
        a: `On Hivra it is simple. ${STAYS_ON} On Nous, a running agent is metered by the second, and its pages say agents scale to zero when idle without saying whether that is automatic. A stopped agent does not run jobs.`,
      },
      {
        q: "What happens to my data if I stop or delete a Nous agent?",
        a: "Nous says an agent's files, memory and configuration remain whether it is running or stopped, and a deleted instance is not billed. Its terms say your data is stored for six months after termination to allow reopening, with earlier deletion available on request.",
      },
      {
        q: "Does Nous refund unused credit?",
        a: "Its terms say all fees are non-refundable and there are no refunds or credits for periods you did not use your account. Hivra has a 7-day money-back guarantee on card payments.",
      },
      {
        q: "Which is better for Hermes, Nous or Hivra?",
        a: "Nous if you only run Hermes and want the vendor's own cloud, with its models and a plan that bundles an agent. Hivra if you want a fixed monthly price, a computer you open with a terminal and files, and room to run other agents such as Claude Code or Codex.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-self-hosted", "vs-agent-37", "vs-hostinger", "ai-agent-hosting-alternatives"],
      blog: ["self-hosting-hermes-guide", "what-is-hermes-agent"],
      agents: ["hermes"],
      docs: ["hermes", "models-and-credits"],
      pricing: true,
      extra: [{ label: "Cost calculator", href: HOSTING_COST_CALCULATOR_HREF }],
    }),
  },
};

export const HOST_COMPARISON_SLUGS = Object.keys(HOST_COMPARISONS) as CompetitorSlug[];
