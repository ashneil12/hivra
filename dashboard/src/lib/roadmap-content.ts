interface RoadmapCard {
  label?: string;
  title: string;
  body: string;
}

interface RoadmapFeature {
  name: string;
  description: string;
}

interface RoadmapRow {
  number: string;
  title: string;
  body: string;
}

export interface RoadmapMetadataItem {
  label: string;
  value: string;
  href?: string;
}

type RoadmapUtilityIcon =
  | "server"
  | "gateway"
  | "clock"
  | "market"
  | "loop"
  | "network"
  | "exchange"
  | "settlement"
  | "governance";

export interface RoadmapUtilityCard {
  number: string;
  icon: RoadmapUtilityIcon;
  title: string;
  description: string;
}

interface RoadmapPhaseSection {
  heading: string;
  intro?: string;
  paragraphs?: string[];
  bullets?: string[];
  callout?: string;
}

export interface RoadmapPhase {
  id: string;
  tag: string;
  name: string;
  timeline: string;
  descriptor: string;
  sections: RoadmapPhaseSection[];
}

export const roadmapContent = {
  metadata: {
    title: "Hivra Roadmap April 2026",
    description:
      "Hivra's April 2026 roadmap, kept for the record, with what is live today. The current plan is in the Hivra litepaper.",
    canonicalPath: "/roadmap",
  },
  hero: {
    eyebrow: "APRIL 2026 · HIVRA.CLOUD",
    title: "Hivra Product Roadmap 2026",
    subtitle: "The operating system for autonomous agents.",
    note:
      "This is Hivra's April 2026 roadmap, kept for the record. Hivra has since become agent computers, and parts of this plan have changed. What is live today is kept current below. The current plan is in the litepaper and on the ecosystem page. Anything here that is not live is a plan or a proposal, not a commitment. This is not a financial document and makes no investment claims about $HermesOS or any other asset.",
    scrollLabel: "Scroll to explore",
  },
  whatIsHermesOS: {
    eyebrow: "01 · WHAT IS HIVRA",
    title: "What Is Hivra",
    paragraphs: [
      "Hivra gives AI agents computers of their own. Launch Claude Code, Codex, Hermes, Agent Zero, OpenClaw or Aeon on a computer of its own, or launch an Ubuntu computer and use it yourself. Windows and Omarchy are in private preview.",
      "Run it on Hivra Cloud, on your own cloud account or server, or self-host the whole platform with no Hivra account and no token. You bring your own model key.",
    ],
    callout:
      "The privacy and cost transparency of self-hosting, with the reliability and speed of a managed service.",
  },
  audience: {
    eyebrow: "02 · WHO IS HIVRA FOR",
    title: "Who Is Hivra For",
    paragraphs: [
      "Hivra is built for anyone who wants to deploy and run autonomous AI agents without managing infrastructure. That includes developers, operators, researchers, businesses, and teams across every background.",
      "The platform is designed to be accessible from two directions:",
    ],
    cards: [
      {
        title: "Standard access",
        body: "Get started with a standard subscription using a credit card. No wallet required, no crypto knowledge needed. Credits remain available for usage and top-ups, but compute tier access comes from your plan.",
      },
      {
        title: "Token-based access",
        body: "Hold $HermesOS in a connected wallet to qualify for a compute tier instead of paying by card. The billing page shows the current requirements.",
      },
    ] satisfies RoadmapCard[],
    summary:
      "Both paths give access to the same platform.",
    detail:
      "Card users never need a wallet or a token. Self-hosting needs neither a token nor a Hivra account.",
  },
  liveToday: {
    eyebrow: "03 · WHAT IS LIVE TODAY",
    title: "What Is Live Today",
    intro: "What you can use on Hivra now. This section is kept current.",
    features: [
      {
        name: "Agents on their own computers",
        description:
          "Launch Claude Code, Codex, Hermes, Agent Zero, OpenClaw or Aeon. Agents with their own interface keep it, and you can work in the terminal too.",
      },
      {
        name: "Computers without an agent",
        description:
          "Launch an Ubuntu computer and use it yourself. Windows and Omarchy are in private preview.",
      },
      {
        name: "Your choice of where it runs",
        description:
          "Hivra Cloud, your own cloud account or server, or the whole platform self-hosted.",
      },
      {
        name: "Prompt library",
        description:
          "Deploy agents with pre-configured system prompts. Start with a working operator immediately.",
      },
      {
        name: "Skill viewer",
        description: "View the skills your agent has available at a glance.",
      },
      {
        name: "Hermes scheduled tasks and memory",
        description:
          "Hermes agents keep their scheduled tasks and their memory across sessions.",
      },
      {
        name: "API keys",
        description:
          "Store provider keys once, encrypted at rest, and choose which agents use them.",
      },
      {
        name: "Logs and monitoring",
        description:
          "Real-time streaming logs, health status, and resource usage visible in the dashboard.",
      },
      {
        name: "Token access",
        description:
          "Holding $HermesOS can qualify you for a compute tier. The billing page shows the current requirements.",
      },
    ] satisfies RoadmapFeature[],
  },
  vision: {
    eyebrow: "04 · PRODUCT VISION",
    title: "Product Vision",
    callout:
      "Hivra is evolving from a deployment tool into the operating system for autonomous agent businesses.",
    paragraphs: [
      "The next wave of AI is not about chat interfaces. It is about persistent operators: agents that run continuously, take real-world actions, learn from experience, improve over time, and fund their own compute. Most people cannot build this infrastructure themselves. Hivra closes that gap.",
    ],
    directionLead: "The platform is moving in three directions simultaneously:",
  },
  visionSticky: {
    states: [
      {
        text: "A single Hivra agent is useful.",
      },
      {
        text: "A network of thousands of Hivra agents, all learning from each other...",
      },
      {
        textLead: "...accessible through a ",
        textHighlight: "shared token layer",
        textTail: ", is something categorically different.",
      },
    ],
  },
  visionDirection: {
    rows: [
      {
        number: "01",
        title: "From deployment to operators",
        body: "Today, deploying on Hivra gives you a powerful but blank canvas. You get the full agent framework, but what you do with it is up to you. The next step is changing that: pre-configured, job-ready operators that arrive knowing their role, with every tool they need already installed. A working agent, not just a starting point, from the moment it deploys.",
      },
      {
        number: "02",
        title: "From isolated agents to a connected network",
        body: "Every agent on the platform contributes to and draws from a shared intelligence layer called Hive Mind. Agents get better over time not just from what they individually learn, but from what the whole network learns. This is what makes the platform different as it scales.",
      },
      {
        number: "03",
        title: "From platform to economy",
        body: "Proposed: agents that earn from their work, pay for their own compute, and transact with each other through the token. The current proposal is in the tokenomics.",
      },
    ] satisfies RoadmapRow[],
  },
  token: {
    eyebrow: "05 · $HERMESOS TOKEN",
    title: "Fair launch. Community owned.",
    originParagraphs: [
      "$HermesOS launched as a community fair launch on Bankr on Base. There was no team pre-mint, no private allocation, and no VC distribution. The total supply is 100,000,000,000 tokens, fixed, fully in circulation from launch, held entirely by the community.",
      "The token came to exist because the project got real attention. When Erik Voorhees, founder of Venice AI, publicly engaged with Hivra and the community responded, someone launched the token through Bankr before an official one existed. Hivra embraced it. The community had already shown what they thought of the project. The work now is to build the utility that makes the token genuinely useful inside a real platform.",
    ],
    metadata: [
      { label: "Total supply", value: "100,000,000,000 (100 billion), fixed" },
      { label: "Launch type", value: "Community fair launch via Bankr on Base" },
      { label: "Team allocation", value: "None" },
      { label: "VC / private allocation", value: "None" },
      {
        label: "Contract",
        value: "Verify at hivra.cloud/token only",
        href: "/token",
      },
    ] satisfies RoadmapMetadataItem[],
    utilityHeading: "TOKEN UTILITY",
    utilityIntro:
      "Compute access (01) is live today. The other uses below were proposals in April 2026. Some have changed since, and none is a commitment. The current proposal is in the tokenomics.",
    utilities: [
      {
        number: "01",
        icon: "server",
        title: "Compute Access",
        description:
          "Live today. Hold $HermesOS in a connected wallet to qualify for a compute tier. The billing page shows the current requirements.",
      },
      {
        number: "02",
        icon: "gateway",
        title: "LLM Gateway Credits",
        description:
          "Proposed: LLM access through Bankr's gateway: Claude, GPT, Gemini, and more, at cost with no markup. Credits purchased through Bankr, payable in any cryptocurrency including $HermesOS.",
      },
      {
        number: "03",
        icon: "clock",
        title: "Pay-As-You-Go Compute",
        description:
          "Proposed: Rolling hourly billing. Pay only for the hours your server is online. Delete the server and billing stops immediately. Agents can spin up their own servers autonomously via x402 payment rails.",
      },
      {
        number: "04",
        icon: "market",
        title: "Marketplace Access & Creator Earnings",
        description:
          "Proposed: Token holdings determine which marketplace content is available without individual purchase. Creators earn from usage and can withdraw through supported payout options, including token-based settlement.",
      },
      {
        number: "05",
        icon: "loop",
        title: "Agent Self-Sustainability",
        description:
          "Proposed: Agents hold their own token balance and pay for services autonomously. Agents operate independently without needing constant human top-ups.",
      },
      {
        number: "06",
        icon: "network",
        title: "Hive Mind Network Access",
        description:
          "Proposed: Platform users access the collective Hive Mind intelligence layer at no additional cost. External agents from other networks can query it by paying in $HermesOS per request.",
      },
      {
        number: "07",
        icon: "exchange",
        title: "Agent-to-Agent Payments",
        description:
          "Proposed: Agents pay each other for services settled in $HermesOS. A research operator sells intelligence to a trading research operator. All settled in token, no human in the loop.",
      },
      {
        number: "08",
        icon: "settlement",
        title: "Marketplace Settlement",
        description:
          "Proposed: Marketplace transactions are settled using $HermesOS as the underlying layer. Users and creators do not need to interact with this layer directly.",
      },
      {
        number: "09",
        icon: "governance",
        title: "Governance",
        description:
          "Not decided. No governance model has been chosen, and holding the token does not give anyone a vote on ecosystem direction.",
      },
    ] satisfies RoadmapUtilityCard[],
    utilityNote: "Official token information is published only at hivra.cloud/token.",
  },
  roadmap: {
    eyebrow: "06 · ROADMAP",
    title: "Roadmap",
    intro:
      "The four phases as planned in April 2026. The timelines are from then and have moved, and some items have changed. The current plan is in the litepaper.",
    phases: [
      {
        id: "phase-1",
        tag: "Phase 1",
        name: "Operator Foundations + Economic Infrastructure",
        timeline: "Planned for 6 weeks from April 2026",
        descriptor:
          "Ship flagship operators, Bankr integration, token-gated compute, and subscription-backed compute rails.",
        sections: [
          {
            heading: "What Are Operator Packs",
            paragraphs: [
              "Operator packs are pre-configured, job-ready agent deployments. They are not skills or plugins. When you deploy an operator pack, everything it needs is installed and configured automatically: tools, capabilities, integrations, memory setup, and system prompts. There are no dependencies to manage, no configuration files to write, and no setup steps to follow.",
              "A skill teaches an agent how to do one thing. An operator pack deploys an agent that already knows its job, has everything it needs to do that job, and is ready to run from the moment it goes live. You connect any API keys the operator requires and it works.",
              "Looking further ahead, the platform is exploring token-based access to operator endpoints via x402 micropayments. Instead of managing API keys yourself, the operator pays for what it needs autonomously using $HermesOS. This is exploratory and will be detailed when it is ready to ship.",
            ],
          },
          {
            heading: "Flagship Operator Packs",
            intro:
              "Phase 1 ships three operator packs, each designed for a specific job and ready to run from the moment it deploys.",
            bullets: [
              "Research Operator: continuous web research, source monitoring, automated summaries, and recurring intelligence briefs. Deploy a research agent that works around the clock in the background.",
              "Trading Research Operator: market monitoring, watchlists, signal tracking, thesis documentation, and real-time alerts. A serious intelligence and awareness layer for crypto and financial markets.",
              "Growth Operator: lead research, contact enrichment, outreach preparation, content repurposing, and workflow automation for business development and marketing operations.",
            ],
          },
          {
            heading: "Platform Foundations",
            bullets: [
              "Skill management: add, remove, and curate the skills available to your agent. Full control over what your operator can do.",
              "File explorer: browse and manage files your agent has created, downloaded, or is working with directly from the dashboard.",
            ],
          },
          {
            heading: "Bankr Integration",
            bullets: [
              "Proposed: Deep integration with Bankr as the financial infrastructure layer. Bankr handles wallet provisioning, LLM gateway, and on-chain payment rails. Hivra handles agent infrastructure.",
              "Proposed: Crypto-native users get a provisioned Bankr wallet at account creation, enabling on-chain activity, token-based access, and LLM gateway usage from day one.",
              "Proposed: Credit-based users do not receive a Bankr wallet. They interact with a simple credits balance only. The platform handles all underlying settlement on their behalf.",
              "Proposed: LLM gateway credits purchasable through Bankr for token users, or via standard card top-up for credit users. Usable across Claude, GPT, and Gemini at cost with no markup.",
            ],
          },
          {
            heading: "Compute Access",
            intro:
              "Compute access comes from an active subscription or verified token holding. Credits are kept separate so top-ups do not accidentally change a user's compute tier.",
            bullets: [
              "Token path: hold $HermesOS in your connected wallet to qualify for a compute tier. The billing page shows the current requirements.",
              "Subscription path: card users choose a plan, and that plan defines the compute tier. Credit balances do not unlock or upgrade compute by themselves.",
              "If your subscription or token holding falls out of eligibility, there is a grace period before compute pauses. Restoring eligibility during that window keeps the agent recoverable.",
            ],
          },
          {
            heading: "Usage Credits",
            bullets: [
              "Credits are reserved for usage, future top-ups, LLM gateway spend, and premium platform actions.",
              "Keeping credits separate from compute tiers prevents a topped-up balance from being mistaken for Free or paid compute access.",
            ],
          },
          {
            heading: "Card and Token Access",
            paragraphs: [
              "The April 2026 plan was to move from card plans to token-based access. That changed: card plans and token access both continue.",
            ],
          },
        ],
      },
      {
        id: "phase-2",
        tag: "Phase 2",
        name: "Platform Controls + Deeper Token Integration",
        timeline: "Planned for 1 to 3 months from April 2026",
        descriptor:
          "Add team features, agent wallets, expanded token utility, and an expanded operator pack library.",
        sections: [
          {
            heading: "Platform Controls",
            bullets: [
              "Pack builder: create, save, and version your own operator configurations. Turn a working setup into a reusable template.",
              "Approval controls: agent approval functionality exists today and is being significantly deepened: richer controls, tighter security boundaries, and more granular per-action configuration before agents send messages, execute purchases, or take actions with real-world consequences.",
              "Memory viewer: see what your agent has learned, edit stored context, and control what persists across sessions.",
              "Organisation workspaces: team accounts with shared agents, shared memory, and shared workflows.",
              "Role-based permissions: control who can modify, deploy, or approve actions across a workspace.",
              "Benchmarking and evals: measure how well your operators perform against defined tasks. Track improvement over time.",
            ],
          },
          {
            heading: "Agent Wallets",
            bullets: [
              "Proposed: agents hold their own token balance with defined spending limits and hard guardrails on autonomous transactions.",
              "Proposed: agents pay for their own model calls, compute and services within approved boundaries.",
              "Proposed: Spending approval controls: agents request user confirmation for actions above defined thresholds.",
            ],
          },
          {
            heading: "Expanded Operator Packs",
            paragraphs: [
              "Phase 2 expands the operator pack library beyond the three flagship operators shipped in Phase 1. Additional packs are added based on community demand and platform priorities, covering new use cases and workflows.",
            ],
          },
          {
            heading: "Expanded Token Utility",
            bullets: [
              "Proposed: usage credits, with the token spendable on model access and premium features.",
              "Proposed: groundwork for agent-to-agent payments.",
            ],
          },
        ],
      },
      {
        id: "phase-3",
        tag: "Phase 3",
        name: "Marketplace + Hive Mind",
        timeline: "Planned for 3 to 6 months from April 2026",
        descriptor:
          "Open the ecosystem. Community builds, publishes, and earns. Collective agent intelligence introduced.",
        sections: [
          {
            heading: "Operator Marketplace",
            bullets: [
              "Browse, install, and deploy community-built operator packs in one click.",
              "Verified publisher programme for trusted creators with accountability and track records.",
              "Flexible publishing options: release packs with open access, attach a price for individual purchase, or offer revenue share. Creators choose their own model.",
              "Community templates: free packs contributed by the community, instantly deployable.",
              "Private company packs: organisations maintain their own internal operator libraries, never publicly visible.",
              "Proposed: token-based marketplace access, where token holdings determine which community packs and skills are available without individual purchase.",
              "Proposed: Users can build and publish their own operators and agents. Creators earn from usage and can withdraw through supported payout options, including token-based settlement. Additional payout methods will be introduced over time.",
            ],
          },
          {
            heading: "Agent Endpoints",
            intro:
              "One of the most powerful features of the marketplace: dedicated agent endpoints. Instead of sharing your prompts or tooling, you expose your agent as a callable service. Other users and agents can send tasks to your endpoint and receive results, without ever seeing how your agent works under the hood.",
            bullets: [
              "Publish your agent as a private endpoint with a public interface. Keep your prompts, tools, and configuration completely private.",
              "Proposed: Other agents and users call your endpoint to run tasks. You set the terms: open access, token-gated, or per-call pricing.",
              "High-demand endpoints scale through managed plan capacity. Hivra manages the scaling infrastructure.",
              "Agent endpoint operators generate revenue from every call while their underlying agent logic stays entirely protected.",
            ],
          },
          {
            heading: "Hive Mind Mode: Early Access",
            callout: "The most significant long-term capability on this roadmap.",
            paragraphs: [
              "Hive Mind Mode is a collective intelligence layer across the Hivra network. Every agent on the platform contributes to and benefits from a shared knowledge base: learned skills, successful workflows, and refined strategies accumulate at the network level, making every agent smarter over time without any individual user needing to do anything extra.",
              "The April 2026 plan was to introduce Hive Mind in early access in Phase 3, with a full release in Phase 4. It has not shipped, and there is no early-access commitment.",
            ],
            bullets: [
              "Proposed: external agents from other networks could query the Hive Mind and pay per request in the token.",
              "Agents share learned capability, not private data. Security and isolation are foundational to the design.",
            ],
          },
        ],
      },
      {
        id: "phase-4",
        tag: "Phase 4",
        name: "Agent Economy + Infrastructure Layer",
        timeline: "Planned for 6 to 12 months from April 2026",
        descriptor:
          "Full autonomous agent economy. Hivra as foundation for other platforms.",
        sections: [
          {
            heading: "Full Agent Economy",
            bullets: [
              "Proposed: agent-to-agent payments at scale, where agents pay each other for services in the token.",
              "Hive Mind full release: the collective intelligence layer opens to the full network after early access.",
              "Proposed: Hive Mind external access, where agents from other networks pay per query in the token.",
              "Proposed: on-chain marketplace settlement for pack purchases, creator payouts and platform fees.",
              "Governance is not decided. Any model will be published before it takes effect, and none is promised to token holders.",
            ],
          },
          {
            heading: "Hivra as Infrastructure Layer",
            intro:
              "Phase 4 opens Hivra to developers and companies who want to build their own agent-powered products on top of the platform.",
            bullets: [
              "API access for third-party products: companies build their own consumer-facing agent services using Hivra as the underlying infrastructure.",
              "Operators as a service: teams wanting their own branded agent platform build on Hivra without managing the infrastructure themselves.",
            ],
          },
        ],
      },
    ] satisfies RoadmapPhase[],
  },
  outOfScope: {
    eyebrow: "07 · OUT OF SCOPE",
    title: "What Is Not on This Roadmap",
    intro: "Being explicit about boundaries is as important as the roadmap itself.",
    items: [
      {
        title: "Autonomous trading with user funds",
        description:
          "Hivra does not create, operate, or endorse bots that autonomously manage or execute trades on behalf of users.",
      },
      {
        title: "Yield products or lending returns",
        description:
          "Hivra is an agent infrastructure platform, not a financial services product.",
      },
      {
        title: "MEV strategies, liquidation bots, or front-running tools",
        description: "not operator categories Hivra ships as first-party products.",
      },
      {
        title: "Financial advice",
        description:
          "nothing produced by this platform constitutes investment, trading, or financial advice.",
      },
    ],
    note:
      "Users who build their own agents on Hivra infrastructure are building their own products. Hivra provides the platform, not the endorsement.",
  },
  closing: {
    eyebrow: "08 · WHERE THIS IS HEADING",
    title: "Where This Is Heading",
    quote:
      "Deploy an agent that gets smarter over time, pays for its own compute, connects to a network of other agents, and operates autonomously at any scale.",
    paragraphs: [
      "Hivra is building infrastructure for deployable agent businesses. The roadmap moves from deployment to operators, from operators to ecosystem, and from ecosystem to a network where agents and users interact through shared infrastructure and token-based access.",
      "That was the plan in April 2026. What has shipped since is on the homepage and the ecosystem page, and the current plan is in the litepaper.",
    ],
    metadata: [
      { label: "Platform", value: "hivra.cloud", href: "/" },
      { label: "Token verification", value: "hivra.cloud/token", href: "/token" },
      { label: "Blog", value: "hivra.cloud/blog", href: "/blog" },
      { label: "Twitter / X", value: "x.com/Wayland_Six", href: "https://x.com/Wayland_Six" },
      { label: "Token launched via", value: "bankr.bot", href: "https://bankr.bot" },
    ] satisfies RoadmapMetadataItem[],
    disclaimer:
      "This document describes planned product direction. Timelines are targets, not guarantees. Features are subject to change. Nothing here constitutes financial advice, a financial promotion, or an invitation to purchase any asset. For official token information, use hivra.cloud/token only.",
  },
} as const;
