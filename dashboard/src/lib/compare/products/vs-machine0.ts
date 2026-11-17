import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import type { ComparePage } from "../types";
import { formatCheckedMonth } from "../competitor-facts";
import {
  AI_ACCESS_CELL,
  AI_USAGE,
  CLOSING,
  ENTRY_PRICE_PROSE,
  HIVRA_AGENTS_CELL,
  PRICES_AS_OF_STAMP,
  REFUND_LINKED,
  STAYS_ON,
  cautionSection,
  paragraphs,
  priceSources,
  relatedLinks,
} from "../shared-copy";
import { PRODUCT_FACTS_CHECKED } from "./checked";

const AS_OF = formatCheckedMonth(PRODUCT_FACTS_CHECKED);

export const page: ComparePage = {
  slug: "vs-machine0",
  browserTitle: "machine0 vs Hivra: per-minute VMs or a ready agent computer | Hivra",
  h1: "machine0 vs Hivra: pay-per-minute cloud VMs or a ready agent computer",
  metaDescription: `machine0 bills VMs per minute from $0.013 an hour; Hivra is ${ENTRY_PRICE_PROSE}. Where each fits an agent. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "machine0 and Hivra both give an AI agent a persistent Linux computer that is not your laptop, but they are different kinds of product. machine0 describes itself as persistent cloud VMs designed for long-running agents: you create a virtual machine from a command-line tool, connect over SSH or a browser endpoint, and pay by the minute for the size you chose. Hivra is a managed, ready-to-open agent computer: you pick a supported agent, Hivra provisions the machine and sets the agent up, and you open it in a browser at a flat monthly price.",
        "So the question is less which one is cheaper and more who is meant to drive. If you want a plain VM, in the region and size you choose, that you or your agent can create, suspend and destroy from a command line, machine0 is built for that. If you want one computer with an agent already on it, that is there each time you come back, Hivra is built for that.",
        "The two are closer than E2B or Fly.io Sprites, because both hand you a machine that stays on until you decide otherwise (on machine0, unless you turn on idle detection or your balance runs low). The differences are in who sets up the agent, how you are billed, and how much of the machine you are expected to run yourself.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `machine0 is pay-as-you-go. As of ${AS_OF}, its homepage says billing is per minute, with the same price in every region, and that CPU machines start at $0.013 an hour and GPU machines at $0.836 an hour. Its pricing page repeats the same rates. Its terms say you add funds to a wallet through Stripe with a minimum top-up of $5, and that creating resources requires a balance that covers 10 hours of usage. If the balance falls below 1 hour of runway, running resources may be suspended or destroyed automatically. Its pricing page describes the suspension threshold differently (enough to store saved images and disks for a week) and says auto top-up is on by default once a card is saved, so check how your own account is set up.`,
        "machine0 lists these CPU sizes, each with the approximate monthly figure it gives. Small is 1 vCPU, 1 GB of RAM and 25 GB of disk at $0.013 an hour (about $9 a month). Medium is 2 vCPU, 2 GB and 60 GB at $0.034 an hour (about $25). Large is 2 vCPU, 4 GB and 80 GB at $0.052 an hour (about $38). XL is 4 vCPU, 8 GB and 160 GB at $0.104 an hour (about $76). XXL is 8 vCPU, 16 GB and 320 GB at $0.208 an hour (about $152). Further sizes run up to 60 vCPU and 240 GB of RAM at $3.714 an hour (about $2,711 a month), and variants marked nvme (newer CPUs with NVMe storage) and premium (dedicated vCPUs) cost more at the same size.",
        "GPU machines are listed from the 1x RTX 4000 Ada size (20 GB of VRAM, 8 vCPU, 32 GB of RAM) at $0.836 an hour, through L40S, RTX 6000 Ada, MI300X, H100 and H200 sizes, up to 8x H200 at $39.336 an hour. Hivra has no GPU computers, so for GPU work machine0 is simply the answer.",
        "As our own arithmetic from the listed rate, the large size at $0.052 an hour comes to about $37.96 across a 730-hour month if it is left running the whole time, which matches the page's own figure of about $38. That is the number to set against Hivra's entry computer, listed below. A machine that is suspended costs far less: the homepage says a suspended VM is billed only for image storage, at $0.078 per GB per month. The pricing page also lists disks at about $0.1667 per GB per month until removed, including through suspend, says a stopped machine is still billed, and lists bandwidth at $0.01 per GiB beyond a free allowance of 1 to 10 TB depending on size, so a suspended machine may not cost only image storage. Confirm in your own account.",
        `Hivra charges for a computer rather than for minutes: ${ENTRY_PRICE_PROSE}. There is no per-minute meter, so the plan price does not change with how long the agent runs. ${AI_USAGE}`,
        "On machine0 the VM is billed for compute and the agent's model usage is separate too: the pages we read describe machines and profiles, not model credits, so you bring your own model account or key there as well.",
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra is for a person who wants an agent to have a computer of its own and would rather open it than assemble it. You choose a supported agent, Hivra creates the computer and runs the agent's own installer, and you work through a browser view that can include chat, a terminal and files, depending on the agent. Hivra starts at ${ENTRY_PRICE_PROSE}, and ${STAYS_ON}`,
        "The trade-offs are control and range. A Hivra computer comes in the sizes Hivra offers and is not a place to pick a region, a GPU or 60 vCPUs. You do not get machine0's CLI-first workflow, and we do not describe a public API or SDK for creating computers from code, so scripting a fleet is not what Hivra offers today.",
        "In return you skip the setup that a bare VM asks for: installing the agent, wiring its login, deciding how it is kept running and opening a way in. Hivra's platform is open source and you can also connect a server you run yourself, so you are not locked to Hivra Cloud.",
        "Hivra is independent and is not affiliated with machine0, Anthropic or OpenAI, whose tools or agents it may run or be compared with. A Hivra account costs nothing, but every Hivra Cloud computer is a paid plan. A free account works with a server you connect yourself.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "machine0 is the better choice when you want a real VM and the control that comes with it. Its docs describe dedicated rather than shared resources (its homepage names only the premium sizes as dedicated vCPUs), up to 60 vCPUs and 240 GB of RAM, a static public IP for each machine with no NAT or tunnels, and an HTTPS endpoint at a machine0 address. If your agent needs a fixed IP, a specific region out of nine, or a larger machine than a flat consumer plan offers, machine0 has it and Hivra does not.",
        "It is also the better choice for GPU work. The homepage lists H100, H200, L40S, MI300X and RTX Ada machines, with GPU sizes available in seven of its regions. Hivra does not sell GPU computers, so a team fine-tuning or serving a model should look at machine0.",
        "machine0 is better when you want to drive everything from code. Its homepage says every operation is a CLI command that supports JSON output, and that a remote MCP server lets agents manage their own fleet, for example creating a VM for a build, saving an image of it and tearing it down. It also lists saved images, golden images and clones, so a team that wants to stamp out identical machines gets a tool for it.",
        "Billing by the minute helps too when usage is uneven. A machine you suspend stops accruing compute charges, and its docs describe opt-in idle detection that can suspend or destroy a VM after a period of inactivity, with a default window of 30 minutes. A person who runs an agent for a few hours a week could pay far less than a flat monthly plan. Its homepage and pricing page also say unused credits are refundable, but its terms set no general refund policy, so the actual terms are unclear; Hivra's guarantee is a ${MONEY_BACK_GUARANTEE}.",
        "Finally, machine0 lists NixOS and Ubuntu images, both open source on GitHub, with reproducible NixOS builds through flakes. Teams that care about declarative, reviewable machine setup will find that more useful than a managed agent install.",
        "Choose Hivra when you want the agent itself to be ready on a computer without you building the machine around it, and when a fixed monthly figure matters more than the lowest possible bill.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and machine0 compared",
          rows: [
            { criterion: "Price model", hivra: `Flat monthly price: ${ENTRY_PLAN_PRICE}/mo for ${ENTRY_PLAN_SIZE}`, alternative: `Pay-as-you-go, billed per minute; CPU machines from $0.013/hr (1 vCPU, 1 GB) and GPU machines from $0.836/hr, as of ${AS_OF}` },
            { criterion: "What you get", hivra: "A managed computer with a supported agent installed, opened in a browser", alternative: "A persistent VM (NixOS or Ubuntu) with a static public IP and an HTTPS endpoint; you set up what runs on it" },
            { criterion: "Compute", hivra: `${ENTRY_PLAN_SIZE}, stated`, alternative: "1 to 60 vCPUs and up to 240 GB of RAM (docs say dedicated; homepage names only premium sizes as dedicated vCPUs); large is 2 vCPU, 4 GB, 80 GB disk at $0.052/hr (about $38/mo)" },
            { criterion: "GPUs", hivra: "None offered", alternative: "Listed from $0.836/hr (RTX 4000 Ada) up to 8x H200 at $39.336/hr" },
            { criterion: "What stays on", hivra: STAYS_ON, alternative: "Stays on until you stop or suspend it; opt-in idle detection can suspend or destroy a VM after a set period (30 minutes by default per its docs); low balance can suspend or destroy it" },
            { criterion: "Persistence", hivra: "Files, sessions and login stay on the computer", alternative: "A suspended VM can be resumed where you left off and is billed for image storage per its homepage (its pricing page also lists disk charges); destroying a VM is irreversible per its terms" },
            { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "Names Claude Code and Codex (preinstalled on the Ubuntu image per its homepage); anything else you install yourself" },
            { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Billed for compute, storage and bandwidth; its pages do not describe model credits, so you bring your own account or key" },
            { criterion: "Access method", hivra: "A browser view for the agent, which varies by agent", alternative: "CLI with JSON output, SSH, an HTTPS endpoint opened in a browser, and a remote MCP server; its pages do not describe a separate REST API" },
            { criterion: "Setup effort", hivra: "Choose an agent and open it", alternative: "Install the CLI, create a VM, connect, and configure the agent, or use profiles to inject credentials, MCP servers, prompts and variables" },
            { criterion: "Who maintains it", hivra: "Hivra provisions the computer; you keep the agent's own settings", alternative: "machine0 runs the platform; you administer the operating system and what runs inside the VM" },
            { criterion: "Regions", hivra: "Not something you choose", alternative: "Nine: New York (two datacenters), San Francisco, London, Amsterdam, Singapore, Toronto, Atlanta and Frankfurt; same price in every region" },
            { criterion: "Data and security", hivra: "Your own computer on Hivra Cloud, with files and sessions kept on it", alternative: "Public IP and an HTTPS endpoint per its homepage; its pages do not describe isolation, compliance certifications or data handling in detail" },
            { criterion: "Uptime commitment", hivra: "No uptime figure is stated here", alternative: "Homepage says 99.99%; its terms give a 99.99% monthly target for CPU VMs and 99% for GPU VMs, with service credits" },
            { criterion: "Refund", hivra: REFUND_LINKED, alternative: "Homepage and pricing page say unused credits are refundable without giving terms; its terms set no general refund policy and say service credits are not refundable as cash" },
            { criterion: "Exit and portability", hivra: "Open source platform; you can also connect your own server", alternative: "Both OS images are open source; account data is deleted within 30 days of termination and you are responsible for your own copies" },
            { criterion: "Best for", hivra: "A developer who wants an agent's own computer, open and ready", alternative: "A developer or team who wants a dedicated VM they control, sized and placed as they choose, possibly with GPUs" },
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
            { lead: "Maya, who wants one Claude Code agent for her own side projects:", text: `She wants to open it from a browser in the evening and find her repos and sessions as she left them. Pick Hivra at ${ENTRY_PRICE_PROSE}. She does not need to choose a region or administer a server.` },
            { lead: "Raj, who fine-tunes models and needs an H100 for a weekend:", text: "He needs a GPU, by the hour, and to stop paying when he is done. Pick machine0. Its homepage lists H100 machines and per-minute billing, and Hivra does not offer GPUs." },
            { lead: "Tom, who is comfortable on a command line and wants root on a small VM:", text: "He would rather install what he likes and pay only for the minutes the machine runs. Pick machine0, or a plain VPS. A suspended machine is billed for storage rather than compute." },
            { lead: "Jonas, who wants an agent working on a schedule every day:", text: "He wants a computer that stays on so the work is there each morning, without thinking about idle rules. Pick Hivra, where the computer stays on. On machine0 he would check whether idle detection is on, since it can suspend or destroy a machine after a period of inactivity, and keep the balance topped up." },
            { lead: "Dana, a platform engineer who needs a fixed IP and a chosen region:", text: "She needs a static public address and a datacenter close to her users. Pick machine0, which lists a static IP for each VM and nine regions." },
            { lead: "Sam, a founder who would rather not forecast a bill:", text: "A flat figure is easier to approve than a balance that has to stay topped up. Pick Hivra, and put model usage on the account or key he already pays for." },
            { lead: "Priya, who wants her agent to spin up and tear down machines for builds:", text: "She wants the agent to create a VM, save an image of it and delete it. Pick machine0, whose homepage describes a remote MCP server for exactly that kind of fleet control." },
            { lead: "Leo, who wants both a home for his agent and heavy machines on demand:", text: "Use both. Keep the agent on a Hivra computer, and let it use a machine0 VM when a job needs more CPU, a GPU or a clean machine." },
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
            { lead: "Pick one real task.", text: "Use something your agent already does, such as a scheduled report or a repo it keeps up to date, so both runs do the same work." },
            { lead: "Run it on machine0.", text: "Add the minimum $5 top-up, install the CLI, create a VM of the size you expect to need, and set the agent up on it. Note how long the setup takes you and which idle setting you chose." },
            { lead: "Run it on Hivra.", text: `Sign up for a Hivra account, which costs nothing, then launch a computer for your agent on a paid plan. There is a ${REFUND_LINKED} if it is not right.` },
            { lead: "Leave both alone overnight.", text: "In the morning, check which one finished the scheduled work and whether the agent's session, files and login were where you left them." },
            { lead: "Compare a full month.", text: `Add up the machine0 minutes, disk and image storage, bandwidth and any suspended-image charges, plus model usage on either side, against ${ENTRY_PRICE_PROSE}.` },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On machine0, the docs say VMs keep running until you stop or suspend them. Suspending freezes the machine's state and pauses compute billing, and you can resume later where you left off. It also lists saved images, golden images and clones. Its pages do not explain in detail what a suspended machine keeps in memory, so test a resume before relying on it.",
        "Two automatic rules can end a running machine. The docs describe opt-in idle detection (`--on-idle suspend|destroy`) that can suspend or destroy a VM after a period of inactivity, with a default window of 30 minutes. The terms say that if your wallet balance drops below 1 hour of runway, running resources may be automatically suspended or destroyed. Both are worth checking in your own account before you leave an agent unattended.",
        "The terms are blunt about the rest: VM destruction is irreversible, you are responsible for backing up your data, closing an account destroys all VMs and images, and account data is deleted within 30 days of termination except where the law requires retention.",
        `On Hivra, ${STAYS_ON} The computer keeps your files, sessions and login. Hivra does not promise backups, so keep your own copy of anything you cannot lose, on either platform.`,
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: priceSources(
    [
      { label: "machine0 homepage", href: "https://machine0.io/" },
      { label: "machine0 pricing", href: "https://machine0.io/pricing" },
      { label: "machine0 documentation", href: "https://docs.machine0.io" },
      { label: "machine0 terms", href: "https://machine0.io/terms" },
    ],
    [
      "machine0's prices appear on both its homepage and its pricing page, and the monthly figures are the pages' own approximations.",
      "Not confirmed from the pages we read: what a suspended machine is billed beyond image storage, the refund terms behind the homepage's statement that unused credits are refundable, what a suspended machine keeps in memory, the isolation and compliance model, which agents beyond Claude Code and Codex are supported, a REST API, whether the homepage's 99.99% figure is backed by more than the terms' monthly credit target, and the answers to the FAQ questions listed on the homepage.",
    ],
    false,
    PRODUCT_FACTS_CHECKED,
  ),
  faqs: [
    {
      q: "How much does machine0 cost?",
      a: `As of ${AS_OF}, machine0's homepage lists CPU machines from $0.013 an hour for 1 vCPU and 1 GB of RAM, with the 2 vCPU and 4 GB size at $0.052 an hour (about $38 a month if left on) and GPU machines from $0.836 an hour. Billing is per minute. Hivra is ${ENTRY_PRICE_PROSE}, flat.`,
    },
    {
      q: "Is machine0 cheaper than Hivra?",
      a: "It can be. A small machine that you suspend when idle can cost very little, and a machine left on all month at the size we compared works out to about the figure its page states. Larger sizes cost more, and Hivra's price does not change with minutes used. Run your own workload and compare a full month.",
    },
    {
      q: "Does machine0 have a free plan or trial?",
      a: "The pages we read do not mention one. They describe pay-as-you-go billing with a minimum top-up of $5. A Hivra account costs nothing, but every Hivra Cloud computer is paid.",
    },
    {
      q: "Can I use machine0 and Hivra together?",
      a: "Yes. They do different jobs. An agent on a Hivra computer can use a machine0 VM when it needs a larger machine, a GPU or a fixed IP, and you pay each on its own terms.",
    },
    {
      q: "Does a machine0 VM keep running when I close my laptop?",
      a: "Yes, as a cloud VM it runs until you stop or suspend it, but its opt-in idle detection can suspend or destroy a VM after a period of inactivity (30 minutes by default), and a low wallet balance can do the same. Check those settings first.",
    },
    {
      q: "Can I keep an agent running 24/7 on each?",
      a: `On Hivra, ${STAYS_ON} On machine0, a VM stays on until you stop or suspend it, as long as idle detection is off (it is opt-in) or set to suit you and your balance stays above the minimum runway its terms describe.`,
    },
    {
      q: "What happens to my data on each?",
      a: "On machine0, a suspended VM can be resumed and is billed for image storage per its homepage, but destroying a VM is irreversible and its terms make you responsible for your own backups. On Hivra, the computer keeps your files, sessions and login, but Hivra does not promise backups, so keep your own copy of anything important.",
    },
    {
      q: "Which one is better for running Claude Code?",
      a: "Both can run it. machine0's homepage says its Ubuntu image comes with Claude Code and Codex preinstalled, and Hivra hosts both too. machine0 suits those who want a VM they control; Hivra suits opening one computer with the agent ready. Hivra is not affiliated with machine0 or Anthropic.",
    },
    {
      q: "Does Hivra include AI usage in its price?",
      a: `No. ${AI_USAGE} machine0's prices cover machines, and the pages we read do not say model usage is included.`,
    },
    {
      q: "Does machine0 offer GPUs, and does Hivra?",
      a: "machine0 lists GPU machines from $0.836 an hour up to 8x H200. Hivra does not offer GPU computers, so GPU work is a reason to choose machine0.",
    },
    {
      q: "Is there a refund on each?",
      a: `machine0's homepage and pricing page say unused credits are refundable but do not give the terms, and its terms set no general refund policy. Hivra has a ${MONEY_BACK_GUARANTEE}.`,
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-e2b", "vs-fly-sprites", "vs-self-hosted", "ai-agent-hosting-alternatives"],
    blog: ["ai-agent-hosting-guide", "cost-of-running-ai-agent"],
    agents: ["claude-code", "codex"],
    docs: ["linux-computer"],
    pricing: true,
  }),
};
