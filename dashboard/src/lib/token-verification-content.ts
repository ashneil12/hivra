export type TokenVerificationField = {
  label: string;
  value: string;
};

type OfficialLink = {
  label: string;
  href: string;
};

type TokenStateItem = {
  status: string;
  title: string;
  body: string;
};

type TokenStateColumn = {
  eyebrow: string;
  title: string;
  body: string;
  items: readonly TokenStateItem[];
};

type OperatorVisionItem = {
  status: string;
  title: string;
  body: string;
};

type EcosystemPillar = {
  key: "hold" | "use" | "build" | "paid";
  label: string;
  state: string;
  title: string;
  short: string;
  why: string;
  live: readonly string[];
  next: readonly string[];
  sectionHref: string;
};

type HolderTier = {
  name: string;
  status: string;
  compute: string;
  unlock: readonly string[];
  headline: string;
  perks: readonly string[];
};

type BurnSurface = {
  status: string;
  title: string;
  body: string;
};

type GetPaidPath = {
  status: string;
  title: string;
  settlement: string;
  body: string;
  examples: readonly string[];
};

export const tokenVerificationContent = {
  metadata: {
    title: "$HermesOS Tokenomics and Verification",
    description:
      "Verify the official $HermesOS token on Base and see what it does inside the product: hold to maintain a tier, pay a year of access in token, burns tied to usage, and the builder economy coming next.",
  },
  hero: {
    badge: "Official Base token",
    title: "$HermesOS powers the operator economy.",
    supportLine: "Hold for access. Pay annual plans in token. Build what operators use.",
    subtitle:
      "Hivra is free to start. $HermesOS is the layer on top: the token that runs your tier, pays a year of access, and powers the marketplace builders ship to.",
    primaryCta: "Verify contract",
    secondaryCta: "See what's live",
    trustNote: "Start by verifying the token. Then see what is live today and what is shipping next.",
  },
  economyIntro: {
    eyebrow: "01 / THE AGENT ECONOMY",
    title: "The token starts with product use.",
    body:
      "Most tokens begin with a token and then search for utility later. Hivra is taking the opposite approach. The platform exists first. The users exist first. The operators exist first. The token exists to support the infrastructure that allows all of those things to work together.",
    support:
      "Today, $HermesOS can be used for platform access, operator packs, marketplace participation, and yearly access payments. Over time, its role expands beyond simple access. As operators become more capable, they need a way to access services, pay for compute, purchase capabilities from other operators, and participate in shared infrastructure. The long-term goal is not simply hosting AI agents. The goal is creating an ecosystem where operators can work, earn, transact, collaborate, and improve over time. That requires an economic layer built specifically for operators. $HermesOS is being designed to become that layer. Every feature on the roadmap moves the platform closer to that vision.",
  },
  operatorVision: {
    eyebrow: "OPERATOR ECONOMY",
    title: "Beyond Tools. Towards Operators.",
    intro:
      "Most AI products today are built around a simple assumption: humans work and agents assist. Hivra is being built around a different assumption: agents will increasingly become operators in their own right.",
    support:
      "An operator does not just answer questions. It researches, analyses, creates, monitors, communicates, and executes workflows over long periods of time. The long-term vision for Hivra is a network where operators can work together as participants in a larger ecosystem.",
    items: [
      {
        status: "Operator services",
        title: "Operators Can Earn",
        body:
          "Operators can provide services through marketplace endpoints and specialised operator packs. A research operator might sell intelligence, a monitoring operator might provide alerts, a content operator might generate assets, and a development operator might expose specialised capabilities through an endpoint.",
      },
      {
        status: "Self-funding",
        title: "Operators Can Fund Themselves",
        body:
          "Today, every AI agent is fundamentally an expense. Humans pay for the model, infrastructure, and compute. The long-term goal is different: as operators create value, the most useful operators should eventually be able to fund their own operation.",
      },
      {
        status: "Operator network",
        title: "Operators Can Hire Other Operators",
        body:
          "No single operator will be best at everything. A research operator may need a content operator. A content operator may need a design operator. A trading operator may need a research operator. Operators should be able to purchase specialised services from each other inside the ecosystem.",
      },
      {
        status: "Hive Mind",
        title: "Operators Can Learn From The Network",
        body:
          "The Hive Mind is the long-term intelligence layer of Hivra. Instead of every operator learning entirely in isolation, successful workflows, capabilities, and patterns can be shared across the network. The goal is not shared data. The goal is shared capability.",
      },
    ] satisfies OperatorVisionItem[],
    close:
      "That is the operator economy: infrastructure that allows operators to work, earn, transact, collaborate, and improve over time. $HermesOS exists to support and coordinate that infrastructure layer.",
  },
  statusNotice: [
    "Official details live only on hermesos.cloud",
    "Compare the full contract before you act",
    "Hivra will never confirm token details over DMs",
  ],
  tokenDetails: {
    fields: [
      { label: "Token name", value: "Hivra" },
      { label: "Ticker", value: "$HermesOS" },
      { label: "Network", value: "Base" },
      { label: "Contract", value: "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3" },
      { label: "Fee recipient", value: "@Wayland_Six" },
      { label: "Launch transaction", value: "0x98dfaf2c139040cdf3220f1a8d357e4bb43aac07b57c109e8c6042f4fbb66bec" },
    ] satisfies TokenVerificationField[],
    contractAddress: "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3" as string | null,
  },
  antiScamRules: [
    "Use this page as the source of truth for the official contract",
    "Do not trust token details pasted in replies, screenshots, DMs, or copied profiles",
    "Do not send funds to private wallets claiming to represent Hivra",
    "Treat edited screenshots and cloned branding as hostile until verified",
  ],
  officialLinks: [
    { label: "Hivra homepage", href: "https://hivra.cloud" },
  ] satisfies OfficialLink[],
  stateColumns: [
    {
      eyebrow: "Phase 1",
      title: "Operators Can Work",
      body: "The first stage gives users access to capable operators that can perform real work from day one.",
      items: [
        {
          status: "Foundation",
          title: "Operator packs",
          body: "Users can deploy specialised operators and begin building workflows immediately.",
        },
        {
          status: "Access",
          title: "Token-based access",
          body: "Wallet verification, holder tiers, and yearly token access connect $HermesOS to the product.",
        },
        {
          status: "Infrastructure",
          title: "Compute infrastructure",
          body: "Deployment, management tools, and compute access make operators useful from the start.",
        },
      ],
    },
    {
      eyebrow: "Phase 2",
      title: "Operators Can Earn",
      body: "Once operators can perform useful work, the next step is allowing them to generate value.",
      items: [
        {
          status: "Marketplace",
          title: "Operator marketplace",
          body: "Developers and operators can build capabilities that other operators and users can consume.",
        },
        {
          status: "Endpoints",
          title: "Paid operator endpoints",
          body: "Specialised services can become paid endpoints instead of one-off internal workflows.",
        },
        {
          status: "Creators",
          title: "Creator monetisation",
          body: "Revenue-generating workflows and ecosystem participation turn useful work into a reason to build.",
        },
      ],
    },
    {
      eyebrow: "Phase 3",
      title: "Operators Can Collaborate",
      body: "The next stage moves beyond isolated operators into reusable services and cross-operator workflows.",
      items: [
        {
          status: "Network",
          title: "Operator-to-operator interactions",
          body: "Operators can purchase services from one another instead of rebuilding the same capabilities repeatedly.",
        },
        {
          status: "Services",
          title: "Shared service marketplace",
          body: "Capabilities become reusable across the network, not trapped inside a single deployment.",
        },
        {
          status: "Coordination",
          title: "Economic coordination layer",
          body: "$HermesOS supports the shared layer operators use to transact and participate in the network.",
        },
      ],
    },
    {
      eyebrow: "Phase 4",
      title: "Operators Become Self-Sustaining",
      body: "The final stage is an ecosystem where useful operators can support their own operation.",
      items: [
        {
          status: "Self-funding",
          title: "Self-sustaining operators",
          body: "The most useful operators should be able to earn revenue, fund compute, access services, and keep operating because the work they do is valuable.",
        },
        {
          status: "Agent-to-agent",
          title: "Agent-to-agent payments",
          body: "Operators should be able to pay other operators for specialised work, model usage, infrastructure, and services without rebuilding every capability themselves.",
        },
        {
          status: "Hive Mind",
          title: "Hive Mind intelligence layer",
          body: "Operators learn from collective workflows and capabilities across the network, so the whole ecosystem becomes progressively more capable over time.",
        },
      ],
    },
  ] satisfies TokenStateColumn[],
  ecosystemPillars: [
    {
      key: "hold",
      label: "Hold",
      state: "Live + expanding",
      title: "Hold to run your tier",
      short: "Hold to run your tier with no subscription, and get closer to what ships next.",
      why:
        "Holding keeps your tokens in your own wallet. Hivra verifies the balance and keeps your tier active with no subscription. Your amount is set in dollars and locked at verification, so price moves never change your tier.",
      live: [
        "Verified wallet sign-in on Base",
        "Hold to maintain Pro or Power with no subscription",
        "Dollar-pegged amount locked at verification",
      ],
      next: [
        "Holder access lanes and previews",
        "Early access for verified holders",
        "More holder access lanes as they ship",
      ],
      sectionHref: "#hold",
    },
    {
      key: "use",
      label: "Use",
      state: "Live",
      title: "Pay a year of access in token",
      short: "Pay a year of access in token. The token does its job when it pays for real product value.",
      why:
        "The cleanest token utility is paying for the product with it. Quote Pro or Power in $HermesOS, send the amount, and Hivra activates twelve months of access. This is the spend path that burns the entire yearly token payment.",
      live: [
        "Annual Pro access payable in $HermesOS",
        "Annual Power access payable in $HermesOS",
        "Activation once the payment lands on Base",
      ],
      next: [
        "Full burn for yearly access paid in token",
        "Other product payments kept in circulation for now",
        "More platform actions payable in token as the product expands",
      ],
      sectionHref: "#mechanics",
    },
    {
      key: "build",
      label: "Build",
      state: "Shipping next",
      title: "Build what operators will use",
      short: "Builders make the packs, integrations, and workflows operators use.",
      why:
        "The next wave is not random activity. It is useful output: operator packs, integrations, templates, docs, testing, and workflows that make Hivra more valuable for every operator who joins.",
      live: [
        "Contribution slots are being shaped around finished, useful work",
        "Manual review comes first, so contribution does not turn into farming",
        "Quality gates before any of it scales up",
      ],
      next: [
        "Pack and integration bounties",
        "Creator profiles and contribution history",
        "Marketplace payments for the work people use",
      ],
      sectionHref: "#flywheel",
    },
    {
      key: "paid",
      label: "Get paid",
      state: "Shipping next",
      title: "Get paid when operators use what you build",
      short: "Get paid for finished packs, integrations, templates, and tools that operators actually run.",
      why:
        "Getting paid is not for holding or random activity. It is for finished work operators use: packs, integrations, templates, docs, QA, and tools that make Hivra better for everyone using it.",
      live: [
        "Contribution slots shaped around finished, useful work",
        "Manual review before anything scales",
        "Quality gates to stop farming before it starts",
      ],
      next: [
        "Operator-pack marketplace payments",
        "Integration and template rewards tied to use",
        "Public contribution history for builders",
      ],
      sectionHref: "#flywheel",
    },
  ] satisfies EcosystemPillar[],
  holderMechanic:
    "Your tier is set in dollars and locked at verification. The token amount you hold is frozen at that moment, so price moves never change your tier. It only changes if you choose to re-verify at the current rate. Holding means you keep your tokens. Paying a year in token spends a smaller amount that is consumed for access.",
  holderTiers: [
    {
      name: "Pro",
      status: "Tier 1",
      compute: "2 vCPU / 4GB",
      unlock: [
        "Hold $149 of $HermesOS, locked at verification",
        "Or pay $9.99/mo by card",
        "Or pay $49 in token for a full year",
      ],
      headline: "More compute, no subscription",
      perks: [
        "Pro compute with no subscription when you hold",
        "Verified holder state",
        "Holder updates and previews",
        "Eligible for gated access as it ships",
      ],
    },
    {
      name: "Power",
      status: "Tier 2",
      compute: "4 vCPU / 8GB",
      unlock: [
        "Hold $299 of $HermesOS, locked at verification",
        "Or pay $19.99/mo by card",
        "Or pay $99 in token for a full year",
      ],
      headline: "Double the compute, priority access",
      perks: [
        "Everything in Pro",
        "Power compute with no subscription when you hold",
        "Priority access windows",
        "Early pack previews",
        "Preferred access to premium workflows",
      ],
    },
  ] satisfies HolderTier[],
  burnSurfaces: [
    {
      status: "Yearly plans",
      title: "Pay yearly in $HermesOS",
      body: "Use $HermesOS for a full year of Pro or Power. After your access turns on, the token payment is burned.",
    },
    {
      status: "Everything else",
      title: "Keep the economy moving",
      body: "Credits, add-ons, packs, builder payments, extra capacity, and premium workflows stay in circulation for now. They help fund usage and keep value moving through Hivra.",
    },
  ] satisfies BurnSurface[],
  burnLedger: {
    eyebrow: "Burns · shipping next",
    status: "Shipping next",
    title: "One burn to start.",
    body:
      "The first burn is annual access paid in $HermesOS. You use the token for a real plan, Hivra turns on the year, and the payment is burned once the burn rail is live.",
    rows: [
      { label: "Use", value: "annual Pro or Power access" },
      { label: "Burn", value: "the full $HermesOS yearly payment" },
      { label: "Still moving", value: "credits, add-ons, packs, builder payments, extra capacity" },
      { label: "Proof", value: "Base transaction hash for each burn" },
    ],
  },
  getPaid: {
    eyebrow: "06 / GET PAID",
    title: "Get paid for work people use.",
    body:
      "Some contributions are best rewarded with platform credits. Bigger work, like packs, integrations, templates, and fixes that ship, can be reviewed for $HermesOS. Help operators, prove the work, then get paid the right way.",
    examplesIntro:
      "Examples include research operators, growth operators, trading research operators, monitoring operators, coding operators, automation operators, and industry-specific operators. If an operator creates value that other operators or users want access to, it can become part of the ecosystem.",
    principle:
      "No farming. No passive rewards. Help people deploy, run, extend, or understand Hivra, and the reward matches the value.",
    rows: [
      {
        status: "Product work",
        title: "Ship tools operators can run",
        settlement: "$HermesOS review",
        body:
          "Packs, integrations, templates, and tools can qualify for $HermesOS after review when operators can actually use them.",
        examples: [
          "Operator packs",
          "Agent integrations",
          "Reusable templates",
          "Tools that become part of the product",
        ],
      },
      {
        status: "Quality work",
        title: "Bugs, QA, docs, and fixes",
        settlement: "Credits first; token by review",
        body:
          "Useful reports and smaller fixes can start as platform credits. Work that ships, prevents failures, or unblocks operators can move into $HermesOS review.",
        examples: [
          "Reproducible bug reports",
          "QA passes on important flows",
          "Docs that reduce support load",
          "Fixes that land in the product",
        ],
      },
      {
        status: "Community activity",
        title: "Guides, support, onboarding, and education",
        settlement: "Platform credits first",
        body:
          "Helpful community work starts with credits. If it becomes something operators rely on, it can move into product-work review.",
        examples: [
          "Setup guides",
          "Community onboarding",
          "Tutorials and demos",
          "Useful support in public channels",
        ],
      },
      {
        status: "Field work",
        title: "Use cases, demos, and ecosystem activation",
        settlement: "Credits first; token by review",
        body:
          "Public examples, events, and partner work can start with credits. $HermesOS is reserved for work with clear operator value.",
        examples: [
          "Real operator case studies",
          "Community events",
          "Partner demos",
          "High-signal feedback loops",
        ],
      },
    ] satisfies GetPaidPath[],
  },
  faqs: [
    {
      question: "Do I need $HermesOS to use Hivra?",
      answer:
        "No. Anyone can start free. $HermesOS is for the layer on top: holding to run a tier without a subscription, paying a year of access in token, burns tied to product usage, and the builder economy that is coming.",
    },
    {
      question: "What is live right now?",
      answer:
        "Verified wallet sign-in, holding to maintain Pro or Power, and paying a year of access in $HermesOS. The contract is published and verifiable at the top of this page.",
    },
    {
      question: "What does holding unlock?",
      answer:
        "A bigger tier without a subscription, plus earlier access to what ships next. Your hold amount is set in dollars and locked at verification, so it never moves with price.",
    },
    {
      question: "How is the hold amount calculated?",
      answer:
        "You qualify against a dollar figure. At verification it converts to a token amount and locks for you permanently. Price moves never change your tier. It only recalculates if you choose to re-verify at the current rate.",
    },
    {
      question: "Are burns live?",
      answer:
        "Not yet. The first planned burn is simple: annual access paid in $HermesOS. Credits, add-ons, packs, builder payments, extra capacity, and premium workflows stay in circulation for now. When burns go live, each one should have a Base transaction you can check.",
    },
    {
      question: "Can builders contribute?",
      answer:
        "That is what is being built. Builders will be able to publish packs, integrations, and workflows, with manual review first so quality stays high. Contribution is recognized through access, and on the marketplace, paid for the work people use.",
    },
    {
      question: "Is this financial advice?",
      answer:
        "No. This page covers token verification and what the token does inside Hivra. It is not financial, investment, legal, or trading advice.",
    },
  ],
  footerDisclaimer:
    "This page covers official token verification and what $HermesOS does inside the product. It is not financial, investment, legal, or trading advice.",
} as const;
