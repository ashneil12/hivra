// Copy for /about, from the owner's rewritten page (October 2026 copy overhaul).
//
// Prose is written the way the page shows it, with two inline marks: **bold**
// and [label](href). inline.tsx renders them; plainText() strips them, so the
// FAQPage JSON-LD and the tests read the same words the page shows.
//
// What the page says is held to what the repository and the site already state:
// - Prices, sizes and the guarantee come from lib/blog/plan-facts.ts, so they
//   move with checkout. No plan names, no annual price, no trial.
// - Hivra runs no free computer (owner decision, 21 Oct 2026). The page says
//   once, in the shared sentences from plan-facts, that every computer Hivra
//   Cloud runs is paid and that a free account works with a computer or server
//   the person connects. No agent is singled out as the paid one.
// - The site names no legal entity, address or funding source, so this page
//   names none: the section the owner called "How Hivra is funded" is titled
//   "What Hivra costs" and states only the price.
// - Marketing copy never names the licence or says public domain.
// - Every sentence about a token renders only when the token surfaces are on
//   and the viewer is not geo-blocked (lib/compliance/token-surface-view.ts).
//   With them off the page keeps the short "no token needed" negations, in the
//   words "a token", and nothing else. buildAboutContent({ tokens }) is the one
//   place that decides, so the visible page, the metadata and the JSON-LD agree.
//
// page.test.tsx pins the required lines and runs the shared banned-claims list
// over everything below.

import { LITEPAPER_HREF } from "@/components/public-site/PublicLink";
import {
  FREE_ACCOUNT_SENTENCE,
  formatPlanSize,
  HOSTED_COMPUTE_NEEDS_PLAN_SHORT,
  MONEY_BACK_GUARANTEE,
} from "@/lib/blog/plan-facts";
import { NON_AFFILIATION_LINE } from "@/lib/brand-description";
import { PUBLIC_PROJECT_LINKS } from "@/lib/public-project-links";
import { SECURITY_EMAIL } from "@/lib/security-contact";

export const ABOUT_TITLE = "About Hivra | Open-source computers for AI agents";
export const ABOUT_DESCRIPTION =
  "Hivra, formerly HermesOS, gives AI agents their own computers. Learn what Hivra does, how it works, what it costs and how to reach us.";

const REPOSITORY_URL = PUBLIC_PROJECT_LINKS.repository.href ?? "https://github.com/ashneil12/hivra";
export const REPOSITORY_LABEL = "github.com/ashneil12/hivra";
const X_URL = PUBLIC_PROJECT_LINKS.x;

/**
 * The sentence that answers "is this the Hivra I am looking for?", word for word
 * as the page carried it before the overhaul (git b9fe7921). The entity question
 * in the FAQ carries it with NON_AFFILIATION_LINE, so the visible answer and the
 * FAQPage JSON-LD (built from the same list) state both exactly.
 */
export const DISAMBIGUATION =
  "Hivra at hivra.cloud is unrelated to other projects called Hivra, such as hivra.ai and hivra.app.";

/** Strips the inline marks, so a plain-text copy of any string cannot drift from the page. */
export function plainText(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1");
}

export interface AboutLead {
  /** The bold opening of a paragraph. */
  lead: string;
  text: string;
}

export interface AboutContact {
  /** Inline marks: the link label(s) in bold and the colon, as the md writes them. */
  label: string;
  note: string;
  /** Every link in the label, for tests. */
  links: ReadonlyArray<{ label: string; href: string }>;
}

export interface AboutFaqItem {
  q: string;
  /** Plain text: what FAQPage JSON-LD carries. */
  a: string;
  /** The answer with inline marks, when it holds a link. */
  markup?: string;
}

export interface AboutContent {
  headings: {
    origin: string;
    today: string;
    isNot: string;
    openSource: string;
    costs: string;
    going: string;
    builder: string;
    contact: string;
    rightHivra: string;
  };
  intro: { lead: string; more: readonly string[] };
  origin: readonly string[];
  today: readonly AboutLead[];
  isNot: readonly AboutLead[];
  openSource: readonly string[];
  costs: readonly string[];
  going: {
    intro: string;
    /** The paragraph that names the four planned tools. */
    planned: string;
    closing: string;
  };
  builder: readonly string[];
  contact: { lead: string; items: readonly AboutContact[] };
  rightHivra: string;
  faq: readonly AboutFaqItem[];
}

export const ABOUT_HEADINGS: AboutContent["headings"] = {
  origin: "From HermesOS to Hivra",
  today: "What you can do today",
  isNot: "What Hivra is not",
  openSource: "Why open source matters here",
  costs: "What Hivra costs",
  going: "Where we're going",
  builder: "Who's building it?",
  contact: "Contact us, or check the work yourself",
  rightHivra: "Make sure you're on the right Hivra",
};

