import type { ComparePage } from "./types";
import { formatCheckedMonth } from "./competitor-facts";
import {
  AI_USAGE,
  CLOSING,
  ENTRY_PRICE_PROSE,
  PRICES_AS_OF_STAMP,
  cautionSection,
  paragraphs,
} from "./shared-copy";

/**
 * The /compare directory (scratchpad batches/b04, file 01). It keeps the dated price
 * table the page has always carried, because the supplied copy's own editorial
 * checks ask for the existing comparison table to be restored, and /llms.txt
 * describes this page as having one.
 */
export const COMPARE_DIRECTORY: ComparePage = {
  slug: "",
  browserTitle: "Hivra compared with the alternatives | Hivra",
  h1: "Hivra compared with the alternatives",
  metaDescription: `Hivra compared with agent hosts, Claude Code, Codex, Cursor, Codespaces, Sprites, E2B and a VPS, with a dated price table. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "Choosing where an AI agent lives should not require believing every vendor's favourite comparison chart. Start with the way you actually work: one assistant that runs every day, coding tasks that a model maker's cloud product runs for you, short-lived sandboxes started from code, a developer workspace, or a Linux server you are happy to maintain. These are different problems, and no single product wins all of them.",
        "Start with the plan tables above for personal agent hosting. The guides below cover hosts that run the same agents, agent products from model makers, sandboxes and developer environments, and do-it-yourself routes. Each guide says where the alternative is the better choice and dates its sources.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        "The question is not just how much RAM you get for the money. Ask what survives a restart, whether the agent stays on while you are away, who applies security updates, and what happens if the service changes its prices. Model costs are usually separate, so factor those into your calculation as well.",
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `For Hivra, the offer is fairly simple: a cloud computer for your agent, with its files and working environment kept in place for as long as the agent exists. Paid hosting starts at ${ENTRY_PRICE_PROSE}. ${AI_USAGE} It is a better fit for a persistent assistant than for thousands of temporary sandboxes.`,
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "If you want root control and the cheapest infrastructure bill, self-hosting is often better. If you want a purpose-built computer-use product, a sandbox API that your own code drives, a developer workspace tied to your repositories, or a model maker's own cloud agent that comes with a subscription you already pay for, those alternatives may suit you better, and each comparison page says when.",
      ),
    },
    {
      heading: "Hosts for the same agents",
      blocks: [
        ...paragraphs(
          "These sell a computer or server where an agent such as Hermes or OpenClaw can run all day. Most compete with Hivra on price and on how much of the machine you manage.",
        ),
        {
          kind: "providers",
          items: [
            { slug: "vs-agent-37", label: "Agent 37", text: "metered raw compute, a free tier and external assurance claims worth examining." },
            { slug: "vs-lobsterland", label: "Lobsterland", text: "managed OpenClaw and Hermes hosting from a low monthly price, with a trial." },
            { slug: "vs-kiloclaw", label: "KiloClaw", text: "hosted OpenClaw from Kilo, with no markup on model tokens." },
            { slug: "vs-construct-computer", label: "Construct Computer", text: "a crew of named agents, each with its own computer, sold by plan." },
            { slug: "vs-hostinger", label: "Hostinger", text: "attractive long-term prepaid offers and general VPS control." },
            { slug: "vs-xcloud", label: "xCloud", text: "a dedicated managed server with a larger entry disk, Paperclip hosting and a control-panel workflow." },
            { slug: "vs-nous-hermes-cloud", label: "Nous Hermes Cloud", text: "usage-based hosting from Hermes' own developers." },
            { slug: "vs-railway", label: "Railway", text: "a well-established general deployment platform." },
            { slug: "vs-render", label: "Render", text: "an available Hermes template with configuration work remaining." },
          ],
        },
      ],
    },
    {
      heading: "Agent products from the model makers",
      blocks: [
        ...paragraphs(
          "These are products from the companies behind the models, where a task runs in their cloud. Hivra is a different shape: a computer that stays on, where you open the agent. Hivra is not affiliated with any of them.",
        ),
        {
          kind: "providers",
          items: [
            { slug: "vs-claude-code-on-the-web", label: "Claude Code on the web", text: "sessions that come with a Claude subscription, against a computer you open and leave on." },
            { slug: "vs-openai-codex-cloud", label: "OpenAI Codex cloud", text: "tasks run in OpenAI-managed sandboxes, against the Codex command line tool on a computer of its own." },
            { slug: "vs-cursor-cloud-agents", label: "Cursor cloud agents", text: "background agents inside the Cursor editor and its plans, against an agent computer with no editor tie-in." },
          ],
        },
      ],
    },
    {
      heading: "Sandboxes and developer environments",
      blocks: [
        ...paragraphs(
          "These are built for code to start and stop machines, or for a developer to work in. They suit short-lived or bursty work better than Hivra does, and Hivra suits a long-lived agent better than they do.",
        ),
        {
          kind: "providers",
          items: [
            { slug: "vs-e2b", label: "E2B sandboxes", text: "a sandbox API billed per second, strong for generated code run at scale." },
            { slug: "vs-orgo", label: "Orgo", text: "Linux, Windows and Mac cloud desktops for agents, driven by SDK or MCP." },
            { slug: "vs-machine0", label: "machine0", text: "persistent per-minute VMs for agents driven by CLI or MCP." },
            { slug: "vs-simular-box", label: "Simular box", text: "a cloud desktop per user that Claude, ChatGPT or Codex drive over MCP." },
            { slug: "vs-cubicles", label: "Cubicles", text: "an Ubuntu desktop with agents preinstalled, free in beta." },
            { slug: "vs-fly-sprites", label: "Fly.io Sprites", text: "programmable machines billed for the hours they run, that sleep when idle." },
            { slug: "vs-github-codespaces", label: "GitHub Codespaces", text: "a repository-centred developer workspace that stops when idle." },
          ],
        },
      ],
    },
    {
      heading: "Do it yourself, or change agent",
      blocks: [
        ...paragraphs("The routes that do not involve a new vendor: run your own server, move between agents, or choose the kind of computer first."),
        {
          kind: "providers",
          items: [
            { slug: "vs-self-hosted", label: "Self-hosted VPS", text: "more control and often less cash, with the maintenance on you." },
            { slug: "openclaw-to-hermes", label: "OpenClaw to Hermes", text: "a practical migration decision, not a forced upgrade." },
            { slug: "ai-agent-hosting-alternatives", label: "Broader hosting choices", text: "including sandboxes and GUI-oriented computers." },
          ],
        },
      ],
    },
    {
      heading: "What does each host cost?",
      blocks: [
        ...paragraphs(
          `Sizes differ between providers, so each row states its own. Prices are in US dollars, from each provider's published pages, as of ${formatCheckedMonth()}. Model usage is extra unless a row says otherwise. Hostinger shows its managed plan and its KVM 2 VPS at sale prices, so check its pages. Nous now shows sizes and prices only after you sign in to its Portal, so its row shows the last published figures. Cloudways isn't listed, because its page doesn't say whether its prices already include its launch discount. The table covers the hosts that sell a comparable computer by price. The agent products and sandboxes above are billed by subscription or by usage, so their figures are on their own comparison pages, each with its own month.`,
        ),
        { kind: "priceTable", caption: "Price table" } as const,
      ],
    },
    cautionSection(),
  ],
  faqs: [
    {
      q: "What does Hivra charge?",
      a: `Hivra hosting starts at ${ENTRY_PRICE_PROSE}, excluding model usage.`,
    },
    {
      q: "Is self-hosting a legitimate alternative?",
      a: "Absolutely. It offers more control and often a lower infrastructure bill, provided you are willing to maintain the machine.",
    },
    {
      q: "Which comparison should I read first?",
      a: "Start with the kind of product you are weighing. If you are choosing a host for an agent, read the host pages. If you are weighing a model maker's cloud agent, read the Claude Code, Codex or Cursor pages. If your own code will start and stop machines, read the E2B and Sprites pages. If you are unsure, the page on broader hosting choices compares the kinds of computer first.",
    },
    {
      q: "Is Hivra affiliated with the products it is compared with?",
      a: "No. Hivra is independent. It is not affiliated with, endorsed by or a partner of the hosts, model makers or platforms on these pages, and where it runs an agent such as Claude Code or Codex it runs the vendor's own command line tool.",
    },
    {
      q: "How current are the prices on these pages?",
      a: "Each comparison states the month its vendor figures were collected, from the vendor's published pages, and the price table says the same. Vendors change prices and terms, so confirm any figure against the provider's current page before you buy.",
    },
    {
      q: "Is Hivra the cheapest option?",
      a: "Often not. A prepaid VPS, a metered sandbox used a few hours a week or a subscription you already pay for can cost less. Hivra is a flat monthly price for a computer that stays on, with the agent set up, and each comparison names the cases where the alternative wins.",
    },
    {
      q: "Can I use Hivra together with one of these?",
      a: "Yes, in several cases. An agent on a Hivra computer can call a sandbox API when it needs a clean, disposable environment, and a developer workspace can sit beside it for your own editing. Each is paid for on its own terms.",
    },
  ],
  closing: CLOSING,
  related: [],
};
