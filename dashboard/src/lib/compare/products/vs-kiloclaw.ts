import { HOSTED_COMPUTE_NEEDS_PLAN_SHORT, ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "@/lib/blog/plan-facts";
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
  slug: "vs-kiloclaw",
  browserTitle: "KiloClaw (Kilo) vs Hivra: hosted OpenClaw or an agent computer | Hivra",
  h1: "KiloClaw (Kilo) vs Hivra: hosted OpenClaw or a computer for any agent",
  metaDescription: `KiloClaw is hosted OpenClaw at varying prices; Hivra is ${ENTRY_PRICE_PROSE}. Where each fits. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "KiloClaw and Hivra both host an always-on AI agent so it keeps working when your laptop is shut, but they are built around different ideas. KiloClaw is Kilo's managed, hosted version of OpenClaw, the open-source agent. Kilo's own launch post describes it as a running OpenClaw instance that you reach from your Kilo account, with AI models billed through Kilo's gateway. Hivra is a managed computer: you pick a supported agent, Hivra provisions the machine, and you open it in a browser and use it.",
        "OpenClaw is one of the agents Hivra can run, so for an OpenClaw user the two overlap. The practical question is whether you want a hosted OpenClaw product that sits inside an AI coding company's account and billing, or a computer of your own where OpenClaw is one choice among several agents.",
        "A word of caution before the detail. When we collected these figures, the KiloClaw pages on kilo.ai that we had found through search, including its product page, its pricing explainers and its comparison pages, redirected to Kilo's home page, and the Kilo documentation path for KiloClaw redirected to a general getting-started page. We could not confirm from Kilo's own site today that KiloClaw is still sold, or at what price. Everything below about KiloClaw comes from Kilo's blog posts, a Kilo-branded notice page and press coverage that remain online, and we label each figure with where it came from.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        `KiloClaw's price is the hardest thing on this page to pin down, because Kilo's own pages give different figures. As of ${AS_OF}, the figures we could read are these. Kilo's pricing post, written around the March 2026 launch, says "KiloClaw compute is $49/month", covering "your hosted instance compute costs and the control plane from Kilo", with AI inference billed separately through Kilo Gateway. The same post offered the first 1,000 users six months of compute at 50% off, and it later says "First 100 only!", so the size of that offer is inconsistent on the page. An update dated 17 March 2026 on the same post says Kilo had "released two pricing tiers": "either $25/month month-to-month or $9/month with a 6-month commitment".`,
        `A separate Kilo-branded notice page, at news.kilocode.ai, tells a user whose trial has ended that the Standard plan is "$9/month", "Month-to-month, cancel anytime", with "Just $4 for your first month", and that a "Commit" plan at "$8/month" is a 6-month subscription "$48 paid upfront", which it describes as saving 11% against Standard. We cannot reconcile the $25 month-to-month figure with the $9 month-to-month figure, and the notice page carries no date, so we do not know which is current. Treat the range from $9 to $49 a month for compute as what Kilo has published, and confirm the live figure with Kilo before you pay.`,
        "Neither the pricing post nor the notice page states the hardware behind the price. We found no vCPU, memory or storage figure for a KiloClaw instance. Kilo's launch coverage in VentureBeat says the service runs on a multi-tenant virtual machine architecture powered by Fly.io, which tells you the platform but not the size. Without a stated size, a KiloClaw price cannot be compared with a Hivra plan on dollars per vCPU, and this page does not try to.",
        "On trials, the pricing post says the one-week clock for free compute did not start until 16 March 2026 and that compute charges began on 23 March 2026, and VentureBeat's launch report says new users got a week of free compute. Those dates have passed, and we could not confirm whether a trial still exists. The notice page opens by telling the user that the KiloClaw trial of free compute has come to an end, which suggests it lasts a short period for each user.",
        "AI usage is a second cost on both sides. Kilo says it charges model tokens with zero markup, offers 500+ models through Kilo Gateway, lets you bring your own keys, and includes some free models for the time being, per its launch posts. It also sells Kilo Pass, a subscription of bonus credits: its pricing post lists Kilo Pass Pro at $49 a month with up to $68.60 a month in credits, and VentureBeat's example is $199 a month for $278.60 in credits. Those are Kilo's figures for credit packs, not for the hosted instance.",
        `Hivra charges for a computer rather than for a hosted copy of one agent: ${ENTRY_PRICE_PROSE}. ${AI_USAGE} On the lowest KiloClaw figure we found, its compute fee is below Hivra's entry price, but the sizes are not stated, so the two are not like for like. On the highest, they are far apart in Hivra's favour. Add model usage to either side before you decide.`,
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `Hivra is for a person who wants an agent to have a computer of its own and would rather open it than assemble it. You choose a supported agent, Hivra creates the computer and runs the agent's own installer, and you work through a browser view for that agent. Hivra starts at ${ENTRY_PRICE_PROSE}, and ${STAYS_ON}`,
        "Where Hivra differs from KiloClaw is in what the money buys. Hivra hosts several agents, including Hermes, OpenClaw, Agent Zero, Claude Code and Codex, so you can change agent without moving to a different product. The plan price is stated with its size, and AI usage is paid with your own account or key where the agent supports it, or with Hivra credits. Hivra's platform is open source, and you can also connect a server you run yourself, which is a way out that does not depend on the vendor continuing to sell one product.",
        "The trade-offs are real. Hivra is a flat fee even in a month when the agent does little. It has no gateway of 500+ models under one bill. We do not claim a mobile app or a Slack integration of our own for managing agents. And a Hivra computer is a more general thing than you may want if all you need is OpenClaw with the least setup.",
        "Hivra is independent and is not affiliated with Kilo, Anaconda, OpenClaw, Anthropic or OpenAI, whose tools or agents it may run or be compared with. A free Hivra account does not include managed compute. A free account works with a server you connect yourself.",
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "KiloClaw is the better choice if you already live in Kilo. Kilo says your existing Kilo account, credits and billing carry over to KiloClaw, so a developer who already pays for Kilo credits and routes models through its gateway does not open a second account or a second bill. The 500+ model catalogue and the zero-markup stance on tokens are the strongest part of Kilo's offer, and Hivra has no equivalent single gateway.",
        "KiloClaw is also better if you want OpenClaw and nothing else, with the least to think about. Kilo's launch post describes a quick deployment of a running instance, with no figure we could measure, and positions it against self-hosting that needs SSH, Node.js dependencies and manual updates. VentureBeat reports Kilo saying it hosts the upstream OpenClaw project so updates arrive automatically, and that it handles network security, sandboxing and two proxies outside the virtual machine, with a one-time access code to validate a new device. A single-purpose product with those defaults can be simpler than a general computer.",
        "On price, KiloClaw may also win. If the $9 a month figure on Kilo's notice page is current, it may be a lower monthly fee than Hivra's entry plan, and the commitment tier may be lower again. If you only run OpenClaw and the instance size is enough for you, that can be the cheaper path, though you should confirm the figure and the size first.",
        "Kilo also has a reach that Hivra does not claim. Its home page says its cloud agents are reachable from a browser, Slack and the Kilo Mobile app, and it describes sessions that sync across its editor extensions, command line and cloud agents, and Anaconda describes Kilo Code as open source. If your team already manages agents from those places, a hosted OpenClaw that shares the account can fit that workflow. The caveat is continuity: we could not confirm KiloClaw's current status, and Kilo has since been acquired by Anaconda, according to Anaconda's July 2026 newsletter. Anaconda's newsletter quotes a post saying nothing changes about a Kilo Code setup today, which is about Kilo Code and not specifically KiloClaw.",
        "Choose Hivra when you want the freedom to run more than one agent, a stated size for the money, an open source platform and the option to connect your own server, and when you would rather not depend on one vendor's product line.",
      ),
    },
    {
      heading: "At a glance",
      blocks: [
        {
          kind: "glance",
          caption: "Hivra and KiloClaw (Kilo) compared",
          rows: [
            { criterion: "Price model", hivra: `Flat monthly price: ${ENTRY_PLAN_PRICE}/mo for ${ENTRY_PLAN_SIZE}`, alternative: `Monthly compute fee, with figures that differ across Kilo's own pages: $49/mo, $25/mo, $9/mo and a $48 six-month prepay, as of ${AS_OF}; current price not confirmed` },
            { criterion: "What you get", hivra: "A managed computer with a supported agent installed, opened in a browser", alternative: "A hosted OpenClaw instance managed by Kilo, tied to a Kilo account" },
            { criterion: "Compute", hivra: `${ENTRY_PLAN_SIZE}, stated`, alternative: "Not stated; coverage says multi-tenant virtual machines on Fly.io" },
            { criterion: "What stays on", hivra: STAYS_ON, alternative: "Described as always on, with scheduled automations and persistent memory, per VentureBeat's launch report" },
            { criterion: "Persistence", hivra: "Files, sessions and login stay on the computer", alternative: "Kilo describes persistent memory; storage size and retention are not stated" },
            { criterion: "Supported agents", hivra: HIVRA_AGENTS_CELL, alternative: "OpenClaw only" },
            { criterion: "Models and AI cost", hivra: AI_ACCESS_CELL, alternative: "Kilo Gateway with 500+ models at the vendors' rates and no markup, or your own keys; some free models; Kilo Pass credit packs" },
            { criterion: "Access method", hivra: "A browser view for the agent, which varies by agent", alternative: "Chat apps such as Slack and Telegram, and a terminal, per VentureBeat; a one-time access code for a new device" },
            { criterion: "Setup effort", hivra: "Choose an agent and open it", alternative: "Kilo describes a quick deployment in its launch post, which we did not time" },
            { criterion: "Who maintains it", hivra: "Hivra provisions the computer; you keep the agent's own settings", alternative: "Kilo runs the platform and, per VentureBeat, applies OpenClaw updates automatically" },
            { criterion: "Data and security", hivra: "Your own computer on Hivra Cloud, with files and sessions kept on it", alternative: "Multi-tenant virtual machines, with two proxies outside the VM and sandboxing handled by Kilo, per VentureBeat; compliance status not confirmed" },
            { criterion: "Limits", hivra: "Set by the size of the computer", alternative: "Not stated for the instance; model limits follow the models you choose" },
            { criterion: "Trial", hivra: `No trial; a free account does not include managed compute. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT}`, alternative: "A week of free compute at launch in 2026; whether it is still offered is not confirmed" },
            { criterion: "Refund", hivra: REFUND_LINKED, alternative: "Not stated on the pages we read; the notice page says month-to-month, cancel anytime" },
            { criterion: "Exit and portability", hivra: "Open source platform; you can also connect your own server", alternative: "OpenClaw is open source; whether you can export a KiloClaw instance is not stated" },
            { criterion: "Availability", hivra: "Sold at Hivra's pricing page", alternative: "KiloClaw's product and pricing pages redirected to Kilo's home page when we checked; availability not confirmed" },
            { criterion: "Best for", hivra: "A developer who wants an agent's own computer, open and ready", alternative: "An existing Kilo user who wants only hosted OpenClaw on the same account" },
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
            { lead: "Maya, who already pays for Kilo credits and uses its gateway every day:", text: "She wants OpenClaw running without a new account or a second bill. Pick KiloClaw, if Kilo confirms it is still on sale. Her credits, billing and model routing carry over, which is the main thing Kilo offers that Hivra does not." },
            { lead: "Tom, who runs one agent for his own side projects and may change agent later:", text: `He wants to open it from a browser in the evening and find his repos and sessions as he left them, and he may try Claude Code or Hermes next month. Pick Hivra at ${ENTRY_PRICE_PROSE}. Changing agent does not mean changing product.` },
            { lead: "Priya, who wants OpenClaw only and watches every dollar:", text: "If Kilo confirms a $9 a month plan and its size suits her, KiloClaw may cost less than a flat computer. Pick KiloClaw after she has the live price and size in writing, and has added model usage to both sides." },
            { lead: "Jonas, who wants an agent working on a schedule every day:", text: "Either can do it. KiloClaw is described as always on with scheduled automations. On Hivra the computer stays on, and for Claude Code or Codex he should start a long run inside tmux in the computer's Terminal tab, or send Claude Code work through Telegram. Pick whichever agent he already trusts: OpenClaw runs on both." },
            { lead: "Dana, a platform engineer who needs a data and security story she can write down:", text: "She needs stated certifications, regions and retention. We found none of those for KiloClaw or for Hivra on the pages we read, so neither can be picked on that basis today. She should ask both vendors in writing, and Hivra's connect-your-own-server option is the way to keep the machine under her own control." },
            { lead: "Sam, a founder who would rather not forecast a bill:", text: "A flat figure for the computer is easier to approve than a hosted fee that has appeared at several different prices. Pick Hivra, and put model usage on the account or key he already pays for." },
            { lead: "Leo, who wants a home for several agents:", text: "Use Hivra for the computer that hosts them. If he also wants Kilo's gateway for models, he can use his Kilo key where an agent supports bringing its own key, and pay each side on its own terms." },
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
            { lead: "Confirm KiloClaw exists today.", text: "Ask Kilo for the current plan, price, instance size and whether a trial is offered, in writing. Our own checks of its product and pricing pages ended at its home page, so do this before you plan around it." },
            { lead: "Pick one real task.", text: "Use something your agent already does, such as a scheduled report or a repo it keeps up to date, so both runs do the same work. Use OpenClaw on both sides so the agent is the same." },
            { lead: "Run it on KiloClaw.", text: "Start the plan Kilo confirms and run the task. Note what the hosted fee is, which models you choose and what they cost on your Kilo credits." },
            { lead: "Run it on Hivra.", text: `Sign up for a Hivra account, which costs nothing, then launch a computer for OpenClaw on a paid plan. There is a ${REFUND_LINKED} if it is not right.` },
            { lead: "Leave both alone overnight.", text: "In the morning, check which one finished the scheduled work and whether the agent's memory, files and login were where you left them." },
            { lead: "Compare a full month.", text: `Add up the KiloClaw compute fee and your model usage against ${ENTRY_PRICE_PROSE} plus model usage.` },
          ],
        },
      ],
    },
    {
      heading: "What survives, and for how long",
      blocks: paragraphs(
        "On KiloClaw, the pages we read describe the agent as always on, with persistent memory and scheduled automations, and VentureBeat quotes Kilo's chief executive saying it is always on, waiting for a WhatsApp or Slack message. They do not say how much storage an instance has, how long data is kept after you cancel, whether it is backed up, or what happens to an instance if a trial ends and no plan is bought. Kilo's notice page says to subscribe to keep the agent running, which implies the instance does not carry on after the trial without a plan.",
        `On Hivra, ${STAYS_ON} The computer keeps your files, sessions and login. Hivra does not promise backups, so keep your own copy of anything you cannot lose, on either platform.`,
        "One more point is about the platform behind the product. KiloClaw is one product from a company that has been acquired, and its dedicated pages were not reachable when we checked. A reasonable precaution with any hosted agent is to keep your skills, configuration and important files in a place you control, so that you can restart elsewhere. OpenClaw itself is open source, so a copy of its configuration is portable in principle, though we have not tested moving a KiloClaw instance anywhere.",
      ),
    },
    cautionSection(PRODUCT_FACTS_CHECKED),
  ],
  sources: priceSources(
    [
      { label: "Kilo home page", href: "https://kilo.ai/" },
      { label: "KiloClaw pricing post (Kilo blog)", href: "https://blog.kilo.ai/p/kiloclaw-pricing" },
      { label: "Kilo Claw: Hosted OpenClaw in 60 Seconds (Kilo blog)", href: "https://blog.kilo.ai/p/hosted-openclaw-in-60-seconds" },
      { label: "KiloClaw trial notice (Kilo)", href: "https://news.kilocode.ai/kilo-claw-trial-expiration.html" },
      { label: "Kilo launches KiloClaw (VentureBeat)", href: "https://venturebeat.com/orchestration/kilo-launches-kiloclaw-allowing-anyone-to-deploy-hosted-openclaw-agents-into" },
      { label: "Running OpenClaw with a Claude subscription (Kilo blog)", href: "https://blog.kilo.ai/p/i-was-running-openclaw-with-my-claude" },
      { label: "Kilo documentation", href: "https://kilo.ai/docs/getting-started" },
      { label: "Anaconda newsletter, July 2026", href: "https://www.anaconda.com/newsletter/2026-07-numerically-speaking" },
    ],
    [
      "KiloClaw's prices differ between Kilo's own pages and may not be current: $49 a month compute, $25 a month month-to-month, $9 a month with a 6-month commitment, and a notice page with $9 a month, $4 for the first month, and an $8 a month Commit plan paid as $48 upfront for six months. The presale offer is described as both the first 1,000 users and the first 100. The $199 for $278.60 Kilo Pass figure is VentureBeat's example, not a KiloClaw price.",
      "Not confirmed: whether KiloClaw is still on sale, because kilo.ai/kiloclaw, its hosted-OpenClaw and alternatives pages and its documentation path redirected to Kilo's home or getting-started pages when we checked. Also not stated on the pages we read: instance vCPU, memory and storage, regions, a refund policy, data retention, backups, compliance certifications, which chat channels KiloClaw supports in particular, whether the KiloClaw hosting layer is open source, and whether a trial is still offered. The claims about Fly.io, proxies, sandboxing, an access code and automatic updates come from VentureBeat's report of Kilo's statements, not from a Kilo page we could open.",
    ],
    false,
    PRODUCT_FACTS_CHECKED,
  ),
  faqs: [
    {
      q: "How much does KiloClaw cost?",
      a: `Kilo's own pages disagree. As of ${AS_OF}, its pricing post lists compute at $49 a month, then a March 2026 update lists $25 a month month-to-month or $9 a month with a 6-month commitment, and a Kilo notice page lists Standard at $9 a month with $4 for the first month, or a Commit plan at $8 a month, $48 paid upfront for six months. AI usage is billed separately. Hivra is ${ENTRY_PRICE_PROSE}, flat.`,
    },
    {
      q: "Is KiloClaw cheaper than Hivra?",
      a: "On the lowest figure Kilo has published, its compute fee is lower than Hivra's entry price, but KiloClaw does not state an instance size, so it is not a like for like comparison. On its highest published figure it costs far more. Confirm the live price and size with Kilo, then add model usage to both before comparing.",
    },
    {
      q: "Is KiloClaw still available?",
      a: "We could not confirm it. When we checked, Kilo's KiloClaw product and pricing pages redirected to its home page. Its blog posts and a trial notice remain online, and the launch was reported in February 2026. Ask Kilo directly before you rely on it.",
    },
    {
      q: "Can I run OpenClaw on Hivra?",
      a: "Yes. OpenClaw is one of the agents Hivra can run, alongside Hermes, Agent Zero, Claude Code and Codex. It runs on the computer itself and needs no open browser. Hivra is not affiliated with Kilo, OpenClaw, Anthropic or OpenAI.",
    },
    {
      q: "Can I use KiloClaw and Hivra together?",
      a: "Yes. They are separate products and you pay each on its own terms. You could also use Kilo's model gateway with an agent on a Hivra computer where that agent supports bringing its own key, though we have not tested it.",
    },
    {
      q: "Does KiloClaw keep running when I close my laptop?",
      a: "It is described as always on, running in Kilo's cloud with scheduled automations and persistent memory, according to its launch coverage. The pages we read do not say what happens when a trial or subscription ends beyond a notice to subscribe to keep the agent running.",
    },
    {
      q: "Can I keep an agent running 24/7 on each?",
      a: `${STAYS_ON} For Claude Code or Codex, a run started inside tmux in the Terminal tab, or Claude Code work sent through Telegram, keeps going after you close the laptop. Hermes, OpenClaw and Agent Zero run on the computer itself. KiloClaw is described as always on for OpenClaw.`,
    },
    {
      q: "What happens to my data on each?",
      a: "On KiloClaw, the pages we read describe persistent memory but do not state storage size, retention after cancelling, backups or regions. On Hivra, the computer keeps your files, sessions and login, but Hivra does not promise backups, so keep your own copy of anything important.",
    },
    {
      q: "Does Hivra include AI usage in its price?",
      a: `No. ${AI_USAGE} Kilo likewise bills AI usage separately from KiloClaw compute, at the model vendors' rates with no markup, according to its posts.`,
    },
  ],
  closing: CLOSING,
  related: relatedLinks({
    comparisons: ["vs-fly-sprites", "ai-agent-hosting-alternatives", "vs-agent-37"],
    blog: ["ai-agent-hosting-guide", "cost-of-running-ai-agent"],
    agents: ["openclaw"],
    docs: ["openclaw"],
    pricing: true,
  }),
};