export const FAQ_HEADING = "Common questions";

/**
 * The page copy for one viewer. `tokens` is tokenSurfacesVisible(view): true only
 * when the token surfaces are on and the viewer is not geo-blocked.
 */
export function buildAboutContent({ tokens }: { tokens: boolean }): AboutContent {
  const entry = formatPlanSize("entry");
  const larger = formatPlanSize("larger");

  return {
    headings: ABOUT_HEADINGS,

    intro: {
      lead: "Hivra makes it easier to give an AI agent a computer of its own.",
      more: [
        "Not a window on your laptop. Not a model being asked to stay inside a folder. A separate environment where an agent can run commands, browse, use tools and get work done, without starting out next to your personal files and signed-in accounts.",
        "You can let us host that computer or run the open-source platform yourself.",
      ],
    },

    origin: [
      "Hivra started as **HermesOS**, a straightforward way to deploy Hermes Agent. The more we built, the clearer something became: this shouldn't be tied to one agent or one model.",
      "People were already using Claude Code, Codex and other tools to do serious work. What they needed wasn't another assistant telling them what it could do. They needed a reliable computer to run it on, one they could see, access and control.",
      "So HermesOS became Hivra. The name changed to make room for the wider project. Existing Hivra/HermesOS users, accounts and deployments carried across the rebrand.",
    ],

    today: [
      {
        lead: "Run supported AI agents.",
        text: `Deploy Claude Code, Codex, Hermes, OpenClaw, Agent Zero and Aeon through their supported workflows. Different agents have different requirements, including cloud-only restrictions. Hermes runs on Hivra Cloud only. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT}`,
      },
      {
        lead: "Launch a computer for yourself.",
        text: "Agent Computers aren't only for agents. You can use one yourself, with a desktop or terminal as supported by that environment. Choose Ubuntu, Omarchy (prepared computer) or Windows on your own server with your licensed image.",
      },
      {
        lead: "Come back to the same machine.",
        text: "A paid Hivra Cloud computer stays on and is not paused for inactivity. Connect through a browser, inspect what happened and take over when necessary.",
      },
      {
        lead: "Choose where it runs.",
        text: "Pay for Hivra Cloud, connect infrastructure you already have or run the open-source platform yourself. The options aren't identical, and we'll tell you where a particular agent needs Hivra Cloud.",
      },
      {
        lead: "Bring your own AI access.",
        text: "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.",
      },
    ],

    isNot: [
      {
        lead: "It isn't an AI model.",
        text: "Hivra runs the computers and supports the agents. It doesn't replace the underlying models or their providers.",
      },
      {
        lead: "It isn't affiliated with the makers of the agents.",
        text: "Hermes Agent comes from Nous Research, Claude Code from Anthropic, and Codex from OpenAI. We support those tools without claiming to have created them or to represent their companies.",
      },
      {
        lead: "It isn't a promise that agents can never cause harm.",
        text: "A separate computer reduces what is available by default, but the limits depend on the accounts, permissions and network access you connect. You should still review what your agents can do.",
      },
      {
        lead: "It isn't a token-only service.",
        text: `Hivra's software can be self-hosted without buying or holding a token. Card-paid cloud hosting is available separately.${
          tokens
            ? " Hivra also has a token and future economic plans, but those aren't prerequisites for using the open-source platform."
            : ""
        }`,
      },
    ],

    openSource: [
      "When software stands between an agent and the things it can access, people should be able to inspect that software.",
      `Our code is public at **[${REPOSITORY_LABEL}](${REPOSITORY_URL})**. You can check it, work on it and deploy the platform yourself rather than being dependent on a private hosted service.`,
      "That doesn't mean every deployment is automatically secure, or that public code has been audited. It means you can verify how Hivra works and choose who operates it.",
    ],

    costs: [
      `Hivra Cloud is a paid hosting service. The entry size is **${entry}**. A larger size is **${larger}**. Self-hosting the software costs nothing, but you provide your own server and cover any AI usage.`,
      // The price is in the paragraph above, so the rule here is the short form plus the free-account sentence.
      `${HOSTED_COMPUTE_NEEDS_PLAN_SHORT} ${FREE_ACCOUNT_SENTENCE}`,
      `Paid Hivra Cloud plans come with a **${MONEY_BACK_GUARANTEE}**. Check the [pricing](/pricing) and [terms](/terms) pages for the details before buying.`,
      ...(tokens
        ? [
            "There's a separate Hivra token ecosystem. Its current arrangements and proposed uses are explained on the [token pages](/token), not folded into ordinary hosting prices or presented as a requirement to use the software.",
          ]
        : []),
    ],

    going: {
      intro:
        "Agent Computers are the starting point. The longer-term work is about helping people use increasingly capable agents without handing them everything at once.",
      planned:
        "We're planning tools for tightly scoped account access (**Gate**), discovering and distributing agent software (**Exchange**), testing agents against real failures in controlled environments (**Arena**), and sharing actionable security warnings (**Signal**).",
      closing: tokens
        ? `Other ideas in the wider ecosystem are further away. They are described as plans or research, not products you can buy today. See the [ecosystem map](/ecosystem) and [litepaper](${LITEPAPER_HREF}) for the distinction.`
        : "Other ideas in the wider ecosystem are further away. They are described as plans or research, not products you can buy today. See the [ecosystem map](/ecosystem) for the distinction.",
    },

    builder: [
      "Hivra is an independent project founded by Ash, who builds with AI agents himself. The motivation is both practical and personal: capable agents are useful, but their access shouldn't depend entirely on how well they follow instructions.",
      "You can read more in **[Why I'm building Hivra](/why-hivra)**.",
    ],

    contact: {
      lead: `For questions and support: **[${SECURITY_EMAIL}](mailto:${SECURITY_EMAIL})**.`,
      items: [
        {
          label: `**[GitHub](${REPOSITORY_URL}):**`,
          note: "Read the code and follow development.",
          links: [{ label: "GitHub", href: REPOSITORY_URL }],
        },
        {
          label: "**[Pricing](/pricing):**",
          note: "Current hosting plans and restrictions.",
          links: [{ label: "Pricing", href: "/pricing" }],
        },
        {
          label: "**[Status](/status):**",
          note: "Service status.",
          links: [{ label: "Status", href: "/status" }],
        },
        {
          label: "**[Security](/security):**",
          note: "How to report a vulnerability privately.",
          links: [{ label: "Security", href: "/security" }],
        },
        {
          label: "**[Privacy](/privacy)** and **[Terms](/terms):**",
          note: "How the service is operated and the rules of use.",
          links: [
            { label: "Privacy", href: "/privacy" },
            { label: "Terms", href: "/terms" },
          ],
        },
        {
          label: `**[X](${X_URL}):**`,
          note: "Updates from the project.",
          links: [{ label: "X", href: X_URL }],
        },
      ],
    },

    rightHivra: tokens
      ? "Our official website is **hivra.cloud**. We're not affiliated with unrelated projects using similar names, including sites at hivra.ai or hivra.app. When you're signing in, paying or connecting a wallet, check the domain carefully."
      : "Our official website is **hivra.cloud**. We're not affiliated with unrelated projects using similar names, including sites at hivra.ai or hivra.app. When you're signing in or paying, check the domain carefully.",

    faq: aboutFaq({ tokens }),
  };
}

function aboutFaq({ tokens }: { tokens: boolean }): AboutFaqItem[] {
  const securityMarkup = `Follow the private reporting instructions at [hivra.cloud/security](/security). For general support, email [${SECURITY_EMAIL}](mailto:${SECURITY_EMAIL}).`;

  return [
    {
      q: "Is Hivra the same project as HermesOS?",
      a: "Yes. HermesOS is the former name. Hivra is the expanded platform, and existing accounts and deployments carried across the rebrand.",
    },
    {
      q: "Is Hivra the same as hivra.ai or hivra.app?",
      a: `No. ${DISAMBIGUATION} ${NON_AFFILIATION_LINE}`,
    },
    {
      q: "Can I run Hivra without paying for cloud hosting?",
      a: "Yes. Create a free account and connect your own computer or server, or self-host the open-source platform. Hivra doesn't run a computer for you without a paid plan, and you'll still pay your infrastructure and AI providers.",
    },
    {
      q: "Can I use my existing AI subscription?",
      a: "For supported agents such as Claude Code and Codex, you can use the supported login flow for your existing account, subject to the provider's terms. For other agents, you may need your own API key or Hivra credits. Check each agent's requirements. The plan does not include AI usage.",
    },
    {
      q: "Is Hivra affiliated with Anthropic, OpenAI or Nous Research?",
      a: "No. Hivra isn't affiliated with those companies. It supports agents they make, such as Claude Code, Codex and Hermes, so what those agents can do depends on their makers' software and terms.",
    },
    {
      q: tokens ? "Do I need $HIVRA?" : "Do I need a token?",
      a: "No. It's not required for self-hosting or ordinary card-paid access.",
    },
    {
      q: "How do I report a security issue?",
      a: plainText(securityMarkup),
      markup: securityMarkup,
    },
  ];
}
