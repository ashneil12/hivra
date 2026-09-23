export const DEFAULT_LOCALE = "en";
const CHINESE_LOCALE = "zh-CN";
const SPANISH_LOCALE = "es";
const PORTUGUESE_LOCALE = "pt-BR";
const FRENCH_LOCALE = "fr";
const GERMAN_LOCALE = "de";
const JAPANESE_LOCALE = "ja";
const KOREAN_LOCALE = "ko";
export const LOCALE_COOKIE_NAME = "hermes_locale";

export const SUPPORTED_LOCALES = [
  DEFAULT_LOCALE,
  CHINESE_LOCALE,
  SPANISH_LOCALE,
  PORTUGUESE_LOCALE,
  FRENCH_LOCALE,
  GERMAN_LOCALE,
  JAPANESE_LOCALE,
  KOREAN_LOCALE,
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

const LOCALE_ALIASES: Record<string, Locale> = {
  en: DEFAULT_LOCALE,
  "en-us": DEFAULT_LOCALE,
  "en-gb": DEFAULT_LOCALE,
  zh: CHINESE_LOCALE,
  "zh-cn": CHINESE_LOCALE,
  "zh-hans": CHINESE_LOCALE,
  "zh-hans-cn": CHINESE_LOCALE,
  "zh-sg": CHINESE_LOCALE,
  es: SPANISH_LOCALE,
  "es-es": SPANISH_LOCALE,
  "es-mx": SPANISH_LOCALE,
  "es-419": SPANISH_LOCALE,
  pt: PORTUGUESE_LOCALE,
  "pt-br": PORTUGUESE_LOCALE,
  "pt-pt": PORTUGUESE_LOCALE,
  fr: FRENCH_LOCALE,
  "fr-fr": FRENCH_LOCALE,
  "fr-ca": FRENCH_LOCALE,
  de: GERMAN_LOCALE,
  "de-de": GERMAN_LOCALE,
  ja: JAPANESE_LOCALE,
  "ja-jp": JAPANESE_LOCALE,
  ko: KOREAN_LOCALE,
  "ko-kr": KOREAN_LOCALE,
};

export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace("_", "-");
  return LOCALE_ALIASES[key] ?? null;
}

export function resolveRequestLocale(input: {
  explicitLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  const explicit = normalizeLocale(input.explicitLocale);
  if (explicit) return explicit;

  const cookie = normalizeLocale(input.cookieLocale);
  if (cookie) return cookie;

  return resolveAcceptLanguageLocale(input.acceptLanguage) ?? DEFAULT_LOCALE;
}

export function resolveAcceptLanguageLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;

  const parsed = value
    .split(",")
    .map((part) => {
      const [language = "", qValue = "q=1"] = part.trim().split(";");
      const q = Number(qValue.trim().replace(/^q=/, ""));
      return {
        language,
        q: Number.isFinite(q) ? q : 1,
      };
    })
    .sort((a, b) => b.q - a.q);

  for (const item of parsed) {
    const locale = normalizeLocale(item.language);
    if (locale) return locale;
  }

  return null;
}

export function localeToHtmlLang(locale: Locale): string {
  return locale;
}

export function appendWebUILocaleSearchParams(url: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return url;

  try {
    const parsed = new URL(url);
    parsed.searchParams.set("locale", locale);
    parsed.searchParams.set("lang", locale);
    return parsed.toString();
  } catch {
    return url;
  }
}

const BASE_MARKETING_COPY = {
  en: {
    localeLabel: "English",
    languageSelectorLabel: "Language",
    nav: {
      pricing: "Pricing",
      roadmap: "Roadmap",
      tokenVerification: "Token verification",
      register: "Register",
      login: "Log in",
      openDashboard: "Open Dashboard",
      mobileMenu: "Open menu",
      closeMobileMenu: "Close menu",
    },
    hero: {
      eyebrow: "Now Live",
      headlinePrefix: "Launch AI agents",
      headlineEmphasis: "in one click.",
      primary:
        "Run AI coding agents, AI researchers, and AI operators in the cloud. No VPS setup, no terminals, no server management — just launch and start working.",
      secondary:
        "Free to start — no credit card required. Pay with card or $HermesOS when you scale.",
      primaryCta: "Launch Your First Agent",
      secondaryCta: "See How It Works",
      proofPoints: [
        "Launch in minutes",
        "Keys stay encrypted",
        "Cancel anytime",
      ],
    },
    ticker: {
      proofPoints: [
        "Deploy any AI agent in one click",
        "BYO key, zero markup",
        "Free tier always available",
      ],
    },
    positioning: {
      title: "Powerful agents, zero ops.",
      body:
        "The best AI agents — persistent assistants like Hermes, browser drivers, coding agents — are powerful but a pain to run yourself: a server, Docker, config files, a weekend lost to setup, then uptime and updates forever. Hivra runs any of them on managed cloud infrastructure, with persistent memory that compounds every session.",
      punchline: "Pick an agent, click deploy — it's live in five minutes.",
    },
    features: {
      eyebrow: "Why Hivra",
      titlePrefix: "Most agents stop the moment you close your laptop.",
      titleEmphasis: "Hivra keeps them running.",
      items: [
        {
          headline: "Always online",
          body:
            "Your agents keep working in the cloud — even when your laptop is closed and you've logged off for the day.",
        },
        {
          headline: "Accessible anywhere",
          body:
            "Open and control your agents from any browser, on any device. Nothing to install.",
        },
        {
          headline: "No technical setup",
          body:
            "Skip the VPS, SSH, Linux, and server maintenance. If you can use a website, you can use Hivra.",
        },
        {
          headline: "Managed for you",
          body:
            "We handle the infrastructure, uptime, and updates so you can focus on results — not DevOps.",
        },
        {
          headline: "Recovers on its own",
          body:
            "If an agent crashes, it restarts automatically — with daily backups, so you're never more than a day from a clean restore.",
        },
        {
          headline: "Your keys stay private",
          body:
            "Bring your own AI key. Encrypted at rest, injected at launch, never logged — and zero markup on what you spend.",
        },
      ],
    },
    howItWorks: {
      eyebrow: "Getting started",
      titlePrefix: "Three steps",
      titleEmphasis: "to get started.",
      steps: [
        {
          step: "1",
          headline: "Choose an agent",
          body:
            "Pick the AI worker that fits your goal — a coding agent, a researcher, or an operator.",
        },
        {
          step: "2",
          headline: "Connect your API keys",
          body:
            "Paste your AI provider key once. Encrypted, stored securely, and injected at launch.",
        },
        {
          step: "3",
          headline: "Launch",
          body:
            "Your agent is now running in the cloud — no servers required. Start working right away.",
        },
      ],
      footer: "That's it. Your agent runs in the cloud while you get on with your day.",
      cta: "Launch Your First Agent",
    },
    useCases: {
      eyebrow: "Use cases",
      titlePrefix: "What can you",
      titleEmphasis: "actually do?",
      intro:
        "Put an AI worker on the job and let it run — in the cloud, around the clock.",
      items: [
        {
          headline: "Build software",
          body:
            "Launch Claude Code and let it write code, fix bugs, and work on your projects straight from the cloud.",
        },
        {
          headline: "Research faster",
          body:
            "Launch Hermes Agent to gather information, browse websites, and investigate topics for you.",
        },
        {
          headline: "Automate repetitive work",
          body:
            "Hand off the tasks that normally eat hours of your day — triage, scheduling, data entry, follow-ups.",
        },
        {
          headline: "Run long-term projects",
          body:
            "Keep agents working for hours or days without leaving your own computer on.",
        },
      ],
      footer:
        "Pick the worker that fits your goal and launch it in a click.",
      cta: "Launch Your First Agent",
    },
    whatsComing: {
      eyebrow: "What's coming",
      titlePrefix: "Today you launch agents.",
      titleEmphasis: "Tomorrow you'll discover, deploy, and monetise them.",
      intro: "Hivra is just getting started. Coming soon:",
      items: [
        {
          title: "Agent Marketplace",
          body:
            "Discover ready-to-run agents built by the community.",
        },
        {
          title: "Publish your own agents",
          body:
            "Package what you build and share it with other users.",
        },
        {
          title: "Agent collaboration",
          body:
            "Let multiple agents work together on the same goal.",
        },
        {
          title: "Shared intelligence",
          body:
            "Agents learn from successful workflows across the network.",
        },
      ],
      footer:
        "The future of work isn't one AI — it's teams of AI agents. Hivra is building the easiest place to launch them.",
    },
    pricing: {
      eyebrow: "Pricing",
      titlePrefix: "Start free.",
      titleEmphasis: "Scale when you're ready.",
      intro: "Pick the plan that matches how much you lean on AI. Upgrade or downgrade anytime.",
      compute: "Compute",
      mostPopular: "Most Popular",
      forPros: "For Pros",
      getStarted: "Get Started",
      recommended: "Recommended",
      accessPrefix: "Three ways to access",
      footnote:
        "Save up to 40% paying with $HermesOS. Launch pricing for the first wave — rates may adjust as the platform matures.",
      guarantee: "Free tier — try before you upgrade · 48-hr refund on card payments",
      tiers: [
        {
          name: "Free",
          tagline:
            "Perfect for trying Hivra.",
          price: "$0",
          priceNote: "No credit card required to start",
          specs: [
            { label: "vCPU", value: "0.5" },
            { label: "RAM", value: "1 GB" },
            { label: "Active agents", value: "1" },
          ],
          features: [
            "One starter agent — sleeps after 4 idle days",
            "Basic cloud resources",
            "Community support",
            "No credit card required",
          ],
          ctaLabel: "Start Free",
        },
        {
          name: "Pro",
          tagline: "For people who rely on AI every day.",
          price: "$9.99",
          priceCadence: "/mo",
          priceNote: "Subscribe monthly with card",
          specs: [
            { label: "vCPU", value: "2" },
            { label: "RAM", value: "4 GB" },
            {
              label: "Concurrent agents",
              value: "3",
              tooltip:
                "How many of your agents can run tasks at the same moment. Profiles are unlimited — this is the live-execution cap.",
            },
          ],
          features: [
            "Always-on — never paused for inactivity",
            "Claude Code + Hermes Agent",
            "Browser automation",
            "More power, faster performance",
          ],
          paymentPaths: [
            { label: "Monthly card", detail: "$9.99/mo" },
            { label: "Yearly", detail: "$79/yr card · $49/yr in $HermesOS" },
            { label: "Hold $HermesOS", detail: "~$149 in $HermesOS" },
          ],
          ctaLabel: "Upgrade to Pro",
        },
        {
          name: "Power",
          tagline: "For teams, operators, and heavy workloads.",
          price: "$19.99",
          priceCadence: "/mo",
          priceNote: "Subscribe monthly with card",
          specs: [
            { label: "vCPU", value: "4" },
            { label: "RAM", value: "8 GB" },
            {
              label: "Concurrent agents",
              value: "5",
              tooltip:
                "Run up to 5 agents in parallel, sharing your plan's compute pool.",
            },
          ],
          features: [
            "Multiple agents at once",
            "Long-running projects",
            "Advanced automation",
            "Priority support",
          ],
          paymentPaths: [
            { label: "Monthly card", detail: "$19.99/mo" },
            { label: "Yearly", detail: "$149/yr card · $99/yr in $HermesOS" },
            { label: "Hold $HermesOS", detail: "~$299 in $HermesOS" },
          ],
          ctaLabel: "Go Power",
        },
      ],
    },
    token: {
      eyebrow: "About $HermesOS",
      title: "The access layer for the platform.",
      body:
        "$HermesOS lets you pay subscriptions for a discount, hold to maintain your tier without paying monthly, or transact across the agent economy as we ship it.",
      secondary:
        "The token isn't required to use Hivra — the free tier stays available without it, with anti-abuse checks where needed. If you want to be in the ecosystem deeper, holding $HermesOS unlocks more flexibility on how you pay and access.",
      cta: "Token verification page",
    },
    faq: {
      eyebrow: "Common questions",
      title: "Straight answers.",
      items: [
        {
          q: "What is Hivra?",
          a:
            "Hivra is a platform that lets you launch and manage AI agents in the cloud — coding agents, researchers, and operators that work for you, around the clock.",
        },
        {
          q: "Do I need a VPS?",
          a:
            "No. Hivra handles all the infrastructure for you — no servers, SSH, or Linux required.",
        },
        {
          q: "Do I need technical experience?",
          a:
            "No. If you can use a website, you can use Hivra. Choose an agent, connect your key, and launch.",
        },
        {
          q: "What agents are available?",
          a:
            "Claude Code and Hermes Agent today, with more — OpenClaw, Codex, AEON — coming soon.",
        },
        {
          q: "Is my API key safe?",
          a:
            "Yes. Your keys are encrypted at rest and injected at launch via environment variables. We never proxy or log your AI requests.",
        },
        {
          q: "Do I need $HermesOS to use it?",
          a:
            "No. The free tier doesn't require it, and Pro and Power can be paid with a card. $HermesOS just gives you discounts and a third way to pay if you want it.",
        },
        {
          q: "What happened to HermesOS?",
          a:
            "HermesOS is evolving into Hivra as the platform expands beyond a single agent ecosystem. Existing deployments, accounts, and $HermesOS continue to operate normally.",
        },
      ],
    },
    finalCta: {
      eyebrow: "Start now",
      title: "Ready to deploy?",
      body: "Free tier is live with abuse safeguards. Pro and Power are available now.",
      primary: "Start Free",
      secondary: "See Pricing",
      note: "Most free users can start without a card; higher-risk signups may need a card-on-file check.",
      accountPrefix: "Already have an account?",
      accountLink: "Log in",
    },
    getStarted: {
      loadingCheckout: "Redirecting to checkout...",
      steps: {
        choosePlan: "Choose Plan",
        createAccount: "Create Account",
        activate: "Activate",
        payment: "Payment",
      },
      badges: {
        free: "Always Free",
        paid: "7-Day Money-Back Guarantee",
      },
      yourPlan: "Your Plan",
      perMonth: "/mo",
      perYear: "/yr",
      cadence: {
        monthly: "Monthly",
        yearly: "Yearly",
        saveLabel: "save ~{percent}%",
        saveDollarsLabel: "Save ~${dollars}/yr",
      },
      // Generic, true market anchor for the paid cards. The competitor's entry
      // paid tier starts at $19/mo — we keep it generic (no competitor name) and
      // honest. Edit this single string to change the anchor everywhere.
      marketAnchor: "Comparable agent platforms start around $19/mo",
      mostPopular: "Most popular",
      freeGap: "Sleeps after 4 idle days · no web browsing · no persistent memory · no scheduled tasks · 0.5 vCPU",
      specs: {
        agents: "Agents",
        cpu: "CPU",
        ram: "RAM",
      },
      guarantee: {
        free: "No checkout required",
        paid: "7-day money-back guarantee",
      },
      switchPlan: "Switch Plan",
      bestFit: "Best Fit",
      planGuidance: {
        free:
          "Free is best for trying Hermes with one guarded starter agent. It sleeps after 4 idle days to keep costs down — a tap brings it back. Most users can launch without a card; higher-risk free-tier deploys may need card verification first.",
        operator:
          "Pro is best for solo builders and daily drivers — your agent stays always-on (never paused for inactivity) with room for three running at once.",
        fleet:
          "Power is best for multi-agent workflows, heavier browsing, and teams that want more compute headroom immediately.",
        command:
          "Command is best for the biggest workloads, the fastest scaling path, and maximum compute per deployment.",
      },
      createAccountTitle: "Create your account.",
      createAccountIntroFree:
        "Your account details become your login credentials. After signup, we'll activate your Free plan and take you straight to deployment. Most users can launch without a card; higher-risk free-tier deploys may need card verification first.",
      createAccountIntroPaid:
        "Your account details become your login credentials. After signup, you'll continue to secure checkout. Protected by our 7-day money-back guarantee.",
      legalPrefix: "By continuing, you agree to our",
      terms: "Terms of Service",
      and: "and",
      privacy: "Privacy Policy",
    },
    dashboard: {
      nav: {
        chat: "Chat",
        commandCenter: "Command Center",
        home: "Home",
        computers: "Computers",
        agents: "Agents",
        infrastructure: "Infrastructure",
        collaboration: "Collaboration",
        settings: "Settings",
        launch: "Launch",
        ops: "Ops",
        promptLibrary: "Prompt Library",
        wallet: "Wallet",
        billing: "Billing",
      },
      sections: {
        advanced: "Advanced",
        support: "Support",
      },
      support: {
        discord: "Discord",
        xTwitter: "X (Twitter)",
        email: "Email Support",
      },
      legal: {
        terms: "Terms",
        privacy: "Privacy",
      },
      controls: {
        expandSidebarTitle: "Expand Sidebar",
        collapseSidebarTitle: "Collapse Sidebar",
        expandSidebarLabel: "Expand dashboard sidebar",
        collapseSidebarLabel: "Collapse dashboard sidebar",
        globalSettings: "Global Settings",
      },
      commandCenter: {
        phase: "Phase II: Fleet Operations",
        titlePrefix: "Command",
        titleSeparator: " ",
        titleEmphasis: "Center",
        titleSuffix: ".",
        labelSeparator: ": ",
        sections: {
          activeAgents: "Active Agents",
          activeCoreInstances: "Active Core Instances",
          infrastructureNodes: "Infrastructure Nodes",
        },
        actions: {
          advancedConsole: "Advanced Console",
          applyChanges: "Apply Changes",
          applying: "Applying...",
          cancel: "Cancel",
          confirmRemove: "Confirm Remove",
          coreConsole: "Core Console",
          initializeAgent: "Initialize Agent",
          manageAllocation: "Manage Allocation",
          removeNode: "Remove Node",
          removing: "Removing...",
        },
        alerts: {
          activeFailureTitle: "Active failure needs attention",
          activeFailurePrefix: "Hermes found an active failure on",
          activeFailureSingular: "instance",
          activeFailurePlural: "instances",
          activeFailureSuffix: "Each item now shows who owns the next step.",
          recoveryPrefix: "Recovery",
          updateTitle: "Update attention needed",
          updateSummaryPrefix: "Hermes saw an update problem on",
          updateSummarySingular: "instance",
          updateSummaryPlural: "instances",
          updateSummarySuffix:
            "Your mounted Docker data stays in place, but these agents need a quick check.",
          scheduledUpdateFailed:
            "The last auto-update failed. Your Docker volumes stay mounted, but this instance needs a quick check.",
          manualUpdateFailed:
            "The last manual update failed. Your Docker volumes stay mounted, but this instance needs a quick check.",
        },
        status: {
          running: "running",
          provisioning: "provisioning",
          stopped: "stopped",
          error: "error",
          failed: "failed",
        },
        instance: {
          activeAgentSingular: "Active Agent",
          activeAgentPlural: "Active Agents",
          configuredInAgentSettings: "Configured in agent settings",
          coreSingular: "Core",
          corePlural: "Cores",
          fetchingProfiles: "Fetching Profiles...",
          hostInstancePrefix: "Host Instance",
          idPrefix: "ID",
          primaryAgent: "Primary Agent",
          profileNode: "Profile Node",
          secondaryAgent: "Secondary Agent",
        },
        telemetry: {
          activeModel: "Active Model",
          containerState: "Container State",
          cpuUtilization: "CPU Utilization",
          hostComputeNode: "Host compute node",
          limitPrefix: "Limit",
          llmInferenceEngine: "LLM inference engine",
          memoryAllocation: "Memory Allocation",
          networkIo: "Network I/O",
          provider: "Provider",
          providerPrefix: "Provider",
          totalTxPrefix: "Total Tx",
          unrestricted: "UNRESTRICTED",
          uptimePrefix: "Uptime",
        },
        allocation: {
          cpuAllocated: "CPU Allocated",
          cpuAllocation: "CPU Allocation",
          cpuCapacityError:
            "Total CPU allocation ({allocated}) exceeds node capacity ({capacity}).",
          dangerZone: "Danger Zone",
          deleteConfirmationPhrase: "please delete",
          deletePromptPrefix: "Type",
          deletePromptSuffix:
            "to confirm removal. This will permanently destroy the infrastructure and any offline agents on it.",
          failedToRemoveHost: "Failed to remove host",
          memoryAllocated: "Memory Allocated",
          memoryAllocation: "Memory (RAM) Allocation",
          memoryCapacityError:
            "Total memory allocation ({allocated}GB) exceeds node capacity ({capacity}GB).",
          noActiveAgents: "No active agents on this node.",
          nodeAllocationPrefix: "Node Allocation",
          projectedNodeUsage: "Projected Node Usage",
        },
        errors: {
          failedToLoadOperations: "Failed to load operations data",
        },
      },
      library: {
        returnToCommandCenter: "Return to Command Center",
        titlePrefix: "Prompt",
        titleSeparator: " ",
        titleEmphasis: "Library",
        titleSuffix: ".",
        intro:
          "Deploy highly specialized agent templates with battle-tested system prompts. Curated from the premium Agency blueprint.",
        sourcePrefix: "Templates graciously sourced from",
        sourceLinkLabel: "Michal Sitarzewski's Agency Agents",
        sourceSuffix: ".",
        searchPlaceholder: "Search templates by name or description...",
        featured: "Featured",
        allTemplates: "All Templates",
        viewPrompt: "View Prompt",
        deploy: "Deploy",
        empty: "No templates found matching your criteria",
        copied: "Copied!",
        copyPrompt: "Copy Prompt",
        deployTemplate: "Deploy This Template",
        closePreview: "Close prompt preview",
        categories: {
          All: "All",
          Engineering: "Engineering",
          Design: "Design",
          Marketing: "Marketing",
          Product: "Product",
          Operations: "Operations",
          Research: "Research",
          Security: "Security",
          Finance: "Finance",
        },
      },
      wallet: {
        eyebrowLegacy: "Wallet · Deposit & withdraw",
        eyebrowSelfCustody: "Wallet · Sign to verify",
        titlePrefix: "Your",
        titleSeparator: " ",
        titleEmphasis: "$HermesOS",
        titleSuffix: " wallet.",
        legacyIntroStrong: "Grandfathered custody wallet",
        legacyIntroBody:
          "your existing deposit and withdraw flow stays active. Lock today's $HERMESOS price for the tier you want, then send the quoted amount to your deposit address. Free tier always works without a deposit.",
        selfCustodyIntroStrong: "Connect your own wallet",
        selfCustodyIntroBody:
          "hold $HermesOS and VVV yourself, then sign a message to verify ownership. Free tier always works without token verification.",
        priceUnavailable: "Token price unavailable — please try again later.",
        buyToken: {
          ariaLabel: "Buy $HermesOS",
          eyebrow: "Get $HermesOS",
          title: "Buy on Uniswap (Base network).",
          action: "Buy on Uniswap →",
          contractLabel: "Contract address (Base)",
          copyContractLabel: "Copy contract address",
          copied: "Copied",
          copy: "Copy",
          warningPrefix: "Always verify the contract address on",
          warningLink: "hermesos.cloud/token",
          warningSuffix: "before sending funds. Ignore addresses copied from DMs, replies, or screenshots.",
        },
        verification: {
          ariaLabel: "Wallet verification",
          eyebrow: "Self-custody verification",
          connectedTitle: "Wallet connected.",
          disconnectedTitle: "Verify from your wallet.",
          activeWallet: "Active wallet",
          lastCheckedPrefix: "Last checked",
          connecting: "Connecting...",
          checking: "Checking...",
          connectWallet: "Connect wallet",
          changeWallet: "Change wallet",
          refreshBalance: "Refresh balance",
          checkLock: "Check {tier} lock",
          lockPrice: "Lock {tier} price",
          lockedFor20: "{tier} price locked for 20 minutes at",
          holdAtLeastThatAmount: "Hold at least that amount in this wallet before the lock expires.",
          yourRateLockedAt: "Your {tier} rate is locked at",
          lockNext: "Lock the {tier} price next if you want that tier.",
          keepEligible: "Keep that amount in this wallet to stay eligible.",
          detected: "Detected",
          snapshotInstruction: "Lock {tier} price to snapshot the token amount for 20 minutes.",
          refreshInstruction: "Refresh balance to confirm your current tier.",
          connectedFootnote:
            "Only one wallet can be active at a time. Changing wallets replaces the active wallet; signatures cannot move tokens.",
          disconnectedBody:
            "Keep $HermesOS and VVV in your own Base wallet. A signed message proves ownership without sending tokens to Hivra.",
          verifiedSuffix: "verified.",
        },
        eligibility: {
          ariaLabel: "Tier eligibility",
          eyebrow: "Tier eligibility",
          currentBalancePrefix: "Current balance:",
          autoRefreshPrefix: "Auto-refreshes every 5 min · last checked",
          refreshBalanceLabel: "Refresh balance",
          refresh: "Refresh",
          thresholdsMissing:
            "Tier thresholds have not been configured yet. Eligibility is not being evaluated. Check back when the deposit flow goes live.",
          proTier: "Pro tier",
          powerTier: "Power tier",
          eligible: "Eligible",
          breached: "Breached — eligibility ended",
          notYetEligible: "Not yet eligible",
          holdAtLeast: "Hold at least",
          depositAtLeast: "Deposit at least",
          selfCustodyQualifySuffix: "in your verified wallet to qualify for the {tier} tier without a subscription.",
          custodyQualifySuffix: "to qualify for the {tier} tier without a subscription.",
          lockedAtPrice: "Locked at the price you quoted — refreshes when the quote expires.",
        },
        agentWallets: {
          ariaLabel: "Agent wallets",
          title: "Agent wallets.",
          subtitle: "One wallet per agent · your own Bankr account · Base only",
          emptyNoAgents:
            "Launch an agent, then connect your own Bankr account to give it a wallet.",
          deployAgent: "Deploy an agent",
          runningEmpty: "Running agents will appear here.",
        },
      },
      billing: {
        eyebrow: "Billing",
        titlePrefix: "Plan",
        titleSeparator: " & ",
        titleEmphasis: "billing",
        titleSuffix: "",
        subtitle: "Your plan, how you pay, and what you've used.",
        refreshing: "Refreshing…",
        credits: {
          title: "Credits",
          available: "available",
          description:
            "Account credits pay for usage. They don't set your plan: that comes from a subscription, a yearly $HermesOS payment or holding $HermesOS.",
          monthlyGrantSuffix: "monthly plan credits",
        },
        activity: {
          eyebrow: "Billing Activity",
          title: "Recent account movement",
          loading: "Loading",
          ledger: "Ledger",
          ledgerLoading: "Loading ledger...",
          ledgerEmpty: "No ledger entries yet.",
          payments: "Payments",
          paymentsLoading: "Loading payments...",
          paymentsEmpty: "No payments yet.",
          compute: "Compute",
          computeLoading: "Loading compute...",
          computeEmpty: "No compute usage yet.",
          llm: "LLM",
          llmLoading: "Loading LLM...",
          llmEmpty: "No LLM usage yet.",
        },
        tokenAccess: {
          eyebrow: "Token Access",
          title: "$HermesOS Holding",
          description:
            "Hold at least the minimum $HermesOS in a verified wallet to unlock a basic machine. If your balance drops below the minimum, agents on that machine keep running for a grace period, then pause until you hold enough again.",
          checking: "Checking",
          unavailable: "Unavailable",
          ready: "Minimum met",
          belowMinimum: "Below minimum",
          noWallet: "No verified wallet",
          wallet: "Wallet",
          balance: "Balance",
          minimum: "Minimum",
          notVerified: "Not verified",
          noSnapshot: "No snapshot",
          refresh: "Refresh Token Status",
          refreshing: "Refreshing...",
          connectWallet: "Connect Wallet",
          connecting: "Connecting...",
          verifyDifferent: "Verify Different Wallet",
        },
        cryptoCredits: {
          eyebrow: "Crypto Credits",
          description:
            "Pick an amount and we'll give you an address to send USDC to on Base. Credits are added once the transfer is confirmed.",
          bonusPath: "Bonus path prepared",
          pendingDeposit: "Pending Deposit",
          createTopUpLabel: "Create USDC top-up for {credits} credits",
          sendPrefix: "Send",
          onNetwork: "on",
          reference: "Reference",
        },
        activePlan: {
          title: "Current plan",
          heldViaTokens: "HELD VIA $HERMESOS",
          perMonth: "/month",
          agents: "Agents & computers",
          cpuBudget: "vCPU",
          ramBudget: "Memory",
          manageSubscription: "Manage payment method",
          opening: "Opening...",
        },
        switcher: {
          title: "Change plan",
          description:
            "Upgrade anytime. Downgrades are not available — dedicated servers cannot be scaled down.",
          currentPlan: "Current Plan",
          upgrade: "Upgrade",
          lowerTier: "Lower Tier",
          unlimited: "Unlimited",
          agents: "agents",
          active: "Active",
          guarantee: "48-hour refund policy · Upgrade-only plans",
        },
        noSubscription: {
          title: "No plan yet",
        },
        plate: {
          slots: "Slots",
          vcpu: "vCPU",
          memory: "Memory",
          idlePolicy: "Idle policy",
          alwaysOn: "Always on",
          sleepsAfterIdle: "Sleeps after {days} idle days",
        },
      },
      settings: {
        loading: "Loading...",
        returnToCommandCenter: "Return to Command Center",
        titlePrefix: "Global",
        titleSeparator: " ",
        titleEmphasis: "Settings",
        titleSuffix: ".",
        intro: "Configure your workspace, interface themes, and application behavior.",
        sections: {
          appearance: "Appearance",
          chatInterface: "Chat & Agent Interface",
          capabilities: "Capabilities & Plugins",
          dangerZone: "Danger Zone",
        },
        theme: {
          label: "Theme",
          description: "Light, dark, or match your device.",
          light: "Light",
          dark: "Dark",
          system: "System",
        },
        language: {
          label: "Language",
          description: "Choose the language used across Hivra.",
        },
        reducedMotion: {
          label: "Reduced Motion",
          description: "Minimize transitions and heavy UI animations.",
        },
        autoScroll: {
          label: "Auto-Scroll Chat Frame",
          description: "Automatically pin to the bottom when new messages arrive.",
        },
        streamingAnimations: {
          label: "Streaming Animations",
          description: "Show fade-in markdown effects when receiving agent streams.",
        },
        aiReasoning: {
          label: "Uncollapse AI Reasoning",
          description: "Start with the AI's \"Thinking\" block automatically expanded.",
        },
        persistentMemory: {
          label: "Enable Persistent Memory",
          description:
            "Allow Hermes to write its own memories to MEMORY.md across sessions using the pluggable memory provider.",
        },
        plugins: {
          label: "Enable Extensible Plugins / Skills",
          description: "Give Hermes access to upstream MCP/ACP skills and experimental tools.",
        },
        clearCache: {
          label: "Clear the local cache",
          description:
            "Clears dashboard data cached in this browser and layout choices saved here, like terminal tabs, then reloads the page. Your account, agents and computers aren't affected.",
          action: "Clear cache",
        },
        hub: {
          title: "Settings",
          intro: "Your account, billing, keys and agent tools, plus how Hivra looks in this browser.",
          groups: {
            account: "Account",
            billing: "Plan and billing",
            connections: "Keys and connections",
            toolkit: "Agent toolkit",
            device: "On this device",
            apps: "Apps and help",
            reset: "Reset this browser",
          },
          profile: {
            title: "Profile and sign-in",
            signedInAs: "Signed in as {email}",
            fallback: "Your name, email, security and sign-out.",
            selfHostTitle: "Sign-in",
            selfHostFallback: "Signed in to this self-hosted Hivra.",
            signOut: "Sign out",
            signingOut: "Signing out…",
            signOutFailed: "Couldn't sign out. Try again.",
          },
          rows: {
            billing: { description: "Plan, payment methods, credits and invoices" },
            wallets: { title: "Wallets", description: "Agent wallets and $HermesOS access" },
            apiKeys: { title: "API keys", description: "Provider keys and which agents use them" },
            infrastructure: { description: "The machines and cloud accounts your agents run on" },
            memory: { title: "Shared agent memory", description: "What every new agent starts out knowing" },
            tools: { title: "Tools and capabilities", description: "Add tools to the agents you choose" },
            library: { title: "Prompt library", description: "Ready-made agent roles with tested prompts" },
            templates: { title: "Templates", description: "Save a configured agent and launch it again" },
            referral: { title: "Invite and earn", description: "Share your link and earn credits together" },
            applications: { title: "Applications", description: "Use Hivra in your browser or as a web app" },
            help: { title: "Help", description: "Support, community and legal information" },
          },
          motionNote: "Motion follows your device's reduce-motion setting.",
          clearCacheConfirm: "Press again to clear and reload",
          clearCacheArmed: "Press the button again within 4 seconds to clear the cache and reload.",
        },
      },
      userModeSuffix: "Mode",
      versionLabel: "Foundation v0.9.0",
    },
    stats: {
      hero: {
        eyebrow: "Live · agents on Hivra",
        label: "agents launched on Hivra",
        fullStats: "Full stats →",
      },
      page: {
        eyebrow: "Live counter",
        headlinePrefix: "Agents",
        headlineEmphasis: "deployed",
        headlineSuffix: "on Hivra",
        body: "Every time someone successfully deploys an agent, this counter ticks up.",
        allTimeLabel: "All-time successful deploys",
        ariaTotal: "agents deployed all-time",
        cards: {
          last24h: "Last 24 hours",
          last7d: "Last 7 days",
          firstDeploy: "First deploy",
        },
        sparkline: {
          titlePrefix: "Daily deploys,",
          titleEmphasis: "last 30 days",
          hint: "Hover or focus a bar for the exact count",
          peak: "peak day",
          total: "30-day total",
          barLabel: "{date}: {count} deploys",
        },
        cta: {
          button: "Deploy your agent →",
          subtitle: "Free tier — 1 agent, 0.5 vCPU, 1 GB RAM",
        },
      },
    },
    footer: {
      links: {
        features: "Features",
        compare: "Compare",
        blog: "Blog",
        roadmap: "Roadmap",
        tokenVerification: "Token verification",
        privacy: "Privacy",
        terms: "Terms",
      },
    },
  },
  "zh-CN": {
    localeLabel: "简体中文",
    languageSelectorLabel: "语言",
    nav: {
      pricing: "价格",
      roadmap: "路线图",
      tokenVerification: "代币验证",
      register: "注册",
      login: "登录",
      openDashboard: "打开控制台",
      mobileMenu: "打开菜单",
      closeMobileMenu: "关闭菜单",
    },
    hero: {
      eyebrow: "现已上线",
      headlinePrefix: "你的 AI Agent，",
      headlineEmphasis: "始终在线。",
      primary:
        "Hivra 可在 5 分钟内启动你的 Hermes Agent，并默认带有持久记忆、浏览器自动化和工具调用。不用 Docker，不用配置文件，也不用半夜排查部署问题。",
      secondary:
        "免费层级已经开放。Pro 和 Power 适合更重的正式工作负载。支持银行卡或 $HermesOS 支付。",
      primaryCta: "免费开始",
      secondaryCta: "查看流程",
      proofPoints: [
        "免费层级始终可用",
        "自带密钥，无加价",
        "基于 Hermes Agent",
      ],
    },
    ticker: {
      proofPoints: [
        "基于 Hermes Agent（Nous Research）",
        "自带密钥，零加价",
        "免费层级始终可用",
      ],
    },
    positioning: {
      title: "OpenClaw 会遗忘，Hermes 会积累。",
      body:
        "Hermes 由 Nous Research 打造，运行在服务器上，能记住项目、偏好和经验。每一次会话都会让它更了解你的工作。自己托管通常要花掉一个周末。",
      punchline: "Hivra 把这个周末压缩到 5 分钟。",
    },
    features: {
      eyebrow: "包含内容",
      titlePrefix: "Agent 需要的能力都在这里。",
      titleEmphasis: "不需要的复杂度都拿掉。",
      items: [
        {
          headline: "零配置，完整栈。",
          body:
            "浏览器自动化、工具调用、终端、记忆和定时任务都已预配置。不用 Docker，也不用深夜翻文档。",
        },
        {
          headline: "第一天就支持多 Agent。",
          body:
            "一个实例可拥有无限 Agent 档案。研究员、运营、专家角色都能共存，不按 Agent 额外收费。",
        },
        {
          headline: "你的密钥，零加价。",
          body:
            "支持 OpenRouter、OpenAI 和 Anthropic。密钥静态加密，部署时注入。我们不抽成你的 AI 用量。",
        },
        {
          headline: "随处聊天。",
          body:
            "内置流式控制台。Telegram、Discord、Slack 或 WhatsApp 集成开箱即用。",
        },
        {
          headline: "内置 OpenClaw 迁移。",
          body:
            "现有配置、提示词和技能可完整迁移，不用从零开始。",
        },
        {
          headline: "稳定、可恢复、一直在线。",
          body:
            "更新会先按你的配置测试。失败自动重启。每日备份，最多 24 小时即可回到干净状态。",
        },
      ],
    },
    howItWorks: {
      eyebrow: "如何运作",
      titlePrefix: "三步完成。",
      titleEmphasis: "无需打开终端。",
      steps: [
        {
          step: "1",
          headline: "选择层级",
          body:
            "先从免费开始，需要更多算力再升级。可按月刷卡、按年折扣支付，或持有 $HermesOS 获得访问资格。",
        },
        {
          step: "2",
          headline: "添加 AI 密钥",
          body:
            "只需粘贴一次 OpenRouter、OpenAI 或 Anthropic 密钥。加密、注入、完成。",
        },
        {
          step: "3",
          headline: "部署、对话、自动化。",
          body:
            "几分钟内 Agent 上线，带聊天、终端和监控。连接 Telegram 或 Discord 后，它可以随时跟着你工作。",
        },
      ],
      footer: "准备从了解进入搭建？选择层级后即可直接创建账户。",
      cta: "选择层级",
    },
    useCases: {
      eyebrow: "使用场景",
      titlePrefix: "一个带记忆的 24/7 Agent",
      titleEmphasis: "到底能做什么？",
      intro:
        "它可以浏览网页、写代码、管理文件、调用 API、运行定时任务，并记住上周学到的东西。",
      items: [
        {
          headline: "运维与监控",
          body:
            "读取日志、重启失败服务，只在真的需要人工时提醒你，并记住你的技术栈。",
        },
        {
          headline: "研究与竞品情报",
          body:
            "给它主题和截止时间，它会浏览、汇总并交付结构化简报，还会保存经验供下次使用。",
        },
        {
          headline: "后台自动化",
          body:
            "邮件分拣、日程安排、API 调用、表格处理等重复工作都可定时运行。",
        },
        {
          headline: "客服分流",
          body:
            "接入你的文档后，它能处理常见问题，把复杂问题升级，并在每次对话后变得更聪明。",
        },
      ],
      footer: "看到了 Hermes 可以帮你接手哪些工作？选择计划，启动匹配你负载的工作流。",
      cta: "查看计划并启动",
    },
    whatsComing: {
      eyebrow: "即将推出",
      titlePrefix: "这只是",
      titleEmphasis: "开始。",
      intro: "托管是基础。接下来会有：",
      items: [
        {
          title: "Operator Packs",
          body:
            "面向研究、交易情报、内容自动化等具体工作的预置 Agent 模板，一键部署。",
        },
        {
          title: "Marketplace",
          body:
            "构建 Operator Pack，发布给社区，并从使用中获得收益，以 $HermesOS 结算。",
        },
        {
          title: "Agent Endpoints",
          body:
            "把你的 Agent 暴露为可调用 API，其他 Agent 可按请求向你付费。",
        },
        {
          title: "Hive Mind",
          body:
            "Agent 共享经验，整个网络一起变聪明。",
        },
      ],
      footer: "Hivra 是 Agent 经济的基础设施。托管只是第一步，后续能力都会在它之上展开。",
    },
    pricing: {
      eyebrow: "价格",
      titlePrefix: "简单计划。",
      titleEmphasis: "认真算力。",
      intro: "专属算力、无限 Agent 档案、自带密钥、零加价。",
      compute: "算力",
      mostPopular: "最受欢迎",
      forPros: "专业用途",
      getStarted: "开始使用",
      recommended: "推荐",
      accessPrefix: "访问方式：",
      footnote:
        "使用 $HermesOS 支付最高可省 40%。首批用户享启动价格，平台成熟后价格可能调整。",
      guarantee: "免费层级 — 先试用再升级 · 刷卡付款 48 小时退款",
      tiers: [
        {
          name: "Free",
          tagline:
            "大多数用户无需银行卡即可启动；风险较高的免费部署可能需要先完成银行卡验证。",
          price: "$0",
          priceNote: "始终免费；仅在风控需要时验证银行卡",
          specs: [
            { label: "vCPU", value: "0.5" },
            { label: "内存", value: "1 GB" },
            { label: "活跃 Agent", value: "1" },
          ],
          features: [
            "持久记忆",
            "包含全部集成",
            "适用公平使用限制",
          ],
          ctaLabel: "免费开始",
        },
        {
          name: "Pro",
          tagline: "适合正式工作，而不只是试验。",
          price: "$9.99",
          priceCadence: "/月",
          priceNote: "银行卡按月订阅",
          specs: [
            { label: "vCPU", value: "2" },
            { label: "内存", value: "4 GB" },
            {
              label: "并发 Agent",
              value: "3",
              tooltip:
                "同一时间能运行任务的 Agent 数量。档案数量不限，这里指实时执行上限。",
            },
          ],
          features: [
            "无限 Agent 档案",
            "包含 Free 的全部能力",
            "优先于免费层级",
          ],
          paymentPaths: [
            { label: "银行卡月付", detail: "$9.99/月" },
            { label: "按年", detail: "$79/年银行卡 · $49/年 $HermesOS" },
            { label: "持有 $HermesOS", detail: "约 $99（上线前 30 天启动价）" },
          ],
          ctaLabel: "获取 Pro",
        },
        {
          name: "Power",
          tagline: "适合更重的流程和多 Agent 协作。",
          price: "$19.99",
          priceCadence: "/月",
          priceNote: "银行卡按月订阅",
          specs: [
            { label: "vCPU", value: "4" },
            { label: "内存", value: "8 GB" },
            {
              label: "并发 Agent",
              value: "无限",
              tooltip:
                "只受算力池限制，可让多个 Agent 并行工作，平台不额外设置并发上限。",
            },
          ],
          features: [
            "无限 Agent 档案",
            "包含 Pro 的全部能力",
            "容量允许时可突发 CPU",
          ],
          paymentPaths: [
            { label: "银行卡月付", detail: "$19.99/月" },
            { label: "按年", detail: "$149/年银行卡 · $99/年 $HermesOS" },
            { label: "持有 $HermesOS", detail: "约 $199（上线前 30 天启动价）" },
          ],
          ctaLabel: "获取 Power",
        },
      ],
    },
    token: {
      eyebrow: "关于 $HermesOS",
      title: "平台的访问层。",
      body:
        "$HermesOS 可用于折扣订阅、持有获取访问资格，或在我们逐步推出 Agent 经济时参与交易。",
      secondary:
        "使用 Hivra 不强制需要代币；免费层级会继续开放，并在需要时做反滥用检查。如果你想更深入参与生态，持有 $HermesOS 会带来更灵活的支付和访问方式。",
      cta: "代币验证页面",
    },
    faq: {
      eyebrow: "常见问题",
      title: "直接回答。",
      items: [
        {
          q: "我的 API 密钥安全吗？",
          a: "安全。密钥静态加密，并在部署时通过环境变量注入。我们不会代理或记录你的 AI 请求。",
        },
        {
          q: "更新会弄坏我的设置吗？",
          a: "不会。每次更新发布前都会按容器配置测试。每日备份意味着最多 24 小时就能回到干净恢复点。",
        },
        {
          q: "这和 OpenClaw 有什么不同？",
          a:
            "OpenClaw 是优秀的开源桌面框架。Hivra 是完全托管的生产级云环境。Hermes Agent 的记忆更稳定、可靠性更高，更新不会破坏已有功能。",
        },
        {
          q: "如果我的 Agent 崩溃怎么办？",
          a: "它会自动重启。健康状态、日志和资源用量始终可以在控制台查看。",
        },
        {
          q: "一个计划能运行多个 Agent 吗？",
          a: "可以。每个实例可拥有无限档案。Free 可运行 1 个活跃 Agent，Pro 可运行 3 个，Power 没有并发上限。真正的限制是你的算力池。",
        },
        {
          q: "支持哪些 AI 提供商？",
          a: "支持 OpenRouter、OpenAI 和 Anthropic。仅 OpenRouter 一个密钥就可访问数百个模型。",
        },
        {
          q: "访问平台必须使用 $HermesOS 吗？",
          a: "不需要。免费层级不要求代币。Pro 和 Power 可用银行卡支付。代币提供折扣，也给想参与生态的人第三种支付路径。",
        },
        {
          q: "接下来会推出什么？",
          a: "Operator Packs（预置 Agent 模板）将在未来几周推出。之后会有 Marketplace、Agent Endpoints 和 Hive Mind。路线图在 hermesos.cloud/roadmap。",
        },
      ],
    },
    finalCta: {
      eyebrow: "现在开始",
      title: "准备部署了吗？",
      body: "免费层级已上线并带有反滥用保护。Pro 和 Power 现在也可使用。",
      primary: "免费开始",
      secondary: "查看价格",
      note: "大多数免费用户无需银行卡即可开始；风险较高的注册可能需要银行卡验证。",
      accountPrefix: "已经有账户？",
      accountLink: "登录",
    },
    getStarted: {
      loadingCheckout: "正在跳转到结账...",
      steps: {
        choosePlan: "选择计划",
        createAccount: "创建账户",
        activate: "激活",
        payment: "付款",
      },
      badges: {
        free: "始终免费",
        paid: "7 天退款保证",
      },
      yourPlan: "你的计划",
      perMonth: "/月",
      perYear: "/年",
      cadence: {
        monthly: "按月",
        yearly: "按年",
        saveLabel: "省约 {percent}%",
        saveDollarsLabel: "每年省约 ${dollars}",
      },
      marketAnchor: "同类智能体平台起价约 $19/月",
      mostPopular: "最受欢迎",
      freeGap: "无网页浏览 · 无持久记忆 · 无定时任务 · 0.5 vCPU",
      specs: {
        agents: "Agent",
        cpu: "CPU",
        ram: "内存",
      },
      guarantee: {
        free: "无需结账",
        paid: "7 天退款保证",
      },
      switchPlan: "切换计划",
      bestFit: "最佳适合",
      planGuidance: {
        free:
          "Free 适合用一个受保护的 Agent 先试用 Hermes。大多数用户无需银行卡即可启动；风险较高的免费部署可能需要先完成银行卡验证。",
        operator:
          "Pro 适合独立开发者、黑客松项目，以及想快速上线一个 Agent 的用户。",
        fleet:
          "Power 适合多 Agent 工作流、更重的浏览任务，以及希望立刻获得更多算力余量的团队。",
        command:
          "Command 适合最大工作负载、最快扩容路径，以及单次部署需要最大算力的场景。",
      },
      createAccountTitle: "创建你的账户。",
      createAccountIntroFree:
        "账户信息将成为你的登录凭据。注册后，我们会激活 Free 计划并直接带你进入部署。大多数用户无需银行卡即可启动；风险较高的免费部署可能需要先完成银行卡验证。",
      createAccountIntroPaid:
        "账户信息将成为你的登录凭据。注册后，你会继续进入安全结账流程，并受到 7 天退款保证保护。",
      legalPrefix: "继续即表示你同意我们的",
      terms: "服务条款",
      and: "和",
      privacy: "隐私政策",
    },
    dashboard: {
      nav: {
        chat: "聊天",
        commandCenter: "控制中心",
        home: "首页",
        computers: "电脑",
        agents: "智能体",
        infrastructure: "基础设施",
        collaboration: "协作",
        settings: "设置",
        launch: "启动",
        ops: "运维",
        promptLibrary: "提示词库",
        wallet: "钱包",
        billing: "账单",
      },
      sections: {
        advanced: "高级",
        support: "支持",
      },
      support: {
        discord: "Discord",
        xTwitter: "X（Twitter）",
        email: "邮件支持",
      },
      legal: {
        terms: "条款",
        privacy: "隐私",
      },
      controls: {
        expandSidebarTitle: "展开侧边栏",
        collapseSidebarTitle: "收起侧边栏",
        expandSidebarLabel: "展开控制台侧边栏",
        collapseSidebarLabel: "收起控制台侧边栏",
        globalSettings: "全局设置",
      },
      commandCenter: {
        phase: "第二阶段：舰队运营",
        titlePrefix: "指挥",
        titleSeparator: "",
        titleEmphasis: "中心",
        titleSuffix: "。",
        labelSeparator: "：",
        sections: {
          activeAgents: "活跃 Agent",
          activeCoreInstances: "活跃核心实例",
          infrastructureNodes: "基础设施节点",
        },
        actions: {
          advancedConsole: "高级控制台",
          applyChanges: "应用更改",
          applying: "正在应用...",
          cancel: "取消",
          confirmRemove: "确认移除",
          coreConsole: "核心控制台",
          initializeAgent: "初始化 Agent",
          manageAllocation: "管理分配",
          removeNode: "移除节点",
          removing: "正在移除...",
        },
        alerts: {
          activeFailureTitle: "有活跃故障需要处理",
          activeFailurePrefix: "Hermes 在",
          activeFailureSingular: "个实例上发现活跃故障。",
          activeFailurePlural: "个实例上发现活跃故障。",
          activeFailureSuffix: "每一项都会显示下一步由谁负责。",
          recoveryPrefix: "恢复方式",
          updateTitle: "更新需要处理",
          updateSummaryPrefix: "Hermes 在",
          updateSummarySingular: "个实例上发现更新问题。",
          updateSummaryPlural: "个实例上发现更新问题。",
          updateSummarySuffix: "挂载的 Docker 数据仍会保留，但这些 Agent 需要快速检查。",
          scheduledUpdateFailed: "上一次自动更新失败。Docker 卷仍会保留，但这个实例需要快速检查。",
          manualUpdateFailed: "上一次手动更新失败。Docker 卷仍会保留，但这个实例需要快速检查。",
        },
        status: {
          running: "运行中",
          provisioning: "配置中",
          stopped: "已停止",
          error: "错误",
          failed: "失败",
        },
        instance: {
          activeAgentSingular: "活跃 Agent",
          activeAgentPlural: "活跃 Agent",
          configuredInAgentSettings: "已在 Agent 设置中配置",
          coreSingular: "核心",
          corePlural: "核心",
          fetchingProfiles: "正在获取档案...",
          hostInstancePrefix: "主机实例",
          idPrefix: "ID",
          primaryAgent: "主 Agent",
          profileNode: "档案节点",
          secondaryAgent: "次级 Agent",
        },
        telemetry: {
          activeModel: "当前模型",
          containerState: "容器状态",
          cpuUtilization: "CPU 使用率",
          hostComputeNode: "主机计算节点",
          limitPrefix: "限制",
          llmInferenceEngine: "LLM 推理引擎",
          memoryAllocation: "内存分配",
          networkIo: "网络 I/O",
          provider: "提供商",
          providerPrefix: "提供商",
          totalTxPrefix: "总发送",
          unrestricted: "无限制",
          uptimePrefix: "运行时间",
        },
        allocation: {
          cpuAllocated: "已分配 CPU",
          cpuAllocation: "CPU 分配",
          cpuCapacityError: "CPU 总分配量（{allocated}）超过节点容量（{capacity}）。",
          dangerZone: "危险区域",
          deleteConfirmationPhrase: "确认删除",
          deletePromptPrefix: "输入",
          deletePromptSuffix: "以确认移除。这会永久销毁基础设施及其上任何离线 Agent。",
          failedToRemoveHost: "无法移除主机",
          memoryAllocated: "已分配内存",
          memoryAllocation: "内存（RAM）分配",
          memoryCapacityError: "内存总分配量（{allocated}GB）超过节点容量（{capacity}GB）。",
          noActiveAgents: "此节点上没有活跃 Agent。",
          nodeAllocationPrefix: "节点分配",
          projectedNodeUsage: "预计节点用量",
        },
        errors: {
          failedToLoadOperations: "无法加载运营数据",
        },
      },
      library: {
        returnToCommandCenter: "返回控制中心",
        titlePrefix: "提示词",
        titleSeparator: "",
        titleEmphasis: "库",
        titleSuffix: "。",
        intro: "部署经过实战验证的专用 Agent 模板和系统提示词。精选自高级 Agency 蓝图。",
        sourcePrefix: "模板来源于",
        sourceLinkLabel: "Michal Sitarzewski 的 Agency Agents",
        sourceSuffix: "。",
        searchPlaceholder: "按名称或描述搜索模板...",
        featured: "精选",
        allTemplates: "所有模板",
        viewPrompt: "查看提示词",
        deploy: "部署",
        empty: "没有找到符合条件的模板",
        copied: "已复制！",
        copyPrompt: "复制提示词",
        deployTemplate: "部署此模板",
        closePreview: "关闭提示词预览",
        categories: {
          All: "全部",
          Engineering: "工程",
          Design: "设计",
          Marketing: "营销",
          Product: "产品",
          Operations: "运营",
          Research: "研究",
          Security: "安全",
          Finance: "财务",
        },
      },
      wallet: {
        eyebrowLegacy: "钱包 · 存入与提现",
        eyebrowSelfCustody: "钱包 · 签名验证",
        titlePrefix: "你的",
        titleSeparator: " ",
        titleEmphasis: "$HermesOS",
        titleSuffix: " 钱包。",
        legacyIntroStrong: "原托管钱包",
        legacyIntroBody:
          "现有的存入和提现流程会继续可用。先锁定目标层级今天的 $HERMESOS 价格，再把报价金额发送到你的存入地址。免费层级始终无需存入即可使用。",
        selfCustodyIntroStrong: "连接你自己的钱包",
        selfCustodyIntroBody:
          "自行持有 $HermesOS 和 VVV，然后签名验证所有权。免费层级始终无需代币验证即可使用。",
        priceUnavailable: "代币价格暂不可用，请稍后重试。",
        buyToken: {
          ariaLabel: "购买 $HermesOS",
          eyebrow: "获取 $HermesOS",
          title: "在 Uniswap 购买（Base 网络）。",
          action: "在 Uniswap 购买 →",
          contractLabel: "合约地址（Base）",
          copyContractLabel: "复制合约地址",
          copied: "已复制",
          copy: "复制",
          warningPrefix: "转账前请始终在",
          warningLink: "hermesos.cloud/token",
          warningSuffix: "核对合约地址。不要相信私信、回复或截图中的地址。",
        },
        verification: {
          ariaLabel: "钱包验证",
          eyebrow: "自托管验证",
          connectedTitle: "钱包已连接。",
          disconnectedTitle: "从你的钱包验证。",
          activeWallet: "当前钱包",
          lastCheckedPrefix: "上次检查",
          connecting: "正在连接...",
          checking: "正在检查...",
          connectWallet: "连接钱包",
          changeWallet: "更换钱包",
          refreshBalance: "刷新余额",
          checkLock: "检查 {tier} 锁定",
          lockPrice: "锁定 {tier} 价格",
          lockedFor20: "{tier} 价格已锁定 20 分钟，数量为",
          holdAtLeastThatAmount: "请在锁定过期前在此钱包中至少持有该数量。",
          yourRateLockedAt: "你的 {tier} 资格已锁定在",
          lockNext: "如需该层级，请下一步锁定 {tier} 价格。",
          keepEligible: "继续在此钱包中持有该数量以保持资格。",
          detected: "检测到",
          snapshotInstruction: "锁定 {tier} 价格以保存 20 分钟的代币数量。",
          refreshInstruction: "刷新余额以确认当前层级。",
          connectedFootnote: "一次只能有一个活跃钱包。更换钱包会替换当前钱包；签名不会移动代币。",
          disconnectedBody: "把 $HermesOS 和 VVV 保存在你自己的 Base 钱包中。签名消息只证明所有权，不会把代币发送给 Hivra。",
          verifiedSuffix: "已验证。",
        },
        eligibility: {
          ariaLabel: "层级资格",
          eyebrow: "层级资格",
          currentBalancePrefix: "当前余额：",
          autoRefreshPrefix: "每 5 分钟自动刷新 · 上次检查",
          refreshBalanceLabel: "刷新余额",
          refresh: "刷新",
          thresholdsMissing: "层级门槛尚未配置。当前不会评估资格。存入流程上线后请再回来查看。",
          proTier: "Pro 层级",
          powerTier: "Power 层级",
          eligible: "符合资格",
          breached: "已跌破门槛，资格已结束",
          notYetEligible: "尚未符合资格",
          holdAtLeast: "至少持有",
          depositAtLeast: "至少存入",
          selfCustodyQualifySuffix: "在已验证钱包中，即可无需订阅获得 {tier} 层级资格。",
          custodyQualifySuffix: "即可无需订阅获得 {tier} 层级资格。",
          lockedAtPrice: "已按你报价时的价格锁定，报价过期后会刷新。",
        },
        agentWallets: {
          ariaLabel: "Agent 钱包",
          title: "Agent 钱包。",
          subtitle: "每个 Agent 一个钱包 · 你自己的 Bankr 账户 · 仅限 Base",
          emptyNoAgents: "启动一个 Agent，然后连接你自己的 Bankr 账户，为它配置钱包。",
          deployAgent: "部署 Agent",
          runningEmpty: "运行中的 Agent 会显示在这里。",
        },
      },
      billing: {
        eyebrow: "账单与订阅",
        titlePrefix: "计划",
        titleSeparator: "",
        titleEmphasis: "管理",
        titleSuffix: "。",
        subtitle: "你的计划、付款方式和用量。",
        refreshing: "正在刷新…",
        credits: {
          title: "积分余额",
          available: "可用",
          description: "账户积分用于支付用量，不决定你的计划：计划来自订阅、按年用 $HermesOS 付款或持有 $HermesOS。",
          monthlyGrantSuffix: "每月计划积分",
        },
        activity: {
          eyebrow: "账单动态",
          title: "最近账户变动",
          loading: "加载中",
          ledger: "账本",
          ledgerLoading: "正在加载账本...",
          ledgerEmpty: "暂无账本记录。",
          payments: "付款",
          paymentsLoading: "正在加载付款...",
          paymentsEmpty: "暂无付款记录。",
          compute: "计算",
          computeLoading: "正在加载计算用量...",
          computeEmpty: "暂无计算用量。",
          llm: "LLM",
          llmLoading: "正在加载 LLM 用量...",
          llmEmpty: "暂无 LLM 用量。",
        },
        tokenAccess: {
          eyebrow: "代币访问",
          title: "$HermesOS 持仓",
          description: "在已验证钱包中持有不少于最低数量的 $HermesOS，即可解锁一台基础机器。如果余额低于最低数量，该机器上的 Agent 会在宽限期内继续运行，之后暂停，直到你再次持有足够数量。",
          checking: "检查中",
          unavailable: "不可用",
          ready: "已达最低要求",
          belowMinimum: "低于最低要求",
          noWallet: "没有已验证钱包",
          wallet: "钱包",
          balance: "余额",
          minimum: "最低要求",
          notVerified: "未验证",
          noSnapshot: "暂无快照",
          refresh: "刷新代币状态",
          refreshing: "正在刷新...",
          connectWallet: "连接钱包",
          connecting: "正在连接...",
          verifyDifferent: "验证其他钱包",
        },
        cryptoCredits: {
          eyebrow: "加密货币积分",
          description: "选择金额后，我们会给你一个在 Base 上接收 USDC 的地址。转账确认后积分就会到账。",
          bonusPath: "奖励路径已准备",
          pendingDeposit: "等待存款",
          createTopUpLabel: "为 {credits} 积分创建 USDC 充值",
          sendPrefix: "发送",
          onNetwork: "到",
          reference: "参考编号",
        },
        activePlan: {
          title: "当前计划",
          heldViaTokens: "通过 $HERMESOS 持有",
          perMonth: "/月",
          agents: "Agent",
          cpuBudget: "CPU 预算",
          ramBudget: "内存预算",
          manageSubscription: "管理订阅",
          opening: "正在打开...",
        },
        switcher: {
          title: "切换计划",
          description: "可随时升级。暂不支持降级，因为专用服务器无法向下缩容。",
          currentPlan: "当前计划",
          upgrade: "升级",
          lowerTier: "较低层级",
          unlimited: "无限",
          agents: "个 Agent",
          active: "已启用",
          guarantee: "48 小时退款政策 · 仅支持升级",
        },
        noSubscription: {
          title: "没有有效订阅",
        },
        plate: {
          slots: "名额",
          vcpu: "vCPU",
          memory: "内存",
          idlePolicy: "闲置策略",
          alwaysOn: "始终运行",
          sleepsAfterIdle: "闲置 {days} 天后休眠",
        },
      },
      settings: {
        loading: "加载中...",
        returnToCommandCenter: "返回控制中心",
        titlePrefix: "全局",
        titleSeparator: "",
        titleEmphasis: "设置",
        titleSuffix: "。",
        intro: "配置你的工作区、界面主题和应用行为。",
        sections: {
          appearance: "外观",
          chatInterface: "聊天与 Agent 界面",
          capabilities: "能力与插件",
          dangerZone: "危险区域",
        },
        theme: {
          label: "主题",
          description: "浅色、深色，或跟随设备。",
          light: "浅色",
          dark: "深色",
          system: "系统",
        },
        language: {
          label: "网站语言",
          description: "选择 Hivra 使用的语言。",
        },
        reducedMotion: {
          label: "减少动态效果",
          description: "减少过渡和较重的界面动画。",
        },
        autoScroll: {
          label: "聊天自动滚动",
          description: "新消息到达时自动固定到底部。",
        },
        streamingAnimations: {
          label: "流式动画",
          description: "接收 Agent 流式输出时显示淡入的 Markdown 效果。",
        },
        aiReasoning: {
          label: "展开 AI 推理",
          description: "默认展开 AI 的“Thinking”区块。",
        },
        persistentMemory: {
          label: "启用持久记忆",
          description: "允许 Hermes 通过可插拔记忆提供器跨会话写入 MEMORY.md。",
        },
        plugins: {
          label: "启用可扩展插件 / 技能",
          description: "允许 Hermes 使用上游 MCP/ACP 技能和实验性工具。",
        },
        clearCache: {
          label: "清除本地缓存",
          description: "清除此浏览器中缓存的仪表板数据和保存在这里的布局选择（例如终端标签页），然后重新加载页面。你的账户、Agent 和电脑不受影响。",
          action: "清除缓存",
        },
        hub: {
          title: "设置",
          intro: "你的账户、账单、密钥和 Agent 工具，以及 Hivra 在此浏览器中的外观。",
          groups: {
            account: "账户",
            billing: "计划与账单",
            connections: "密钥与连接",
            toolkit: "Agent 工具箱",
            device: "此设备",
            apps: "应用与帮助",
            reset: "重置此浏览器",
          },
          profile: {
            title: "个人资料与登录",
            signedInAs: "已登录为 {email}",
            fallback: "你的姓名、邮箱、安全设置和退出登录。",
            selfHostTitle: "登录",
            selfHostFallback: "已登录此自托管的 Hivra。",
            signOut: "退出登录",
            signingOut: "正在退出…",
            signOutFailed: "无法退出登录，请重试。",
          },
          rows: {
            billing: { description: "计划、付款方式、额度和发票" },
            wallets: { title: "钱包", description: "Agent 钱包和 $HermesOS 访问权限" },
            apiKeys: { title: "API 密钥", description: "服务商密钥，以及使用它们的 Agent" },
            infrastructure: { description: "运行你的 Agent 的机器和云账户" },
            memory: { title: "共享 Agent 记忆", description: "每个新 Agent 一开始就知道的内容" },
            tools: { title: "工具与能力", description: "为你选择的 Agent 添加工具" },
            library: { title: "提示词库", description: "附带经过验证的提示词的现成 Agent 角色" },
            templates: { title: "模板", description: "保存已配置的 Agent，之后再次启动" },
            referral: { title: "邀请赚取", description: "分享你的链接，一起赚取额度" },
            applications: { title: "应用", description: "在浏览器中或作为网页应用使用 Hivra" },
            help: { title: "帮助", description: "支持、社区和法律信息" },
          },
          motionNote: "动态效果遵循设备的“减弱动态效果”设置。",
          clearCacheConfirm: "再按一次以清除并重新加载",
          clearCacheArmed: "请在 4 秒内再按一次该按钮，以清除缓存并重新加载。",
        },
      },
      userModeSuffix: "模式",
      versionLabel: "Foundation v0.9.0",
    },
    stats: {
      hero: {
        eyebrow: "实时 · 已部署 agent",
        label: "累计部署",
        fullStats: "完整数据 →",
      },
      page: {
        eyebrow: "实时计数器",
        headlinePrefix: "在 Hivra 上",
        headlineEmphasis: "已部署",
        headlineSuffix: "的 agent",
        body: "每当有人成功部署一个 agent，这个数字就会跳一下。",
        allTimeLabel: "累计成功部署",
        ariaTotal: "累计部署的 agent 数量",
        cards: {
          last24h: "过去 24 小时",
          last7d: "过去 7 天",
          firstDeploy: "首次部署",
        },
        sparkline: {
          titlePrefix: "每日部署，",
          titleEmphasis: "近 30 天",
          hint: "悬停或选中柱状条以查看具体数字",
          peak: "峰值日",
          total: "30 天总计",
          barLabel: "{date}：{count} 次部署",
        },
        cta: {
          button: "部署你的 agent →",
          subtitle: "免费层 — 1 个 agent，0.5 vCPU，1 GB 内存，始终在线",
        },
      },
    },
    footer: {
      links: {
        features: "功能",
        compare: "对比",
        blog: "博客",
        roadmap: "路线图",
        tokenVerification: "代币验证",
        privacy: "隐私",
        terms: "条款",
      },
    },
  },
} as const;

type WidenCopy<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? readonly WidenCopy<U>[]
        : T extends object
          ? { -readonly [K in keyof T]: WidenCopy<T[K]> }
          : T;

type BaseMarketingCopy = WidenCopy<typeof BASE_MARKETING_COPY.en>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly (infer U)[]
    ? readonly DeepPartial<U>[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

function mergeCopy<T>(base: T, overrides: DeepPartial<T>): T {
  if (Array.isArray(base) || Array.isArray(overrides)) {
    return (overrides ?? base) as T;
  }

  if (
    typeof base !== "object" ||
    base === null ||
    typeof overrides !== "object" ||
    overrides === null
  ) {
    return (overrides ?? base) as T;
  }

  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    const baseValue = (base as Record<string, unknown>)[key];
    merged[key] = mergeCopy(baseValue, value as DeepPartial<typeof baseValue>);
  }
  return merged as T;
}

const LOCALE_COPY_OVERRIDES = {
  "es": {
    "localeLabel": "Español",
    "languageSelectorLabel": "Idioma",
    "nav": {
      "pricing": "Precios",
      "roadmap": "Ruta",
      "tokenVerification": "Verificación de token",
      "register": "Registrarse",
      "login": "Iniciar sesión",
      "openDashboard": "Abrir panel",
      "mobileMenu": "Abrir menú",
      "closeMobileMenu": "Cerrar menú"
    },
    "hero": {
      "eyebrow": "Ya disponible",
      "headlinePrefix": "Tus agentes de IA,",
      "headlineEmphasis": "siempre activos.",
      "primary": "Hivra pone tu agente Hermes en marcha en menos de 5 minutos, con memoria persistente, automatización del navegador y uso de herramientas. Sin Docker, sin archivos de configuración y sin depuración a medianoche.",
      "secondary": "El plan gratuito ya está activo. Pro y Power están disponibles para cargas de trabajo serias. Paga con tarjeta o con $HermesOS.",
      "primaryCta": "Empezar gratis",
      "secondaryCta": "Ver cómo funciona",
      "proofPoints": [
        "Plan gratuito permanente",
        "Tu propia clave, sin recargo",
        "Basado en Hermes Agent"
      ]
    },
    "ticker": {
      "proofPoints": [
        "Construido sobre Hermes Agent (Nous Research)",
        "Tu propia clave, cero markup",
        "Tier gratuito siempre disponible"
      ]
    },
    "positioning": {
      "title": "OpenClaw olvida. Hermes acumula.",
      "body": "Creado por Nous Research, Hermes vive en un servidor y recuerda todo — proyectos, preferencias, lecciones aprendidas. Cada sesión lo hace más afilado. Montarlo por cuenta propia le toma a la mayoría un fin de semana.",
      "punchline": "Hivra reduce ese fin de semana a 5 minutos."
    },
    "features": {
      "eyebrow": "Qué incluye",
      "titlePrefix": "Todo lo que tu agente necesita.",
      "titleEmphasis": "Nada que no necesites.",
      "items": [
        {
          "headline": "Cero configuración. Stack completo.",
          "body": "Automatización de navegador, uso de herramientas, terminal, memoria y cron — preconfigurados. Sin Docker, sin StackOverflow a medianoche."
        },
        {
          "headline": "Multi-agente desde el día uno.",
          "body": "Perfiles de agente ilimitados en una sola instancia. Investigadores, operadores, especialistas — sin costo adicional por agente."
        },
        {
          "headline": "Tu clave. Cero markup.",
          "body": "OpenRouter, OpenAI o Anthropic. Cifrada en reposo, inyectada al desplegar. Nunca vemos tu gasto en IA."
        },
        {
          "headline": "Chatea desde cualquier lugar.",
          "body": "Dashboard integrado con streaming. Conecta Telegram, Discord, Slack o WhatsApp — sin configuración adicional."
        },
        {
          "headline": "Migración desde OpenClaw incluida.",
          "body": "Tu configuración, prompts y habilidades actuales se transfieren intactos. Sin empezar desde cero."
        },
        {
          "headline": "Estable. Recuperable. Siempre activo.",
          "body": "Actualizaciones probadas contra tu configuración antes del despliegue. Reinicio automático ante fallos. Respaldos diarios — nunca a más de 24 horas de una restauración limpia."
        }
      ]
    },
    "howItWorks": {
      "eyebrow": "Cómo funciona",
      "titlePrefix": "Tres pasos.",
      "titleEmphasis": "Sin terminal requerida.",
      "steps": [
        {
          "step": "1",
          "headline": "Elige tu tier",
          "body": "Empieza gratis, sube de plan cuando necesites más. Paga mensual con tarjeta, anual con descuento, o mantén $HermesOS para conservar el acceso sin suscripción."
        },
        {
          "step": "2",
          "headline": "Agrega tu clave de IA",
          "body": "Pega tu clave de OpenRouter, OpenAI o Anthropic una sola vez. Cifrada, inyectada, listo."
        },
        {
          "step": "3",
          "headline": "Despliega. Habla. Automatiza.",
          "body": "Tu agente está activo en minutos — chat, terminal, monitoreo. Conecta Telegram o Discord y te sigue a todas partes."
        }
      ],
      "footer": "¿Listo para pasar de leer a configurar? Elige tu tier y ve directo a crear tu cuenta.",
      "cta": "Elige Tu Tier"
    },
    "useCases": {
      "eyebrow": "Casos de uso",
      "titlePrefix": "¿Qué hace un agente 24/7",
      "titleEmphasis": "con memoria, en la práctica?",
      "intro": "Navega, escribe código, gestiona archivos, llama APIs, ejecuta tareas cron — de forma autónoma. Y recuerda lo que aprendió la semana pasada.",
      "items": [
        {
          "headline": "DevOps y Monitoreo",
          "body": "Lee logs, reinicia servicios con fallos, te avisa solo cuando se necesita un humano. Recuerda tu stack."
        },
        {
          "headline": "Investigación e Inteligencia Competitiva",
          "body": "Dale un tema y una fecha límite. Navega, agrega y entrega un brief estructurado — y guarda lo que aprendió para la próxima vez."
        },
        {
          "headline": "Automatización en segundo plano",
          "body": "Triaje de email, agendamiento, llamadas API, hojas de cálculo — todo lo repetitivo. Corre en cron mientras duermes."
        },
        {
          "headline": "Triaje de Soporte al Cliente",
          "body": "Dale tus docs. Resuelve tickets comunes, escala los difíciles, y mejora con cada conversación."
        }
      ],
      "footer": "¿Ya viste el tipo de trabajo que Hermes puede quitarte de encima? Elige un plan y lanza el flujo que se ajusta a tu carga.",
      "cta": "Ver Planes y Lanzar"
    },
    "whatsComing": {
      "eyebrow": "Próximamente",
      "titlePrefix": "Esto es solo",
      "titleEmphasis": "el comienzo.",
      "intro": "El hosting es la base. Próximamente:",
      "items": [
        {
          "title": "Operator Packs",
          "body": "Plantillas de agente preconfiguradas para tareas específicas — investigación, inteligencia de trading, automatización de contenido. Despliega en un clic."
        },
        {
          "title": "Marketplace",
          "body": "Crea operator packs, publícalos a la comunidad y gana por su uso. Liquidado en $HermesOS."
        },
        {
          "title": "Agent Endpoints",
          "body": "Expón tu agente como una API invocable. Otros agentes te pagan por solicitud."
        },
        {
          "title": "Hive Mind",
          "body": "Los agentes comparten lo que aprenden. Toda la red se vuelve más inteligente en conjunto."
        }
      ],
      "footer": "Hivra es la infraestructura para una economía de agentes. El hosting es el paso uno. Todo lo demás se construye encima."
    },
    "pricing": {
      "eyebrow": "Precios",
      "titlePrefix": "Planes simples.",
      "titleEmphasis": "Cómputo serio.",
      "intro": "Cómputo dedicado. Perfiles de agente ilimitados. Tu propia clave, cero markup.",
      "compute": "Cómputo",
      "mostPopular": "Más Popular",
      "forPros": "Para Pros",
      "getStarted": "Comenzar",
      "recommended": "Recomendado",
      "accessPrefix": "Tres formas de acceder",
      "footnote": "Ahorra hasta un 40% pagando con $HermesOS. Precios de lanzamiento para la primera ola — las tarifas pueden ajustarse conforme la plataforma madure.",
      "guarantee": "Tier gratuito — prueba antes de actualizar · Reembolso de 48 h en pagos con tarjeta",
      "tiers": [
        {
          "name": "Free",
          "tagline": "La mayoría puede lanzarse sin tarjeta; los despliegues del tier gratuito con mayor riesgo pueden requerir verificación con tarjeta primero.",
          "price": "$0",
          "priceNote": "Siempre gratis; tarjeta solo si lo exigen las verificaciones de riesgo",
          "specs": [
            {
              "label": "vCPU",
              "value": "0.5"
            },
            {
              "label": "RAM",
              "value": "1 GB"
            },
            {
              "label": "Agentes activos",
              "value": "1"
            }
          ],
          "features": [
            "Memoria persistente",
            "Todas las integraciones incluidas",
            "Se aplican límites de uso justo"
          ],
          "ctaLabel": "Empezar Gratis"
        },
        {
          "name": "Pro",
          "tagline": "Para trabajo real, no solo experimentos.",
          "price": "$9.99",
          "priceCadence": "/mes",
          "priceNote": "Suscripción mensual con tarjeta",
          "specs": [
            {
              "label": "vCPU",
              "value": "2"
            },
            {
              "label": "RAM",
              "value": "4 GB"
            },
            {
              "label": "Agentes simultáneos",
              "value": "3",
              "tooltip": "Cuántos de tus agentes pueden ejecutar tareas al mismo tiempo. Los perfiles son ilimitados — este es el límite de ejecución en vivo."
            }
          ],
          "features": [
            "Perfiles de agente ilimitados",
            "Todo lo del plan Free",
            "Prioridad sobre el tier gratuito"
          ],
          "paymentPaths": [
            {
              "label": "Tarjeta mensual",
              "detail": "$9.99/mo"
            },
            {
              "label": "Anual",
              "detail": "$79/yr con tarjeta · $49/yr en $HermesOS"
            },
            {
              "label": "Mantener $HermesOS",
              "detail": "~$99 (precio de lanzamiento, primeros 30 días)"
            }
          ],
          "ctaLabel": "Obtener Pro"
        },
        {
          "name": "Power",
          "tagline": "Para flujos de trabajo serios y operaciones multi-agente.",
          "price": "$19.99",
          "priceCadence": "/mes",
          "priceNote": "Suscripción mensual con tarjeta",
          "specs": [
            {
              "label": "vCPU",
              "value": "4"
            },
            {
              "label": "RAM",
              "value": "8 GB"
            },
            {
              "label": "Agentes simultáneos",
              "value": "Ilimitado",
              "tooltip": "Ejecuta tantos agentes simultáneamente como soporte tu pool de cómputo — múltiples agentes trabajando tareas en paralelo, sin límite impuesto por la plataforma."
            }
          ],
          "features": [
            "Perfiles de agente ilimitados",
            "Todo lo del plan Pro",
            "CPU en ráfaga cuando la capacidad lo permite"
          ],
          "paymentPaths": [
            {
              "label": "Tarjeta mensual",
              "detail": "$19.99/mo"
            },
            {
              "label": "Anual",
              "detail": "$149/yr con tarjeta · $99/yr en $HermesOS"
            },
            {
              "label": "Mantener $HermesOS",
              "detail": "~$199 (precio de lanzamiento, primeros 30 días)"
            }
          ],
          "ctaLabel": "Obtener Power"
        }
      ]
    },
    "token": {
      "eyebrow": "Sobre $HermesOS",
      "title": "La capa de acceso a la plataforma.",
      "body": "$HermesOS te permite pagar suscripciones con descuento, mantenerlo para conservar tu tier sin pagar mensualmente, o transaccionar dentro de la economía de agentes a medida que la desarrollamos.",
      "secondary": "El token no es obligatorio para usar Hivra — el tier gratuito sigue disponible sin él, con controles anti-abuso donde sea necesario. Si quieres integrarte más profundo en el ecosistema, mantener $HermesOS desbloquea más flexibilidad en cómo pagas y accedes.",
      "cta": "Página de verificación del token"
    },
    "faq": {
      "eyebrow": "Preguntas frecuentes",
      "title": "Respuestas directas.",
      "items": [
        {
          "q": "¿Mi clave API está segura?",
          "a": "Sí. Cifrada en reposo, inyectada al desplegar mediante variables de entorno. Nunca hacemos proxy ni registramos tus solicitudes de IA."
        },
        {
          "q": "¿Las actualizaciones pueden romper mi configuración?",
          "a": "No. Cada actualización se prueba contra las configuraciones de contenedor antes de enviarse. Los respaldos diarios garantizan que nunca estés a más de 24 horas de una restauración limpia."
        },
        {
          "q": "¿En qué se diferencia de OpenClaw?",
          "a": "OpenClaw es un excelente framework de escritorio open-source. Hivra es un entorno cloud completamente gestionado y listo para producción. Hermes Agent tiene memoria más estable, mayor confiabilidad y actualizaciones que no rompen tus funciones existentes."
        },
        {
          "q": "¿Qué pasa si mi agente falla?",
          "a": "Se reinicia automáticamente. El estado, los logs y el uso de recursos siempre son visibles en el dashboard."
        },
        {
          "q": "¿Puedo correr múltiples agentes con un solo plan?",
          "a": "Sí — perfiles ilimitados por instancia. Free corre 1 agente activo, Pro corre 3, Power no tiene límite de simultáneos. Tu pool de cómputo es el único límite real."
        },
        {
          "q": "¿Qué proveedores de IA son compatibles?",
          "a": "OpenRouter, OpenAI y Anthropic. Solo OpenRouter te da acceso a cientos de modelos con una sola clave."
        },
        {
          "q": "¿Necesito usar $HermesOS para acceder a la plataforma?",
          "a": "No. El tier gratuito no lo requiere. Pro y Power se pueden pagar con tarjeta. El token te da descuentos y una tercera vía de pago para quienes la quieran."
        },
        {
          "q": "¿Qué viene después?",
          "a": "Los operator packs (plantillas de agente preconfiguradas) se publican en las próximas semanas. Marketplace, agent endpoints y Hive Mind vienen a continuación. El roadmap está en hermesos.cloud/roadmap."
        }
      ]
    },
    "finalCta": {
      "eyebrow": "Empieza ahora",
      "title": "¿Listo para desplegar?",
      "body": "El tier gratuito está activo con salvaguardas contra abuso. Pro y Power disponibles ahora.",
      "primary": "Empezar Gratis",
      "secondary": "Ver Precios",
      "note": "La mayoría de usuarios gratuitos puede empezar sin tarjeta; los registros de mayor riesgo pueden requerir una tarjeta en archivo.",
      "accountPrefix": "¿Ya tienes una cuenta?",
      "accountLink": "Inicia sesión"
    },
    "getStarted": {
      "loadingCheckout": "Redirigiendo al pago...",
      "steps": {
        "choosePlan": "Elige plan",
        "createAccount": "Crear cuenta",
        "activate": "Activar",
        "payment": "Pago"
      },
      "badges": {
        "free": "Siempre gratis",
        "paid": "Garantía de devolución de 7 días"
      },
      "yourPlan": "Tu plan",
      "perMonth": "/mes",
      "perYear": "/año",
      "cadence": {
        "monthly": "Mensual",
        "yearly": "Anual",
        "saveLabel": "ahorra ~{percent}%",
        "saveDollarsLabel": "Ahorra ~${dollars}/año"
      },
      "marketAnchor": "Plataformas de agentes comparables cuestan desde unos $19/mes",
      "mostPopular": "Más popular",
      "freeGap": "Sin navegación web · sin memoria persistente · sin tareas programadas · 0.5 vCPU",
      "specs": {
        "agents": "Agentes",
        "cpu": "CPU",
        "ram": "RAM"
      },
      "guarantee": {
        "free": "No requiere pago",
        "paid": "Garantía de devolución de 7 días"
      },
      "switchPlan": "Cambiar plan",
      "bestFit": "Mejor opción",
      "planGuidance": {
        "free": "Free es ideal para probar Hermes con un agente protegido. La mayoría puede lanzarse sin tarjeta; los despliegues del tier gratuito con mayor riesgo pueden requerir verificación con tarjeta primero.",
        "operator": "Pro es ideal para builders en solitario, proyectos de hackathon y poner en marcha un agente rápidamente.",
        "fleet": "Power es ideal para flujos multi-agente, navegación más intensa y equipos que quieren más capacidad de cómputo de inmediato.",
        "command": "Command es ideal para las cargas de trabajo más grandes, el camino de escalado más rápido y el máximo cómputo por despliegue."
      },
      "createAccountTitle": "Crea tu cuenta.",
      "createAccountIntroFree": "Los datos de tu cuenta se convierten en tus credenciales de acceso. Tras el registro, activaremos tu plan Free y te llevaremos directo al despliegue. La mayoría puede lanzarse sin tarjeta; los despliegues del tier gratuito con mayor riesgo pueden requerir verificación con tarjeta primero.",
      "createAccountIntroPaid": "Los datos de tu cuenta se convierten en tus credenciales de acceso. Tras el registro, continuarás al checkout seguro. Protegido por nuestra garantía de devolución de 7 días.",
      "legalPrefix": "Al continuar, aceptas nuestros",
      "terms": "Términos de servicio",
      "and": "y",
      "privacy": "Política de privacidad"
    },
    "dashboard": {
      "nav": {
        "chat": "Chat",
        "commandCenter": "Centro de comando",
        "home": "Inicio",
        "computers": "Ordenadores",
        "agents": "Agentes",
        "infrastructure": "Infraestructura",
        "collaboration": "Colaboración",
        "settings": "Configuración",
        "launch": "Lanzar",
        "ops": "Operaciones",
        "promptLibrary": "Biblioteca de prompts",
        "wallet": "Billetera",
        "billing": "Facturación"
      },
      "sections": {
        "advanced": "Avanzado",
        "support": "Soporte"
      },
      "support": {
        "discord": "Discord",
        "xTwitter": "X (Twitter)",
        "email": "Soporte por email"
      },
      "legal": {
        "terms": "Términos",
        "privacy": "Privacidad"
      },
      "controls": {
        "expandSidebarTitle": "Expandir barra lateral",
        "collapseSidebarTitle": "Contraer barra lateral",
        "expandSidebarLabel": "Expandir barra lateral del panel",
        "collapseSidebarLabel": "Contraer barra lateral del panel",
        "globalSettings": "Configuración global"
      },
      "commandCenter": {
        "phase": "Fase II: Operaciones de Flota",
        "titlePrefix": "Centro de",
        "titleSeparator": " ",
        "titleEmphasis": "Comando",
        "titleSuffix": ".",
        "labelSeparator": ": ",
        "sections": {
          "activeAgents": "Agentes Activos",
          "activeCoreInstances": "Instancias Core Activas",
          "infrastructureNodes": "Nodos de Infraestructura"
        },
        "actions": {
          "advancedConsole": "Consola Avanzada",
          "applyChanges": "Aplicar Cambios",
          "applying": "Aplicando...",
          "cancel": "Cancelar",
          "confirmRemove": "Confirmar Eliminación",
          "coreConsole": "Consola Core",
          "initializeAgent": "Inicializar Agente",
          "manageAllocation": "Gestionar Asignación",
          "removeNode": "Eliminar Nodo",
          "removing": "Eliminando..."
        },
        "alerts": {
          "activeFailureTitle": "Fallo activo requiere atención",
          "activeFailurePrefix": "Hermes encontró un fallo activo en",
          "activeFailureSingular": "instancia",
          "activeFailurePlural": "instancias",
          "activeFailureSuffix": "Cada elemento ahora muestra quién tiene el siguiente paso.",
          "recoveryPrefix": "Recuperación",
          "updateTitle": "Atención requerida en actualización",
          "updateSummaryPrefix": "Hermes detectó un problema de actualización en",
          "updateSummarySingular": "instancia",
          "updateSummaryPlural": "instancias",
          "updateSummarySuffix": "Tus datos Docker montados permanecen intactos, pero estos agentes necesitan una revisión rápida.",
          "scheduledUpdateFailed": "La última actualización automática falló. Tus volúmenes Docker siguen montados, pero esta instancia necesita una revisión rápida.",
          "manualUpdateFailed": "La última actualización manual falló. Tus volúmenes Docker siguen montados, pero esta instancia necesita una revisión rápida."
        },
        "status": {
          "running": "en ejecución",
          "provisioning": "aprovisionando",
          "stopped": "detenido",
          "error": "error",
          "failed": "fallido"
        },
        "instance": {
          "activeAgentSingular": "Agente Activo",
          "activeAgentPlural": "Agentes Activos",
          "configuredInAgentSettings": "Configurado en ajustes del agente",
          "coreSingular": "Núcleo",
          "corePlural": "Núcleos",
          "fetchingProfiles": "Cargando Perfiles...",
          "hostInstancePrefix": "Instancia Host",
          "idPrefix": "ID",
          "primaryAgent": "Agente Primario",
          "profileNode": "Nodo de Perfil",
          "secondaryAgent": "Agente Secundario"
        },
        "telemetry": {
          "activeModel": "Modelo Activo",
          "containerState": "Estado del Contenedor",
          "cpuUtilization": "Utilización de CPU",
          "hostComputeNode": "Nodo de cómputo host",
          "limitPrefix": "Límite",
          "llmInferenceEngine": "Motor de inferencia LLM",
          "memoryAllocation": "Asignación de Memoria",
          "networkIo": "E/S de Red",
          "provider": "Proveedor",
          "providerPrefix": "Proveedor",
          "totalTxPrefix": "Tx Total",
          "unrestricted": "SIN RESTRICCIONES",
          "uptimePrefix": "Tiempo activo"
        },
        "allocation": {
          "cpuAllocated": "CPU Asignado",
          "cpuAllocation": "Asignación de CPU",
          "cpuCapacityError": "La asignación total de CPU ({allocated}) supera la capacidad del nodo ({capacity}).",
          "dangerZone": "Zona de Peligro",
          "deleteConfirmationPhrase": "eliminar",
          "deletePromptPrefix": "Escribe",
          "deletePromptSuffix": "para confirmar la eliminación. Esto destruirá permanentemente la infraestructura y los agentes sin conexión en ella.",
          "failedToRemoveHost": "Error al eliminar el host",
          "memoryAllocated": "Memoria Asignada",
          "memoryAllocation": "Asignación de Memoria (RAM)",
          "memoryCapacityError": "La asignación total de memoria ({allocated}GB) supera la capacidad del nodo ({capacity}GB).",
          "noActiveAgents": "Sin agentes activos en este nodo.",
          "nodeAllocationPrefix": "Asignación del Nodo",
          "projectedNodeUsage": "Uso Proyectado del Nodo"
        },
        "errors": {
          "failedToLoadOperations": "Error al cargar datos de operaciones"
        }
      },
      "library": {
        "returnToCommandCenter": "Volver al centro de comando",
        "titlePrefix": "Biblioteca",
        "titleSeparator": " de ",
        "titleEmphasis": "prompts",
        "titleSuffix": ".",
        "intro": "Despliega plantillas de agentes especializadas con prompts de sistema probados en producción. Curadas desde el blueprint premium Agency.",
        "sourcePrefix": "Plantillas cortesía de",
        "sourceLinkLabel": "Agency Agents de Michal Sitarzewski",
        "sourceSuffix": ".",
        "searchPlaceholder": "Buscar plantillas por nombre o descripción...",
        "featured": "Destacadas",
        "allTemplates": "Todas las plantillas",
        "viewPrompt": "Ver prompt",
        "deploy": "Desplegar",
        "empty": "No se encontraron plantillas que coincidan",
        "copied": "¡Copiado!",
        "copyPrompt": "Copiar prompt",
        "deployTemplate": "Desplegar esta plantilla",
        "closePreview": "Cerrar vista previa del prompt",
        "categories": {
          "All": "Todo",
          "Engineering": "Ingeniería",
          "Design": "Diseño",
          "Marketing": "Marketing",
          "Product": "Producto",
          "Operations": "Operaciones",
          "Research": "Investigación",
          "Security": "Seguridad",
          "Finance": "Finanzas"
        }
      },
      "wallet": {
        "eyebrowLegacy": "Billetera · Depósitos y retiros",
        "eyebrowSelfCustody": "Billetera · Verificación con firma",
        "titlePrefix": "Tu",
        "titleSeparator": " ",
        "titleEmphasis": "$HermesOS",
        "titleSuffix": ".",
        "legacyIntroStrong": "Wallet de custodia heredada",
        "legacyIntroBody": "tu flujo actual de depósito y retiro sigue activo. Fija el precio de hoy de $HERMESOS para el tier que quieres, luego envía el monto cotizado a tu dirección de depósito. El tier gratuito siempre funciona sin depósito.",
        "selfCustodyIntroStrong": "Conecta tu propia billetera",
        "selfCustodyIntroBody": "mantén $HermesOS y VVV tú mismo, luego firma un mensaje para verificar la propiedad. El plan gratuito siempre funciona sin verificación de token.",
        "priceUnavailable": "El precio del token no está disponible. Inténtalo de nuevo más tarde.",
        "buyToken": {
          "ariaLabel": "Comprar $HermesOS",
          "eyebrow": "Obtener $HermesOS",
          "title": "Comprar en Uniswap (red Base).",
          "action": "Comprar en Uniswap →",
          "contractLabel": "Dirección del contrato (Base)",
          "copyContractLabel": "Copiar dirección del contrato",
          "copied": "Copiado",
          "copy": "Copiar",
          "warningPrefix": "Verifica siempre la dirección del contrato en",
          "warningLink": "hermesos.cloud/token",
          "warningSuffix": "antes de enviar fondos. Ignora direcciones copiadas de mensajes, respuestas o capturas."
        },
        "verification": {
          "ariaLabel": "Verificación de billetera",
          "eyebrow": "Verificación de autocustodia",
          "connectedTitle": "Billetera conectada.",
          "disconnectedTitle": "Verifica desde tu billetera.",
          "activeWallet": "Billetera activa",
          "lastCheckedPrefix": "Última verificación",
          "connecting": "Conectando...",
          "checking": "Comprobando...",
          "connectWallet": "Conectar billetera",
          "changeWallet": "Cambiar billetera",
          "refreshBalance": "Actualizar saldo",
          "checkLock": "Comprobar bloqueo {tier}",
          "lockPrice": "Bloquear precio {tier}",
          "lockedFor20": "Precio de {tier} fijado por 20 minutos a",
          "holdAtLeastThatAmount": "Mantén al menos esa cantidad en esta billetera antes de que expire el bloqueo.",
          "yourRateLockedAt": "Tu tarifa de {tier} está fijada a",
          "lockNext": "Fija el precio de {tier} si quieres ese tier.",
          "keepEligible": "Mantén esa cantidad en esta wallet para seguir siendo elegible.",
          "detected": "Detectado",
          "snapshotInstruction": "Fija el precio de {tier} para tomar una instantánea del monto de tokens por 20 minutos.",
          "refreshInstruction": "Actualiza el saldo para confirmar tu nivel actual.",
          "connectedFootnote": "Solo puede haber una billetera activa a la vez. Cambiarla reemplaza la billetera activa; las firmas no mueven tokens.",
          "disconnectedBody": "Mantén $HermesOS y VVV en tu propia billetera Base. Un mensaje firmado prueba la propiedad sin enviar tokens a Hivra.",
          "verifiedSuffix": "verificada."
        },
        "eligibility": {
          "ariaLabel": "Elegibilidad de nivel",
          "eyebrow": "Elegibilidad de nivel",
          "currentBalancePrefix": "Saldo actual:",
          "autoRefreshPrefix": "Se actualiza cada 5 min · última verificación",
          "refreshBalanceLabel": "Actualizar saldo",
          "refresh": "Actualizar",
          "thresholdsMissing": "Los umbrales del tier aún no están configurados. La elegibilidad no está siendo evaluada. Vuelve cuando el flujo de depósito esté activo.",
          "proTier": "Nivel Pro",
          "powerTier": "Nivel Power",
          "eligible": "Elegible",
          "breached": "Incumplido — elegibilidad finalizada",
          "notYetEligible": "Aún no elegible",
          "holdAtLeast": "Mantén al menos",
          "depositAtLeast": "Deposita al menos",
          "selfCustodyQualifySuffix": "en tu wallet verificada para calificar al tier {tier} sin suscripción.",
          "custodyQualifySuffix": "para calificar al tier {tier} sin suscripción.",
          "lockedAtPrice": "Fijado al precio cotizado — se actualiza cuando expire la cotización."
        },
        "agentWallets": {
          "ariaLabel": "Billeteras de agentes",
          "title": "Billeteras de agentes.",
          "subtitle": "Una billetera por agente · Tu propia cuenta de Bankr · Solo Base",
          "emptyNoAgents": "Inicia un agente y conecta tu propia cuenta de Bankr para darle una billetera.",
          "deployAgent": "Desplegar agente",
          "runningEmpty": "Los agentes en ejecución aparecerán aquí."
        }
      },
      "billing": {
        "eyebrow": "Facturación y suscripción",
        "titlePrefix": "Gestión",
        "titleSeparator": " de ",
        "titleEmphasis": "plan",
        "titleSuffix": ".",
        "subtitle": "Tu plan, cómo pagas y lo que has usado.",
        "refreshing": "Actualizando…",
        "credits": {
          "title": "Saldo de créditos",
          "available": "disponibles",
          "description": "Los créditos de la cuenta pagan el uso. No definen tu plan: eso viene de una suscripción, un pago anual con $HermesOS o de tener $HermesOS.",
          "monthlyGrantSuffix": "créditos mensuales del plan"
        },
        "activity": {
          "eyebrow": "Actividad de facturación",
          "title": "Movimientos recientes de la cuenta",
          "loading": "Cargando",
          "ledger": "Libro",
          "ledgerLoading": "Cargando ledger...",
          "ledgerEmpty": "Aún no hay entradas en el ledger.",
          "payments": "Pagos",
          "paymentsLoading": "Cargando pagos...",
          "paymentsEmpty": "Aún no hay pagos.",
          "compute": "Cómputo",
          "computeLoading": "Cargando cómputo...",
          "computeEmpty": "Aún no hay uso de cómputo.",
          "llm": "LLM",
          "llmLoading": "Cargando LLM...",
          "llmEmpty": "Aún no hay uso de LLM."
        },
        "tokenAccess": {
          "eyebrow": "Acceso por token",
          "title": "Tenencia de $HermesOS",
          "description": "Mantén al menos el mínimo de $HermesOS en una billetera verificada para desbloquear una máquina básica. Si tu saldo baja del mínimo, los agentes de esa máquina siguen funcionando durante un periodo de gracia y luego se pausan hasta que vuelvas a tener suficiente.",
          "checking": "Verificando",
          "unavailable": "No disponible",
          "ready": "Mínimo alcanzado",
          "belowMinimum": "Por debajo del mínimo",
          "noWallet": "Sin billetera verificada",
          "wallet": "Billetera",
          "balance": "Saldo",
          "minimum": "Mínimo",
          "notVerified": "No verificado",
          "noSnapshot": "Sin instantánea",
          "refresh": "Actualizar estado del token",
          "refreshing": "Actualizando...",
          "connectWallet": "Conectar billetera",
          "connecting": "Conectando...",
          "verifyDifferent": "Verificar Otra Wallet"
        },
        "cryptoCredits": {
          "eyebrow": "Créditos cripto",
          "description": "Elige una cantidad y te daremos una dirección a la que enviar USDC en Base. Los créditos se añaden cuando se confirma la transferencia.",
          "bonusPath": "Ruta bonus preparada",
          "pendingDeposit": "Depósito pendiente",
          "createTopUpLabel": "Crear recarga USDC por {credits} créditos",
          "sendPrefix": "Envía",
          "onNetwork": "en",
          "reference": "Referencia"
        },
        "activePlan": {
          "title": "Plan actual",
          "heldViaTokens": "MANTENIDO CON $HERMESOS",
          "perMonth": "/mes",
          "agents": "Agentes",
          "cpuBudget": "Presupuesto CPU",
          "ramBudget": "Presupuesto RAM",
          "manageSubscription": "Gestionar suscripción",
          "opening": "Abriendo..."
        },
        "switcher": {
          "title": "Cambiar plan",
          "description": "Actualiza cuando quieras. Las bajadas no están disponibles: los servidores dedicados no se pueden reducir.",
          "currentPlan": "Plan actual",
          "upgrade": "Actualizar",
          "lowerTier": "Nivel inferior",
          "unlimited": "Ilimitado",
          "agents": "agentes",
          "active": "Activo",
          "guarantee": "Política de reembolso de 48 horas · Solo actualizaciones"
        },
        "noSubscription": {
          "title": "Sin suscripción activa"
        },
        "plate": {
          "slots": "Espacios",
          "vcpu": "vCPU",
          "memory": "Memoria",
          "idlePolicy": "Inactividad",
          "alwaysOn": "Siempre encendido",
          "sleepsAfterIdle": "Se suspende tras {days} días sin actividad"
        }
      },
      "settings": {
        "loading": "Cargando...",
        "returnToCommandCenter": "Volver al centro de comando",
        "titlePrefix": "Configuración",
        "titleSeparator": " ",
        "titleEmphasis": "global",
        "titleSuffix": ".",
        "intro": "Configura tu espacio de trabajo, temas de interfaz y comportamiento de la aplicación.",
        "sections": {
          "appearance": "Apariencia",
          "chatInterface": "Chat e interfaz del agente",
          "capabilities": "Capacidades y plugins",
          "dangerZone": "Zona peligrosa"
        },
        "theme": {
          "label": "Tema",
          "description": "Claro, oscuro o igual que tu dispositivo.",
          "light": "Claro",
          "dark": "Oscuro",
          "system": "Sistema"
        },
        "language": {
          "label": "Idioma del sitio",
          "description": "Elige el idioma usado en Hivra."
        },
        "reducedMotion": {
          "label": "Reducir movimiento",
          "description": "Minimiza transiciones y animaciones pesadas."
        },
        "autoScroll": {
          "label": "Auto-scroll del chat",
          "description": "Fija abajo automáticamente cuando llegan mensajes."
        },
        "streamingAnimations": {
          "label": "Animaciones de streaming",
          "description": "Muestra efectos de aparición al recibir streams."
        },
        "aiReasoning": {
          "label": "Expandir razonamiento IA",
          "description": "Empieza con el bloque “Thinking” expandido."
        },
        "persistentMemory": {
          "label": "Activar memoria persistente",
          "description": "Permite que Hermes escriba MEMORY.md entre sesiones."
        },
        "plugins": {
          "label": "Activar plugins / skills",
          "description": "Da acceso a skills MCP/ACP y herramientas experimentales."
        },
        "clearCache": {
          "label": "Borrar la caché local",
          "description": "Borra los datos del panel en caché de este navegador y las opciones de diseño guardadas aquí, como las pestañas del terminal, y recarga la página. Tu cuenta, tus agentes y tus ordenadores no se ven afectados.",
          "action": "Borrar caché"
        },
        "hub": {
          "title": "Configuración",
          "intro": "Tu cuenta, facturación, claves y herramientas de agentes, además de cómo se ve Hivra en este navegador.",
          "groups": {
            "account": "Cuenta",
            "billing": "Plan y facturación",
            "connections": "Claves y conexiones",
            "toolkit": "Herramientas de agentes",
            "device": "En este dispositivo",
            "apps": "Apps y ayuda",
            "reset": "Restablecer este navegador"
          },
          "profile": {
            "title": "Perfil e inicio de sesión",
            "signedInAs": "Sesión iniciada como {email}",
            "fallback": "Tu nombre, correo, seguridad y cierre de sesión.",
            "selfHostTitle": "Inicio de sesión",
            "selfHostFallback": "Sesión iniciada en este Hivra autoalojado.",
            "signOut": "Cerrar sesión",
            "signingOut": "Cerrando sesión…",
            "signOutFailed": "No se pudo cerrar la sesión. Inténtalo de nuevo."
          },
          "rows": {
            "billing": { "description": "Plan, métodos de pago, créditos y facturas" },
            "wallets": { "title": "Billeteras", "description": "Billeteras de agentes y acceso con $HermesOS" },
            "apiKeys": { "title": "Claves de API", "description": "Claves de proveedores y qué agentes las usan" },
            "infrastructure": { "description": "Las máquinas y cuentas en la nube donde se ejecutan tus agentes" },
            "memory": { "title": "Memoria compartida de agentes", "description": "Lo que cada agente nuevo sabe desde el principio" },
            "tools": { "title": "Herramientas y capacidades", "description": "Añade herramientas a los agentes que elijas" },
            "library": { "title": "Biblioteca de prompts", "description": "Roles de agente listos con prompts probados" },
            "templates": { "title": "Plantillas", "description": "Guarda un agente configurado y vuelve a lanzarlo" },
            "referral": { "title": "Invita y gana", "description": "Comparte tu enlace y ganad créditos juntos" },
            "applications": { "title": "Aplicaciones", "description": "Usa Hivra en tu navegador o como app web" },
            "help": { "title": "Ayuda", "description": "Soporte, comunidad e información legal" }
          },
          "motionNote": "El movimiento sigue el ajuste de reducir movimiento de tu dispositivo.",
          "clearCacheConfirm": "Pulsa de nuevo para borrar y recargar",
          "clearCacheArmed": "Vuelve a pulsar el botón en 4 segundos para borrar la caché y recargar."
        }
      },
      "userModeSuffix": "Modo",
      "versionLabel": "Foundation v0.9.0"
    },
    "stats": {
      "hero": {
        "eyebrow": "En vivo · agentes desplegados",
        "label": "desplegados en total",
        "fullStats": "Estadísticas completas →"
      },
      "page": {
        "eyebrow": "Contador en vivo",
        "headlinePrefix": "Agentes",
        "headlineEmphasis": "desplegados",
        "headlineSuffix": "en Hivra",
        "body": "Cada vez que alguien despliega un agente con éxito, este contador sube.",
        "allTimeLabel": "Despliegues exitosos totales",
        "ariaTotal": "agentes desplegados en total",
        "cards": {
          "last24h": "Últimas 24 horas",
          "last7d": "Últimos 7 días",
          "firstDeploy": "Primer despliegue"
        },
        "sparkline": {
          "titlePrefix": "Despliegues diarios,",
          "titleEmphasis": "últimos 30 días",
          "hint": "Pasa el cursor o enfoca una barra para el conteo exacto",
          "peak": "día pico",
          "total": "total 30 días",
          "barLabel": "{date}: {count} despliegues"
        },
        "cta": {
          "button": "Despliega tu agente →",
          "subtitle": "Plan gratis — 1 agente, 0,5 vCPU, 1 GB RAM"
        }
      }
    },
    "footer": {
      "links": {
        "features": "Funciones",
        "compare": "Comparar",
        "blog": "Blog",
        "roadmap": "Ruta",
        "tokenVerification": "Verificación de token",
        "privacy": "Privacidad",
        "terms": "Términos"
      }
    }
  },
  "pt-BR": {
    "localeLabel": "Português",
    "languageSelectorLabel": "Idioma",
    "nav": {
      "pricing": "Preços",
      "roadmap": "Roteiro",
      "tokenVerification": "Verificação de token",
      "register": "Criar conta",
      "login": "Entrar",
      "openDashboard": "Abrir painel",
      "mobileMenu": "Abrir menu",
      "closeMobileMenu": "Fechar menu"
    },
    "hero": {
      "eyebrow": "Já disponível",
      "headlinePrefix": "Seus agentes de IA,",
      "headlineEmphasis": "sempre ativos.",
      "primary": "Hivra coloca seu agente Hermes no ar em menos de 5 minutos, com memória persistente, automação de navegador e uso de ferramentas.",
      "secondary": "O plano gratuito está ativo. Pro e Power servem cargas de trabalho sérias. Pague com cartão ou $HermesOS.",
      "primaryCta": "Começar grátis",
      "secondaryCta": "Ver como funciona",
      "proofPoints": [
        "Plano gratuito permanente",
        "Sua chave, sem margem",
        "Baseado no Hermes Agent"
      ]
    },
    "ticker": {
      "proofPoints": [
        "Baseado no Hermes Agent (Nous Research)",
        "Use sua chave, sem sobretaxa",
        "Plano gratuito sempre disponível"
      ]
    },
    "positioning": {
      "title": "OpenClaw esquece. Hermes acumula.",
      "body": "Desenvolvido pela Nous Research, o Hermes vive em um servidor e lembra de tudo — projetos, preferências, lições aprendidas. Cada sessão o torna mais afiado. Configurá-lo por conta própria leva a maioria das pessoas um fim de semana.",
      "punchline": "Hivra reduz esse fim de semana para 5 minutos."
    },
    "features": {
      "eyebrow": "O que está incluído",
      "titlePrefix": "Tudo que seu agente precisa.",
      "titleEmphasis": "Nada além disso.",
      "items": [
        {
          "headline": "Zero configuração. Full stack.",
          "body": "Automação de browser, uso de ferramentas, terminal, memória e cron — pré-configurados. Sem Docker, sem StackOverflow na madrugada."
        },
        {
          "headline": "Multi-agente desde o primeiro dia.",
          "body": "Perfis de agentes ilimitados em uma única instância. Pesquisadores, operadores, especialistas — sem custo extra por agente."
        },
        {
          "headline": "Sua chave. Zero markup.",
          "body": "OpenRouter, OpenAI ou Anthropic. Criptografado em repouso, injetado no deploy. Nunca vemos seus gastos com IA."
        },
        {
          "headline": "Converse de qualquer lugar.",
          "body": "Dashboard integrado com streaming. Conecte Telegram, Discord, Slack ou WhatsApp — out of the box."
        },
        {
          "headline": "Migração do OpenClaw embutida.",
          "body": "Sua configuração atual, prompts e skills são transferidos intactos. Sem começar do zero."
        },
        {
          "headline": "Estável. Recuperável. Sempre ativo.",
          "body": "Atualizações testadas contra sua configuração antes do rollout. Reinicialização automática em falhas. Backups diários — nunca a mais de 24 horas de uma restauração limpa."
        }
      ]
    },
    "howItWorks": {
      "eyebrow": "Como funciona",
      "titlePrefix": "Três passos.",
      "titleEmphasis": "Sem terminal necessário.",
      "steps": [
        {
          "step": "1",
          "headline": "Escolha seu plano",
          "body": "Comece gratuitamente, faça upgrade quando precisar de mais. Pague mensalmente com cartão, anualmente com desconto, ou mantenha $HermesOS para manter o acesso sem assinatura."
        },
        {
          "step": "2",
          "headline": "Adicione sua chave de IA",
          "body": "Cole sua chave do OpenRouter, OpenAI ou Anthropic uma vez. Criptografada, injetada, pronto."
        },
        {
          "step": "3",
          "headline": "Deploy. Converse. Automatize.",
          "body": "Seu agente fica ativo em minutos — chat, terminal, monitoramento. Conecte Telegram ou Discord e ele te acompanha em todo lugar."
        }
      ],
      "footer": "Pronto para passar da leitura para a configuração? Escolha seu plano e vá direto para a criação da conta.",
      "cta": "Escolha Seu Plano"
    },
    "useCases": {
      "eyebrow": "Casos de uso",
      "titlePrefix": "O que um agente 24/7",
      "titleEmphasis": "com memória realmente faz?",
      "intro": "Navega, escreve código, gerencia arquivos, chama APIs, executa tarefas cron — de forma autônoma. E lembra do que aprendeu na semana passada.",
      "items": [
        {
          "headline": "DevOps & Monitoramento",
          "body": "Lê logs, reinicia serviços com falha, te aciona só quando um humano é realmente necessário. Lembra da sua stack."
        },
        {
          "headline": "Pesquisa & Inteligência Competitiva",
          "body": "Dê um tema e um prazo. Ele navega, agrega e entrega um briefing estruturado — e salva o que aprendeu para a próxima vez."
        },
        {
          "headline": "Automação em Background",
          "body": "Triagem de e-mails, agendamentos, chamadas de API, planilhas — tudo que é repetitivo. Roda via cron enquanto você dorme."
        },
        {
          "headline": "Triagem de Suporte ao Cliente",
          "body": "Alimente-o com sua documentação. Ele resolve tickets comuns, escala os difíceis e fica mais inteligente a cada conversa."
        }
      ],
      "footer": "Viu o tipo de trabalho que o Hermes pode tirar do seu prato? Escolha um plano e lance o workflow que combina com sua carga.",
      "cta": "Ver Planos e Lançar"
    },
    "whatsComing": {
      "eyebrow": "O que vem por aí",
      "titlePrefix": "Isso é só",
      "titleEmphasis": "o começo.",
      "intro": "O hosting é a base. Em breve:",
      "items": [
        {
          "title": "Operator Packs",
          "body": "Templates de agentes pré-construídos para trabalhos específicos — pesquisa, inteligência de trading, automação de conteúdo. Deploy em um clique."
        },
        {
          "title": "Marketplace",
          "body": "Crie Operator Packs, publique para a comunidade, ganhe por uso. Liquidado em $HermesOS."
        },
        {
          "title": "Agent Endpoints",
          "body": "Exponha seu agente como uma API chamável. Outros agentes pagam por requisição."
        },
        {
          "title": "Hive Mind",
          "body": "Agentes compartilham o que aprendem. Toda a rede fica mais inteligente juntos."
        }
      ],
      "footer": "Hivra é a infraestrutura para uma economia de agentes. Hosting é o passo um. Todo o resto se constrói em cima."
    },
    "pricing": {
      "eyebrow": "Preços",
      "titlePrefix": "Planos simples.",
      "titleEmphasis": "Compute de verdade.",
      "intro": "Compute dedicado. Perfis de agentes ilimitados. BYO key, zero markup.",
      "compute": "Computação",
      "mostPopular": "Mais Popular",
      "forPros": "Para Profissionais",
      "getStarted": "Começar",
      "recommended": "Recomendado",
      "accessPrefix": "Três formas de acessar",
      "footnote": "Economize até 40% pagando com $HermesOS. Preços de lançamento para a primeira onda — valores podem ser ajustados conforme a plataforma amadurece.",
      "guarantee": "Plano gratuito — experimente antes de fazer upgrade · Reembolso em 48h para pagamentos com cartão",
      "tiers": [
        {
          "name": "Free",
          "tagline": "A maioria dos usuários pode começar sem cartão; deploys no plano gratuito com risco mais alto podem exigir verificação de cartão primeiro.",
          "price": "$0",
          "priceNote": "Sempre gratuito; cartão só se verificações de risco exigirem",
          "specs": [
            {
              "label": "vCPU",
              "value": "0.5"
            },
            {
              "label": "RAM",
              "value": "1 GB"
            },
            {
              "label": "Agentes ativos",
              "value": "1"
            }
          ],
          "features": [
            "Memória persistente",
            "Todas as integrações incluídas",
            "Limites de uso justo aplicáveis"
          ],
          "ctaLabel": "Começar Gratuitamente"
        },
        {
          "name": "Pro",
          "tagline": "Para trabalho de verdade, não apenas experimentos.",
          "price": "$9.99",
          "priceCadence": "/mês",
          "priceNote": "Assine mensalmente com cartão",
          "specs": [
            {
              "label": "vCPU",
              "value": "2"
            },
            {
              "label": "RAM",
              "value": "4 GB"
            },
            {
              "label": "Agentes simultâneos",
              "value": "3",
              "tooltip": "Quantos dos seus agentes podem executar tarefas ao mesmo tempo. Perfis são ilimitados — este é o limite de execução ao vivo."
            }
          ],
          "features": [
            "Perfis de agentes ilimitados",
            "Tudo do Free",
            "Prioridade sobre o plano gratuito"
          ],
          "paymentPaths": [
            {
              "label": "Cartão mensal",
              "detail": "$9,99/mês"
            },
            {
              "label": "Anual",
              "detail": "$79/ano cartão · $49/ano em $HermesOS"
            },
            {
              "label": "Manter $HermesOS",
              "detail": "~$99 (preço de lançamento, primeiros 30 dias)"
            }
          ],
          "ctaLabel": "Assinar Pro"
        },
        {
          "name": "Power",
          "tagline": "Para workflows sérios e operações multi-agente.",
          "price": "$19.99",
          "priceCadence": "/mês",
          "priceNote": "Assine mensalmente com cartão",
          "specs": [
            {
              "label": "vCPU",
              "value": "4"
            },
            {
              "label": "RAM",
              "value": "8 GB"
            },
            {
              "label": "Agentes simultâneos",
              "value": "Ilimitado",
              "tooltip": "Execute quantos agentes simultaneamente seu pool de compute suportar — vários agentes trabalhando em paralelo, sem limite imposto pela plataforma."
            }
          ],
          "features": [
            "Perfis de agentes ilimitados",
            "Tudo do Pro",
            "CPU em burst quando a capacidade permitir"
          ],
          "paymentPaths": [
            {
              "label": "Cartão mensal",
              "detail": "$19,99/mês"
            },
            {
              "label": "Anual",
              "detail": "$149/ano cartão · $99/ano em $HermesOS"
            },
            {
              "label": "Manter $HermesOS",
              "detail": "~$199 (preço de lançamento, primeiros 30 dias)"
            }
          ],
          "ctaLabel": "Assinar Power"
        }
      ]
    },
    "token": {
      "eyebrow": "Sobre $HermesOS",
      "title": "A camada de acesso da plataforma.",
      "body": "$HermesOS permite pagar assinaturas com desconto, manter para conservar seu plano sem pagar mensalmente, ou transacionar pela economia de agentes conforme a lançamos.",
      "secondary": "O token não é obrigatório para usar o Hivra — o plano gratuito continua disponível sem ele, com verificações anti-abuso onde necessário. Se você quiser mergulhar mais fundo no ecossistema, manter $HermesOS desbloqueia mais flexibilidade em como você paga e acessa.",
      "cta": "Página de verificação do token"
    },
    "faq": {
      "eyebrow": "Perguntas frequentes",
      "title": "Respostas diretas.",
      "items": [
        {
          "q": "Minha chave de API está segura?",
          "a": "Sim. Criptografada em repouso, injetada no deploy via variáveis de ambiente. Nunca fazemos proxy nem registramos suas requisições de IA."
        },
        {
          "q": "As atualizações vão quebrar minha configuração?",
          "a": "Não. Cada atualização é testada contra as configurações do container antes de ser publicada. Backups diários garantem que você nunca estará a mais de 24 horas de uma restauração limpa."
        },
        {
          "q": "Como isso é diferente do OpenClaw?",
          "a": "OpenClaw é um excelente framework open-source para desktop. Hivra é um ambiente cloud totalmente gerenciado e pronto para produção. O Hermes Agent tem memória mais estável, maior confiabilidade e atualizações que não quebram seus recursos existentes."
        },
        {
          "q": "E se meu agente travar?",
          "a": "Ele reinicia automaticamente. Saúde, logs e uso de recursos sempre visíveis no dashboard."
        },
        {
          "q": "Posso rodar vários agentes em um único plano?",
          "a": "Sim — perfis ilimitados por instância. Free roda 1 agente ativo, Pro roda 3, Power não tem limite de concorrência. Seu pool de compute é o único limite real."
        },
        {
          "q": "Quais provedores de IA são suportados?",
          "a": "OpenRouter, OpenAI e Anthropic. Só o OpenRouter já te dá acesso a centenas de modelos com uma única chave."
        },
        {
          "q": "Preciso usar $HermesOS para acessar a plataforma?",
          "a": "Não. O plano gratuito não exige. Pro e Power podem ser pagos com cartão. O token oferece descontos e um terceiro caminho de pagamento para quem quiser."
        },
        {
          "q": "O que vem a seguir?",
          "a": "Operator Packs (templates de agentes pré-construídos) chegam nas próximas semanas. Marketplace, Agent Endpoints e Hive Mind vêm depois. O roadmap está em hermesos.cloud/roadmap."
        }
      ]
    },
    "finalCta": {
      "eyebrow": "Comece agora",
      "title": "Pronto para fazer o deploy?",
      "body": "O plano gratuito está ativo com proteções contra abuso. Pro e Power disponíveis agora.",
      "primary": "Começar Gratuitamente",
      "secondary": "Ver Preços",
      "note": "A maioria dos usuários gratuitos pode começar sem cartão; cadastros de maior risco podem precisar de cartão registrado.",
      "accountPrefix": "Já tem uma conta?",
      "accountLink": "Entrar"
    },
    "getStarted": {
      "loadingCheckout": "Redirecionando para o checkout...",
      "steps": {
        "choosePlan": "Escolher Plano",
        "createAccount": "Criar Conta",
        "activate": "Ativar",
        "payment": "Pagamento"
      },
      "badges": {
        "free": "Sempre Gratuito",
        "paid": "Garantia de 7 Dias"
      },
      "yourPlan": "Seu Plano",
      "perMonth": "/mês",
      "perYear": "/ano",
      "cadence": {
        "monthly": "Mensal",
        "yearly": "Anual",
        "saveLabel": "economize ~{percent}%",
        "saveDollarsLabel": "Economize ~${dollars}/ano"
      },
      "marketAnchor": "Plataformas de agentes comparáveis começam em torno de $19/mês",
      "mostPopular": "Mais popular",
      "freeGap": "Sem navegação web · sem memória persistente · sem tarefas agendadas · 0.5 vCPU",
      "specs": {
        "agents": "Agentes",
        "cpu": "CPU",
        "ram": "RAM"
      },
      "guarantee": {
        "free": "Sem checkout necessário",
        "paid": "Garantia de reembolso em 7 dias"
      },
      "switchPlan": "Trocar Plano",
      "bestFit": "Melhor Opção",
      "planGuidance": {
        "free": "O Free é ideal para experimentar o Hermes com um agente monitorado. A maioria dos usuários pode começar sem cartão; deploys de maior risco podem exigir verificação de cartão primeiro.",
        "operator": "O Pro é ideal para desenvolvedores solo, projetos de hackathon e para colocar um agente no ar rapidamente.",
        "fleet": "O Power é ideal para workflows multi-agente, navegação mais intensa e equipes que querem mais margem de compute imediatamente.",
        "command": "O Command é ideal para as maiores cargas de trabalho, o caminho de escalonamento mais rápido e o máximo de compute por deploy."
      },
      "createAccountTitle": "Crie sua conta.",
      "createAccountIntroFree": "Seus dados de conta se tornam suas credenciais de login. Após o cadastro, ativaremos seu plano Free e te levaremos direto para o deploy. A maioria dos usuários pode começar sem cartão; deploys de maior risco podem exigir verificação de cartão primeiro.",
      "createAccountIntroPaid": "Seus dados de conta se tornam suas credenciais de login. Após o cadastro, você prosseguirá para o checkout seguro. Protegido pela nossa garantia de reembolso em 7 dias.",
      "legalPrefix": "Ao continuar, você concorda com nossos",
      "terms": "Termos de Serviço",
      "and": "e",
      "privacy": "Política de Privacidade"
    },
    "dashboard": {
      "nav": {
        "chat": "Chat",
        "commandCenter": "Centro de comando",
        "home": "Início",
        "computers": "Computadores",
        "agents": "Agentes",
        "infrastructure": "Infraestrutura",
        "collaboration": "Colaboração",
        "settings": "Configurações",
        "launch": "Lançar",
        "ops": "Operações",
        "promptLibrary": "Biblioteca de prompts",
        "wallet": "Carteira",
        "billing": "Faturamento"
      },
      "sections": {
        "advanced": "Avançado",
        "support": "Suporte"
      },
      "support": {
        "discord": "Discord",
        "xTwitter": "X (Twitter)",
        "email": "Suporte por E-mail"
      },
      "legal": {
        "terms": "Termos",
        "privacy": "Privacidade"
      },
      "controls": {
        "expandSidebarTitle": "Expandir Barra Lateral",
        "collapseSidebarTitle": "Recolher Barra Lateral",
        "expandSidebarLabel": "Expandir barra lateral do dashboard",
        "collapseSidebarLabel": "Recolher barra lateral do dashboard",
        "globalSettings": "Configurações Globais"
      },
      "commandCenter": {
        "phase": "Fase II: Operações de Frota",
        "titlePrefix": "Centro de",
        "titleSeparator": " ",
        "titleEmphasis": "Comando",
        "titleSuffix": ".",
        "labelSeparator": ": ",
        "sections": {
          "activeAgents": "Agentes Ativos",
          "activeCoreInstances": "Instâncias Core Ativas",
          "infrastructureNodes": "Nós de Infraestrutura"
        },
        "actions": {
          "advancedConsole": "Console Avançado",
          "applyChanges": "Aplicar Alterações",
          "applying": "Aplicando...",
          "cancel": "Cancelar",
          "confirmRemove": "Confirmar Remoção",
          "coreConsole": "Console Core",
          "initializeAgent": "Inicializar Agente",
          "manageAllocation": "Gerenciar Alocação",
          "removeNode": "Remover Nó",
          "removing": "Removendo..."
        },
        "alerts": {
          "activeFailureTitle": "Falha ativa requer atenção",
          "activeFailurePrefix": "O Hermes encontrou uma falha ativa em",
          "activeFailureSingular": "instância",
          "activeFailurePlural": "instâncias",
          "activeFailureSuffix": "Cada item agora indica quem é responsável pelo próximo passo.",
          "recoveryPrefix": "Recuperação",
          "updateTitle": "Atenção necessária na atualização",
          "updateSummaryPrefix": "O Hermes detectou um problema de atualização em",
          "updateSummarySingular": "instância",
          "updateSummaryPlural": "instâncias",
          "updateSummarySuffix": "Seus dados Docker montados permanecem intactos, mas esses agentes precisam de uma verificação rápida.",
          "scheduledUpdateFailed": "A última atualização automática falhou. Seus volumes Docker permanecem montados, mas esta instância precisa de uma verificação rápida.",
          "manualUpdateFailed": "A última atualização manual falhou. Seus volumes Docker permanecem montados, mas esta instância precisa de uma verificação rápida."
        },
        "status": {
          "running": "em execução",
          "provisioning": "provisionando",
          "stopped": "parado",
          "error": "erro",
          "failed": "falhou"
        },
        "instance": {
          "activeAgentSingular": "Agente Ativo",
          "activeAgentPlural": "Agentes Ativos",
          "configuredInAgentSettings": "Configurado nas configurações do agente",
          "coreSingular": "Núcleo",
          "corePlural": "Núcleos",
          "fetchingProfiles": "Carregando Perfis...",
          "hostInstancePrefix": "Instância Host",
          "idPrefix": "ID",
          "primaryAgent": "Agente Principal",
          "profileNode": "Nó de Perfil",
          "secondaryAgent": "Agente Secundário"
        },
        "telemetry": {
          "activeModel": "Modelo Ativo",
          "containerState": "Estado do Container",
          "cpuUtilization": "Utilização de CPU",
          "hostComputeNode": "Nó de compute host",
          "limitPrefix": "Limite",
          "llmInferenceEngine": "Motor de inferência LLM",
          "memoryAllocation": "Alocação de Memória",
          "networkIo": "I/O de Rede",
          "provider": "Provedor",
          "providerPrefix": "Provedor",
          "totalTxPrefix": "Tx Total",
          "unrestricted": "SEM RESTRIÇÃO",
          "uptimePrefix": "Tempo on-line"
        },
        "allocation": {
          "cpuAllocated": "CPU Alocada",
          "cpuAllocation": "Alocação de CPU",
          "cpuCapacityError": "A alocação total de CPU ({allocated}) excede a capacidade do nó ({capacity}).",
          "dangerZone": "Zona de Perigo",
          "deleteConfirmationPhrase": "excluir",
          "deletePromptPrefix": "Digite",
          "deletePromptSuffix": "para confirmar a remoção. Isso destruirá permanentemente a infraestrutura e quaisquer agentes offline nela.",
          "failedToRemoveHost": "Falha ao remover host",
          "memoryAllocated": "Memória Alocada",
          "memoryAllocation": "Alocação de Memória (RAM)",
          "memoryCapacityError": "A alocação total de memória ({allocated}GB) excede a capacidade do nó ({capacity}GB).",
          "noActiveAgents": "Nenhum agente ativo neste nó.",
          "nodeAllocationPrefix": "Alocação do Nó",
          "projectedNodeUsage": "Uso Projetado do Nó"
        },
        "errors": {
          "failedToLoadOperations": "Falha ao carregar dados de operações"
        }
      },
      "library": {
        "returnToCommandCenter": "Voltar ao centro de comando",
        "titlePrefix": "Biblioteca",
        "titleSeparator": " de ",
        "titleEmphasis": "prompts",
        "titleSuffix": ".",
        "intro": "Deploy de templates de agentes altamente especializados com system prompts testados em produção. Curados do blueprint premium Agency.",
        "sourcePrefix": "Templates gentilmente fornecidos por",
        "sourceLinkLabel": "Agency Agents de Michal Sitarzewski",
        "sourceSuffix": ".",
        "searchPlaceholder": "Buscar modelos por nome ou descrição...",
        "featured": "Destaque",
        "allTemplates": "Todos os modelos",
        "viewPrompt": "Ver prompt",
        "deploy": "Implantar",
        "empty": "Nenhum template encontrado para os seus critérios",
        "copied": "Copiado!",
        "copyPrompt": "Copiar prompt",
        "deployTemplate": "Implantar este modelo",
        "closePreview": "Fechar pré-visualização do prompt",
        "categories": {
          "All": "Tudo",
          "Engineering": "Engenharia",
          "Design": "Design",
          "Marketing": "Marketing",
          "Product": "Produto",
          "Operations": "Operações",
          "Research": "Pesquisa",
          "Security": "Segurança",
          "Finance": "Finanças"
        }
      },
      "wallet": {
        "eyebrowLegacy": "Carteira · Depósito e retirada",
        "eyebrowSelfCustody": "Carteira · Verificação por assinatura",
        "titlePrefix": "Sua",
        "titleSeparator": " ",
        "titleEmphasis": "$HermesOS",
        "titleSuffix": ".",
        "legacyIntroStrong": "Carteira custody grandfathered",
        "legacyIntroBody": "seu fluxo existente de depósito e retirada continua ativo. Trave o preço atual do $HERMESOS para o plano desejado e envie o valor cotado para seu endereço de depósito. O plano gratuito sempre funciona sem depósito.",
        "selfCustodyIntroStrong": "Conecte sua própria carteira",
        "selfCustodyIntroBody": "mantenha $HermesOS e VVV você mesmo, depois assine uma mensagem para verificar a propriedade. O plano gratuito sempre funciona sem verificação de token.",
        "priceUnavailable": "Preço do token indisponível — tente novamente mais tarde.",
        "buyToken": {
          "ariaLabel": "Comprar $HermesOS",
          "eyebrow": "Obter $HermesOS",
          "title": "Comprar na Uniswap (rede Base).",
          "action": "Comprar na Uniswap →",
          "contractLabel": "Endereço do contrato (Base)",
          "copyContractLabel": "Copiar endereço do contrato",
          "copied": "Copiado",
          "copy": "Copiar",
          "warningPrefix": "Sempre verifique o endereço do contrato em",
          "warningLink": "hermesos.cloud/token",
          "warningSuffix": "antes de enviar fundos. Ignore endereços copiados de DMs, respostas ou capturas de tela."
        },
        "verification": {
          "ariaLabel": "Verificação de carteira",
          "eyebrow": "Verificação self-custody",
          "connectedTitle": "Carteira conectada.",
          "disconnectedTitle": "Verifique pela sua carteira.",
          "activeWallet": "Carteira ativa",
          "lastCheckedPrefix": "Última verificação",
          "connecting": "Conectando...",
          "checking": "Verificando...",
          "connectWallet": "Conectar carteira",
          "changeWallet": "Trocar carteira",
          "refreshBalance": "Atualizar saldo",
          "checkLock": "Verificar lock {tier}",
          "lockPrice": "Travar preço {tier}",
          "lockedFor20": "Preço {tier} travado por 20 minutos em",
          "holdAtLeastThatAmount": "Mantenha pelo menos esse valor nesta carteira antes que o lock expire.",
          "yourRateLockedAt": "Sua taxa {tier} está travada em",
          "lockNext": "Trave o preço {tier} a seguir se quiser esse plano.",
          "keepEligible": "Mantenha esse valor nesta carteira para continuar elegível.",
          "detected": "Detectado",
          "snapshotInstruction": "Trave o preço {tier} para fazer snapshot do valor em tokens por 20 minutos.",
          "refreshInstruction": "Atualize o saldo para confirmar seu plano atual.",
          "connectedFootnote": "Apenas uma carteira pode estar ativa por vez. Trocar de carteira substitui a carteira ativa; assinaturas não movem tokens.",
          "disconnectedBody": "Mantenha $HermesOS e VVV em sua própria carteira Base. Uma mensagem assinada comprova a propriedade sem enviar tokens para o Hivra.",
          "verifiedSuffix": "verificado."
        },
        "eligibility": {
          "ariaLabel": "Elegibilidade de plano",
          "eyebrow": "Elegibilidade de plano",
          "currentBalancePrefix": "Saldo atual:",
          "autoRefreshPrefix": "Atualiza automaticamente a cada 5 min · última verificação",
          "refreshBalanceLabel": "Atualizar saldo",
          "refresh": "Atualizar",
          "thresholdsMissing": "Os limites de plano ainda não foram configurados. A elegibilidade não está sendo avaliada. Volte quando o fluxo de depósito entrar no ar.",
          "proTier": "Plano Pro",
          "powerTier": "Plano Power",
          "eligible": "Elegível",
          "breached": "Violado — elegibilidade encerrada",
          "notYetEligible": "Ainda não elegível",
          "holdAtLeast": "Mantenha pelo menos",
          "depositAtLeast": "Deposite pelo menos",
          "selfCustodyQualifySuffix": "em sua carteira verificada para se qualificar ao plano {tier} sem assinatura.",
          "custodyQualifySuffix": "para se qualificar ao plano {tier} sem assinatura.",
          "lockedAtPrice": "Travado no preço cotado — atualiza quando a cotação expirar."
        },
        "agentWallets": {
          "ariaLabel": "Carteiras dos agentes",
          "title": "Carteiras dos agentes.",
          "subtitle": "Uma carteira por agente · Sua própria conta Bankr · Apenas Base",
          "emptyNoAgents": "Crie um agente e conecte sua própria conta Bankr para dar uma carteira a ele.",
          "deployAgent": "Criar um agente",
          "runningEmpty": "Agentes em execução aparecerão aqui."
        }
      },
      "billing": {
        "eyebrow": "Faturamento e assinatura",
        "titlePrefix": "Gestão",
        "titleSeparator": " de ",
        "titleEmphasis": "plano",
        "titleSuffix": ".",
        "subtitle": "Seu plano, como você paga e o que já usou.",
        "refreshing": "Atualizando…",
        "credits": {
          "title": "Saldo de créditos",
          "available": "disponíveis",
          "description": "Os créditos da conta pagam o uso. Eles não definem seu plano: isso vem de uma assinatura, de um pagamento anual em $HermesOS ou de manter $HermesOS.",
          "monthlyGrantSuffix": "créditos do plano mensal"
        },
        "activity": {
          "eyebrow": "Atividade de Cobrança",
          "title": "Movimentação recente da conta",
          "loading": "Carregando",
          "ledger": "Extrato",
          "ledgerLoading": "Carregando extrato...",
          "ledgerEmpty": "Nenhuma entrada no extrato ainda.",
          "payments": "Pagamentos",
          "paymentsLoading": "Carregando pagamentos...",
          "paymentsEmpty": "Nenhum pagamento ainda.",
          "compute": "Computação",
          "computeLoading": "Carregando compute...",
          "computeEmpty": "Nenhum uso de compute ainda.",
          "llm": "LLM",
          "llmLoading": "Carregando LLM...",
          "llmEmpty": "Nenhum uso de LLM ainda."
        },
        "tokenAccess": {
          "eyebrow": "Acesso por token",
          "title": "Holding de $HermesOS",
          "description": "Mantenha pelo menos o mínimo de $HermesOS em uma carteira verificada para liberar uma máquina básica. Se o saldo cair abaixo do mínimo, os agentes dessa máquina continuam rodando por um período de carência e depois pausam até você voltar a ter o suficiente.",
          "checking": "Verificando",
          "unavailable": "Indisponível",
          "ready": "Mínimo atingido",
          "belowMinimum": "Abaixo do mínimo",
          "noWallet": "Nenhuma carteira verificada",
          "wallet": "Carteira",
          "balance": "Saldo",
          "minimum": "Mínimo",
          "notVerified": "Não verificado",
          "noSnapshot": "Sem snapshot",
          "refresh": "Atualizar Status do Token",
          "refreshing": "Atualizando...",
          "connectWallet": "Conectar Carteira",
          "connecting": "Conectando...",
          "verifyDifferent": "Verificar Outra Carteira"
        },
        "cryptoCredits": {
          "eyebrow": "Créditos cripto",
          "description": "Escolha um valor e daremos um endereço para você enviar USDC na Base. Os créditos entram assim que a transferência for confirmada.",
          "bonusPath": "Caminho de bônus preparado",
          "pendingDeposit": "Depósito Pendente",
          "createTopUpLabel": "Criar recarga USDC de {credits} créditos",
          "sendPrefix": "Envie",
          "onNetwork": "na rede",
          "reference": "Referência"
        },
        "activePlan": {
          "title": "Plano atual",
          "heldViaTokens": "MANTIDO VIA $HERMESOS",
          "perMonth": "/mês",
          "agents": "Agentes",
          "cpuBudget": "Orçamento CPU",
          "ramBudget": "Orçamento RAM",
          "manageSubscription": "Gerenciar assinatura",
          "opening": "Abrindo..."
        },
        "switcher": {
          "title": "Trocar plano",
          "description": "Faça upgrade a qualquer momento. Downgrades não estão disponíveis — servidores dedicados não podem ser reduzidos.",
          "currentPlan": "Plano atual",
          "upgrade": "Atualizar",
          "lowerTier": "Plano Inferior",
          "unlimited": "Ilimitado",
          "agents": "agentes",
          "active": "Ativo",
          "guarantee": "Política de reembolso em 48h · Planos somente com upgrade"
        },
        "noSubscription": {
          "title": "Sem assinatura ativa"
        },
        "plate": {
          "slots": "Vagas",
          "vcpu": "vCPU",
          "memory": "Memória",
          "idlePolicy": "Inatividade",
          "alwaysOn": "Sempre ligado",
          "sleepsAfterIdle": "Hiberna após {days} dias sem atividade"
        }
      },
      "settings": {
        "loading": "Carregando...",
        "returnToCommandCenter": "Voltar ao centro de comando",
        "titlePrefix": "Configurações",
        "titleSeparator": " ",
        "titleEmphasis": "globais",
        "titleSuffix": ".",
        "intro": "Configure seu workspace, temas de interface e comportamento do aplicativo.",
        "sections": {
          "appearance": "Aparência",
          "chatInterface": "Interface de Chat e Agente",
          "capabilities": "Capacidades e Plugins",
          "dangerZone": "Zona de Perigo"
        },
        "theme": {
          "label": "Tema",
          "description": "Claro, escuro ou igual ao seu dispositivo.",
          "light": "Claro",
          "dark": "Escuro",
          "system": "Sistema"
        },
        "language": {
          "label": "Idioma do site",
          "description": "Escolha o idioma usado no Hivra."
        },
        "reducedMotion": {
          "label": "Movimento Reduzido",
          "description": "Minimize transições e animações pesadas de UI."
        },
        "autoScroll": {
          "label": "Rolagem Automática do Chat",
          "description": "Fixar automaticamente na parte inferior quando novas mensagens chegarem."
        },
        "streamingAnimations": {
          "label": "Animações de Streaming",
          "description": "Exibir efeitos de fade-in em markdown ao receber streams do agente."
        },
        "aiReasoning": {
          "label": "Expandir Raciocínio da IA",
          "description": "Iniciar com o bloco \"Pensando\" da IA automaticamente expandido."
        },
        "persistentMemory": {
          "label": "Ativar Memória Persistente",
          "description": "Permitir que o Hermes grave suas próprias memórias no MEMORY.md entre sessões usando o provedor de memória plugável."
        },
        "plugins": {
          "label": "Ativar Plugins / Skills Extensíveis",
          "description": "Dar ao Hermes acesso a skills MCP/ACP upstream e ferramentas experimentais."
        },
        "clearCache": {
          "label": "Limpar o cache local",
          "description": "Limpa os dados do painel em cache neste navegador e as escolhas de layout salvas aqui, como as abas do terminal, e recarrega a página. Sua conta, seus agentes e seus computadores não são afetados.",
          "action": "Limpar cache"
        },
        "hub": {
          "title": "Configurações",
          "intro": "Sua conta, cobrança, chaves e ferramentas de agentes, além da aparência do Hivra neste navegador.",
          "groups": {
            "account": "Conta",
            "billing": "Plano e cobrança",
            "connections": "Chaves e conexões",
            "toolkit": "Ferramentas de agentes",
            "device": "Neste dispositivo",
            "apps": "Apps e ajuda",
            "reset": "Redefinir este navegador"
          },
          "profile": {
            "title": "Perfil e login",
            "signedInAs": "Conectado como {email}",
            "fallback": "Seu nome, e-mail, segurança e saída da conta.",
            "selfHostTitle": "Login",
            "selfHostFallback": "Conectado a este Hivra auto-hospedado.",
            "signOut": "Sair",
            "signingOut": "Saindo…",
            "signOutFailed": "Não foi possível sair. Tente de novo."
          },
          "rows": {
            "billing": { "description": "Plano, formas de pagamento, créditos e faturas" },
            "wallets": { "title": "Carteiras", "description": "Carteiras dos agentes e acesso com $HermesOS" },
            "apiKeys": { "title": "Chaves de API", "description": "Chaves de provedores e quais agentes as usam" },
            "infrastructure": { "description": "As máquinas e contas de nuvem onde seus agentes rodam" },
            "memory": { "title": "Memória compartilhada dos agentes", "description": "O que todo agente novo já sabe desde o início" },
            "tools": { "title": "Ferramentas e recursos", "description": "Adicione ferramentas aos agentes que você escolher" },
            "library": { "title": "Biblioteca de prompts", "description": "Funções de agente prontas com prompts testados" },
            "templates": { "title": "Modelos", "description": "Salve um agente configurado e lance-o de novo" },
            "referral": { "title": "Indique e ganhe", "description": "Compartilhe seu link e ganhem créditos juntos" },
            "applications": { "title": "Aplicativos", "description": "Use o Hivra no navegador ou como app web" },
            "help": { "title": "Ajuda", "description": "Suporte, comunidade e informações legais" }
          },
          "motionNote": "O movimento segue a configuração de reduzir movimento do seu dispositivo.",
          "clearCacheConfirm": "Pressione de novo para limpar e recarregar",
          "clearCacheArmed": "Pressione o botão de novo em até 4 segundos para limpar o cache e recarregar."
        }
      },
      "userModeSuffix": "Modo",
      "versionLabel": "Foundation v0.9.0"
    },
    "stats": {
      "hero": {
        "eyebrow": "Ao vivo · agentes implantados",
        "label": "implantados no total",
        "fullStats": "Estatísticas completas →"
      },
      "page": {
        "eyebrow": "Contador ao vivo",
        "headlinePrefix": "Agentes",
        "headlineEmphasis": "implantados",
        "headlineSuffix": "no Hivra",
        "body": "Sempre que alguém implanta um agente com sucesso, este contador sobe.",
        "allTimeLabel": "Implantações bem-sucedidas totais",
        "ariaTotal": "agentes implantados no total",
        "cards": {
          "last24h": "Últimas 24 horas",
          "last7d": "Últimos 7 dias",
          "firstDeploy": "Primeira implantação"
        },
        "sparkline": {
          "titlePrefix": "Implantações diárias,",
          "titleEmphasis": "últimos 30 dias",
          "hint": "Passe o cursor ou foque uma barra para a contagem exata",
          "peak": "dia de pico",
          "total": "total 30 dias",
          "barLabel": "{date}: {count} implantações"
        },
        "cta": {
          "button": "Implante seu agente →",
          "subtitle": "Plano grátis — 1 agente, 0,5 vCPU, 1 GB RAM"
        }
      }
    },
    "footer": {
      "links": {
        "features": "Recursos",
        "compare": "Comparar",
        "blog": "Blog",
        "roadmap": "Roteiro",
        "tokenVerification": "Verificação de token",
        "privacy": "Privacidade",
        "terms": "Termos"
      }
    }
  },
  "fr": {
    "localeLabel": "Français",
    "languageSelectorLabel": "Langue",
    "nav": {
      "pricing": "Tarifs",
      "roadmap": "Feuille de route",
      "tokenVerification": "Vérification du token",
      "register": "S’inscrire",
      "login": "Connexion",
      "openDashboard": "Ouvrir le tableau",
      "mobileMenu": "Ouvrir le menu",
      "closeMobileMenu": "Fermer le menu"
    },
    "hero": {
      "eyebrow": "Disponible",
      "headlinePrefix": "Vos agents IA,",
      "headlineEmphasis": "toujours actifs.",
      "primary": "Hivra lance votre agent Hermes en moins de 5 minutes, avec mémoire persistante, automatisation du navigateur et outils.",
      "secondary": "Le niveau gratuit est actif. Pro et Power sont prêts pour les charges sérieuses.",
      "primaryCta": "Commencer gratis",
      "secondaryCta": "Voir le fonctionnement",
      "proofPoints": [
        "Niveau gratuit permanent",
        "Votre clé, sans marge",
        "Basé sur Hermes Agent"
      ]
    },
    "ticker": {
      "proofPoints": [
        "Propulsé par Hermes Agent (Nous Research)",
        "Votre clé, zéro commission",
        "Tier gratuit toujours disponible"
      ]
    },
    "positioning": {
      "title": "OpenClaw oublie. Hermes capitalise.",
      "body": "Conçu par Nous Research, Hermes vit sur un serveur et se souvient de tout — projets, préférences, leçons apprises. Chaque session l'affûte davantage. En auto-hébergement, la mise en place prend généralement un week-end.",
      "punchline": "Hivra réduit ce week-end à 5 minutes."
    },
    "features": {
      "eyebrow": "Ce qui est inclus",
      "titlePrefix": "Tout ce dont votre agent a besoin.",
      "titleEmphasis": "Rien de superflu.",
      "items": [
        {
          "headline": "Zéro config. Full stack.",
          "body": "Automatisation du navigateur, outils, terminal, mémoire et cron — préconfigurés. Ni Docker, ni StackOverflow à minuit."
        },
        {
          "headline": "Multi-agent dès le premier jour.",
          "body": "Profils d'agents illimités sur une seule instance. Chercheurs, opérateurs, spécialistes — aucun coût supplémentaire par agent."
        },
        {
          "headline": "Votre clé. Zéro commission.",
          "body": "OpenRouter, OpenAI ou Anthropic. Chiffrée au repos, injectée au déploiement. Nous ne voyons jamais vos dépenses IA."
        },
        {
          "headline": "Chattez depuis n'importe où.",
          "body": "Dashboard intégré avec streaming. Connectez Telegram, Discord, Slack ou WhatsApp — nativement."
        },
        {
          "headline": "Migration OpenClaw intégrée.",
          "body": "Votre configuration actuelle, vos prompts et vos compétences migrent intacts. Pas de départ de zéro."
        },
        {
          "headline": "Stable. Récupérable. Toujours actif.",
          "body": "Mises à jour testées contre votre config avant déploiement. Redémarrage automatique en cas de panne. Sauvegardes quotidiennes — jamais à plus de 24 heures d'une restauration propre."
        }
      ]
    },
    "howItWorks": {
      "eyebrow": "Comment ça marche",
      "titlePrefix": "Trois étapes.",
      "titleEmphasis": "Aucun terminal requis.",
      "steps": [
        {
          "step": "1",
          "headline": "Choisissez votre tier",
          "body": "Commencez gratuitement, passez à un tier supérieur quand vous en avez besoin. Payez mensuellement par carte, annuellement pour bénéficier d'une réduction, ou détenez des $HermesOS pour maintenir votre accès sans abonnement."
        },
        {
          "step": "2",
          "headline": "Ajoutez votre clé IA",
          "body": "Collez votre clé OpenRouter, OpenAI ou Anthropic une seule fois. Chiffrée, injectée, c'est fait."
        },
        {
          "step": "3",
          "headline": "Déployez. Chattez. Automatisez.",
          "body": "Votre agent est en ligne en quelques minutes — chat, terminal, monitoring. Connectez Telegram ou Discord et il vous suit partout."
        }
      ],
      "footer": "Prêt à passer de la lecture à la mise en place ? Choisissez votre tier et lancez directement la création de compte.",
      "cta": "Choisissez votre tier"
    },
    "useCases": {
      "eyebrow": "Cas d'usage",
      "titlePrefix": "Que fait un agent 24h/24",
      "titleEmphasis": "avec de la mémoire, concrètement ?",
      "intro": "Naviguer, coder, gérer des fichiers, appeler des API, exécuter des tâches cron — de manière autonome. Et il se souvient de ce qu'il a appris la semaine dernière.",
      "items": [
        {
          "headline": "DevOps et supervision",
          "body": "Lit les logs, redémarre les services défaillants, vous alerte uniquement quand une intervention humaine est vraiment nécessaire. Mémorise votre stack."
        },
        {
          "headline": "Recherche & Veille concurrentielle",
          "body": "Donnez-lui un sujet et une deadline. Il navigue, agrège et produit un brief structuré — puis sauvegarde ce qu'il a appris pour la prochaine fois."
        },
        {
          "headline": "Automatisation en arrière-plan",
          "body": "Tri des e-mails, planification, appels API, tableurs — tout ce qui est répétitif. Tourne sur cron pendant que vous dormez."
        },
        {
          "headline": "Triage du support client",
          "body": "Alimentez-le avec votre documentation. Il résout les tickets courants, escalade les cas complexes et s'améliore à chaque conversation."
        }
      ],
      "footer": "Vous avez vu ce que Hermes peut prendre en charge ? Choisissez un plan et lancez le workflow qui correspond à votre charge.",
      "cta": "Voir les plans & lancer"
    },
    "whatsComing": {
      "eyebrow": "Ce qui arrive",
      "titlePrefix": "Ce n'est que",
      "titleEmphasis": "le début.",
      "intro": "L'hébergement est la fondation. À venir :",
      "items": [
        {
          "title": "Operator Packs",
          "body": "Templates d'agents préconstruits pour des usages spécifiques — recherche, veille trading, automatisation de contenu. Déployez en un clic."
        },
        {
          "title": "Marketplace",
          "body": "Créez des Operator Packs, distribuez-les à la communauté, gagnez à l'usage. Réglé en $HermesOS."
        },
        {
          "title": "Agent Endpoints",
          "body": "Exposez votre agent comme une API callable. D'autres agents vous paient par requête."
        },
        {
          "title": "Hive Mind",
          "body": "Les agents partagent ce qu'ils apprennent. Tout le réseau devient plus intelligent ensemble."
        }
      ],
      "footer": "Hivra est l'infrastructure d'une économie d'agents. L'hébergement est la première étape. Tout le reste se construit par-dessus."
    },
    "pricing": {
      "eyebrow": "Tarification",
      "titlePrefix": "Des plans simples.",
      "titleEmphasis": "Un compute sérieux.",
      "intro": "Compute dédié. Profils d'agents illimités. Votre clé, zéro commission.",
      "compute": "Calcul",
      "mostPopular": "Le plus populaire",
      "forPros": "Pour les pros",
      "getStarted": "Commencer",
      "recommended": "Recommandé",
      "accessPrefix": "Trois façons d'accéder",
      "footnote": "Économisez jusqu'à 40 % en payant avec $HermesOS. Tarifs de lancement pour la première vague — susceptibles d'évoluer à mesure que la plateforme mûrit.",
      "guarantee": "Tier gratuit — essayez avant de monter en gamme · Remboursement sous 48h sur paiement par carte",
      "tiers": [
        {
          "name": "Free",
          "tagline": "La plupart des utilisateurs peuvent démarrer sans carte ; les déploiements Free à risque élevé peuvent nécessiter une vérification par carte au préalable.",
          "price": "$0",
          "priceNote": "Toujours gratuit ; carte uniquement si les contrôles de risque l'exigent",
          "specs": [
            {
              "label": "vCPU",
              "value": "0.5"
            },
            {
              "label": "RAM",
              "value": "1 GB"
            },
            {
              "label": "Agents actifs",
              "value": "1"
            }
          ],
          "features": [
            "Mémoire persistante",
            "Toutes les intégrations incluses",
            "Limites d'usage équitable applicables"
          ],
          "ctaLabel": "Démarrer gratuitement"
        },
        {
          "name": "Pro",
          "tagline": "Pour un vrai travail, pas juste des expérimentations.",
          "price": "$9.99",
          "priceCadence": "/mois",
          "priceNote": "Abonnement mensuel par carte",
          "specs": [
            {
              "label": "vCPU",
              "value": "2"
            },
            {
              "label": "RAM",
              "value": "4 GB"
            },
            {
              "label": "Agents simultanés",
              "value": "3",
              "tooltip": "Combien de vos agents peuvent exécuter des tâches au même moment. Les profils sont illimités — il s'agit du plafond d'exécution simultanée."
            }
          ],
          "features": [
            "Profils d'agents illimités",
            "Tout ce qui est dans Free",
            "Priorité sur le tier Free"
          ],
          "paymentPaths": [
            {
              "label": "Carte mensuelle",
              "detail": "$9.99/mo"
            },
            {
              "label": "Annuel",
              "detail": "79 $/an carte · 49 $/an en $HermesOS"
            },
            {
              "label": "Détenir $HermesOS",
              "detail": "~99 $ (tarif de lancement, 30 premiers jours)"
            }
          ],
          "ctaLabel": "Passer à Pro"
        },
        {
          "name": "Power",
          "tagline": "Pour les workflows sérieux et les opérations multi-agents.",
          "price": "$19.99",
          "priceCadence": "/mois",
          "priceNote": "Abonnement mensuel par carte",
          "specs": [
            {
              "label": "vCPU",
              "value": "4"
            },
            {
              "label": "RAM",
              "value": "8 GB"
            },
            {
              "label": "Agents simultanés",
              "value": "Illimité",
              "tooltip": "Faites tourner autant d'agents simultanément que votre pool de compute peut en supporter — plusieurs agents travaillant en parallèle, sans plafond imposé par la plateforme."
            }
          ],
          "features": [
            "Profils d'agents illimités",
            "Tout ce qui est dans Pro",
            "CPU en rafale selon la capacité disponible"
          ],
          "paymentPaths": [
            {
              "label": "Carte mensuelle",
              "detail": "$19.99/mo"
            },
            {
              "label": "Annuel",
              "detail": "149 $/an carte · 99 $/an en $HermesOS"
            },
            {
              "label": "Détenir $HermesOS",
              "detail": "~199 $ (tarif de lancement, 30 premiers jours)"
            }
          ],
          "ctaLabel": "Passer à Power"
        }
      ]
    },
    "token": {
      "eyebrow": "À propos de $HermesOS",
      "title": "La couche d'accès à la plateforme.",
      "body": "$HermesOS vous permet de payer vos abonnements à prix réduit, de détenir des tokens pour maintenir votre tier sans paiement mensuel, ou de transacter dans l'économie d'agents au fur et à mesure de nos livraisons.",
      "secondary": "Le token n'est pas obligatoire pour utiliser Hivra — le tier gratuit reste accessible sans lui, avec des contrôles anti-abus si nécessaire. Si vous souhaitez vous impliquer davantage dans l'écosystème, détenir des $HermesOS vous offre plus de flexibilité sur la façon dont vous payez et accédez.",
      "cta": "Page de vérification du token"
    },
    "faq": {
      "eyebrow": "Questions fréquentes",
      "title": "Des réponses directes.",
      "items": [
        {
          "q": "Ma clé API est-elle en sécurité ?",
          "a": "Oui. Chiffrée au repos, injectée au déploiement via des variables d'environnement. Nous ne proxifions ni ne journalisons jamais vos requêtes IA."
        },
        {
          "q": "Les mises à jour vont-elles casser ma configuration ?",
          "a": "Non. Chaque mise à jour est testée contre les configs des conteneurs avant déploiement. Les sauvegardes quotidiennes garantissent que vous n'êtes jamais à plus de 24 heures d'une restauration propre."
        },
        {
          "q": "En quoi est-ce différent d'OpenClaw ?",
          "a": "OpenClaw est un excellent framework desktop open-source. Hivra est un environnement cloud entièrement géré, de niveau production. Hermes Agent offre une mémoire plus stable, une fiabilité accrue et des mises à jour qui ne cassent pas vos fonctionnalités existantes."
        },
        {
          "q": "Que se passe-t-il si mon agent plante ?",
          "a": "Il redémarre automatiquement. Santé, logs et utilisation des ressources toujours visibles dans le dashboard."
        },
        {
          "q": "Puis-je faire tourner plusieurs agents sur un seul plan ?",
          "a": "Oui — profils illimités par instance. Free fait tourner 1 agent actif, Pro en fait tourner 3, Power n'a pas de plafond de simultanéité. Votre pool de compute est la seule vraie limite."
        },
        {
          "q": "Quels fournisseurs IA sont supportés ?",
          "a": "OpenRouter, OpenAI et Anthropic. OpenRouter seul vous donne accès à des centaines de modèles avec une seule clé."
        },
        {
          "q": "Dois-je utiliser $HermesOS pour accéder à la plateforme ?",
          "a": "Non. Le tier Free n'en a pas besoin. Pro et Power peuvent être payés par carte. Le token vous offre des réductions et une troisième voie de paiement pour ceux qui le souhaitent."
        },
        {
          "q": "Quelle est la prochaine étape ?",
          "a": "Les Operator Packs (templates d'agents préconstruits) seront disponibles dans les prochaines semaines. Le Marketplace, les Agent Endpoints et le Hive Mind suivront. La feuille de route est sur hermesos.cloud/roadmap."
        }
      ]
    },
    "finalCta": {
      "eyebrow": "Commencez maintenant",
      "title": "Prêt à déployer ?",
      "body": "Le tier Free est en ligne avec des protections anti-abus. Pro et Power sont disponibles dès maintenant.",
      "primary": "Démarrer gratuitement",
      "secondary": "Voir les tarifs",
      "note": "La plupart des utilisateurs Free peuvent démarrer sans carte ; les inscriptions à risque élevé peuvent nécessiter une carte enregistrée.",
      "accountPrefix": "Vous avez déjà un compte ?",
      "accountLink": "Se connecter"
    },
    "getStarted": {
      "loadingCheckout": "Redirection vers le paiement...",
      "steps": {
        "choosePlan": "Choisir un plan",
        "createAccount": "Créer un compte",
        "activate": "Activer",
        "payment": "Paiement"
      },
      "badges": {
        "free": "Toujours gratuit",
        "paid": "Garantie satisfait ou remboursé 7 jours"
      },
      "yourPlan": "Votre plan",
      "perMonth": "/mois",
      "perYear": "/an",
      "cadence": {
        "monthly": "Mensuel",
        "yearly": "Annuel",
        "saveLabel": "économisez ~{percent}%",
        "saveDollarsLabel": "Économisez ~${dollars}/an"
      },
      "marketAnchor": "Les plateformes d'agents comparables démarrent autour de 19 $/mois",
      "mostPopular": "Le plus populaire",
      "freeGap": "Pas de navigation web · pas de mémoire persistante · pas de tâches planifiées · 0,5 vCPU",
      "specs": {
        "agents": "Agents",
        "cpu": "CPU",
        "ram": "RAM"
      },
      "guarantee": {
        "free": "Aucune étape de paiement requise",
        "paid": "Garantie satisfait ou remboursé 7 jours"
      },
      "switchPlan": "Changer de plan",
      "bestFit": "Meilleur choix",
      "planGuidance": {
        "free": "Free est idéal pour essayer Hermes avec un agent sécurisé. La plupart des utilisateurs peuvent démarrer sans carte ; les déploiements Free à risque élevé peuvent nécessiter une vérification par carte au préalable.",
        "operator": "Pro est idéal pour les développeurs solos, les projets de hackathon et la mise en ligne rapide d'un agent.",
        "fleet": "Power est idéal pour les workflows multi-agents, la navigation intensive et les équipes qui veulent plus de marge de compute immédiatement.",
        "command": "Command est idéal pour les charges les plus importantes, la voie de montée en charge la plus rapide et le maximum de compute par déploiement."
      },
      "createAccountTitle": "Créez votre compte.",
      "createAccountIntroFree": "Vos informations de compte deviennent vos identifiants de connexion. Après l'inscription, nous activerons votre plan Free et vous emmènerons directement au déploiement. La plupart des utilisateurs peuvent démarrer sans carte ; les déploiements Free à risque élevé peuvent nécessiter une vérification par carte au préalable.",
      "createAccountIntroPaid": "Vos informations de compte deviennent vos identifiants de connexion. Après l'inscription, vous continuerez vers le paiement sécurisé. Protégé par notre garantie satisfait ou remboursé 7 jours.",
      "legalPrefix": "En continuant, vous acceptez nos",
      "terms": "Conditions d'utilisation",
      "and": "et",
      "privacy": "Politique de confidentialité"
    },
    "dashboard": {
      "nav": {
        "chat": "Chat",
        "commandCenter": "Centre de commande",
        "home": "Accueil",
        "computers": "Ordinateurs",
        "agents": "Agents IA",
        "infrastructure": "Infrastructure système",
        "collaboration": "Coopération",
        "settings": "Paramètres",
        "launch": "Lancer",
        "ops": "Ops",
        "promptLibrary": "Bibliothèque de prompts",
        "wallet": "Portefeuille",
        "billing": "Facturation"
      },
      "sections": {
        "advanced": "Avancé",
        "support": "Assistance"
      },
      "support": {
        "discord": "Discord",
        "xTwitter": "X (Twitter)",
        "email": "Support par e-mail"
      },
      "legal": {
        "terms": "CGU",
        "privacy": "Confidentialité"
      },
      "controls": {
        "expandSidebarTitle": "Agrandir la barre latérale",
        "collapseSidebarTitle": "Réduire la barre latérale",
        "expandSidebarLabel": "Agrandir la barre latérale du dashboard",
        "collapseSidebarLabel": "Réduire la barre latérale du dashboard",
        "globalSettings": "Paramètres globaux"
      },
      "commandCenter": {
        "phase": "Phase II : Opérations de flotte",
        "titlePrefix": "Commande",
        "titleSeparator": " ",
        "titleEmphasis": "Centre",
        "titleSuffix": ".",
        "labelSeparator": " : ",
        "sections": {
          "activeAgents": "Agents actifs",
          "activeCoreInstances": "Instances Core actives",
          "infrastructureNodes": "Nœuds d'infrastructure"
        },
        "actions": {
          "advancedConsole": "Console avancée",
          "applyChanges": "Appliquer les modifications",
          "applying": "Application...",
          "cancel": "Annuler",
          "confirmRemove": "Confirmer la suppression",
          "coreConsole": "Console Core",
          "initializeAgent": "Initialiser l'agent",
          "manageAllocation": "Gérer l'allocation",
          "removeNode": "Supprimer le nœud",
          "removing": "Suppression..."
        },
        "alerts": {
          "activeFailureTitle": "Panne active nécessitant une attention",
          "activeFailurePrefix": "Hermes a détecté une panne active sur",
          "activeFailureSingular": "instance",
          "activeFailurePlural": "instances",
          "activeFailureSuffix": "Chaque élément indique désormais qui doit agir.",
          "recoveryPrefix": "Récupération",
          "updateTitle": "Mise à jour nécessitant une attention",
          "updateSummaryPrefix": "Hermes a détecté un problème de mise à jour sur",
          "updateSummarySingular": "instance",
          "updateSummaryPlural": "instances",
          "updateSummarySuffix": "Vos données Docker montées restent en place, mais ces agents nécessitent une vérification rapide.",
          "scheduledUpdateFailed": "La dernière mise à jour automatique a échoué. Vos volumes Docker restent montés, mais cette instance nécessite une vérification rapide.",
          "manualUpdateFailed": "La dernière mise à jour manuelle a échoué. Vos volumes Docker restent montés, mais cette instance nécessite une vérification rapide."
        },
        "status": {
          "running": "en cours",
          "provisioning": "provisionnement",
          "stopped": "arrêté",
          "error": "erreur",
          "failed": "échec"
        },
        "instance": {
          "activeAgentSingular": "Agent actif",
          "activeAgentPlural": "Agents actifs",
          "configuredInAgentSettings": "Configuré dans les paramètres de l'agent",
          "coreSingular": "Cœur",
          "corePlural": "Cœurs",
          "fetchingProfiles": "Récupération des profils...",
          "hostInstancePrefix": "Instance hôte",
          "idPrefix": "ID",
          "primaryAgent": "Agent principal",
          "profileNode": "Nœud de profil",
          "secondaryAgent": "Agent secondaire"
        },
        "telemetry": {
          "activeModel": "Modèle actif",
          "containerState": "État du conteneur",
          "cpuUtilization": "Utilisation CPU",
          "hostComputeNode": "Nœud de compute hôte",
          "limitPrefix": "Limite",
          "llmInferenceEngine": "Moteur d'inférence LLM",
          "memoryAllocation": "Allocation mémoire",
          "networkIo": "E/S réseau",
          "provider": "Fournisseur",
          "providerPrefix": "Fournisseur",
          "totalTxPrefix": "Tx total",
          "unrestricted": "SANS RESTRICTION",
          "uptimePrefix": "Disponibilité"
        },
        "allocation": {
          "cpuAllocated": "CPU alloué",
          "cpuAllocation": "Allocation CPU",
          "cpuCapacityError": "L'allocation CPU totale ({allocated}) dépasse la capacité du nœud ({capacity}).",
          "dangerZone": "Zone de danger",
          "deleteConfirmationPhrase": "supprimer",
          "deletePromptPrefix": "Tapez",
          "deletePromptSuffix": "pour confirmer la suppression. Cela détruira définitivement l'infrastructure et tous les agents hors ligne qu'elle héberge.",
          "failedToRemoveHost": "Échec de la suppression de l'hôte",
          "memoryAllocated": "Mémoire allouée",
          "memoryAllocation": "Allocation mémoire (RAM)",
          "memoryCapacityError": "L'allocation mémoire totale ({allocated}GB) dépasse la capacité du nœud ({capacity}GB).",
          "noActiveAgents": "Aucun agent actif sur ce nœud.",
          "nodeAllocationPrefix": "Allocation du nœud",
          "projectedNodeUsage": "Utilisation projetée du nœud"
        },
        "errors": {
          "failedToLoadOperations": "Échec du chargement des données d'opérations"
        }
      },
      "library": {
        "returnToCommandCenter": "Retour au centre de commande",
        "titlePrefix": "Bibliothèque",
        "titleSeparator": " de ",
        "titleEmphasis": "prompts",
        "titleSuffix": ".",
        "intro": "Déployez des templates d'agents hautement spécialisés avec des prompts système éprouvés. Sélection issue du blueprint premium Agency.",
        "sourcePrefix": "Templates généreusement fournis par",
        "sourceLinkLabel": "Michal Sitarzewski's Agency Agents",
        "sourceSuffix": ".",
        "searchPlaceholder": "Rechercher par nom ou description...",
        "featured": "Mis en avant",
        "allTemplates": "Tous les modèles",
        "viewPrompt": "Voir le prompt",
        "deploy": "Déployer",
        "empty": "Aucun template ne correspond à vos critères",
        "copied": "Copié !",
        "copyPrompt": "Copier le prompt",
        "deployTemplate": "Déployer ce modèle",
        "closePreview": "Fermer l'aperçu du prompt",
        "categories": {
          "All": "Tout",
          "Engineering": "Ingénierie",
          "Design": "Design",
          "Marketing": "Marketing",
          "Product": "Produit",
          "Operations": "Opérations",
          "Research": "Recherche",
          "Security": "Sécurité",
          "Finance": "Finance"
        }
      },
      "wallet": {
        "eyebrowLegacy": "Portefeuille · Dépôt & retrait",
        "eyebrowSelfCustody": "Portefeuille · Signature de vérification",
        "titlePrefix": "Votre",
        "titleSeparator": " portefeuille ",
        "titleEmphasis": "$HermesOS",
        "titleSuffix": ".",
        "legacyIntroStrong": "Portefeuille de garde grandfathered",
        "legacyIntroBody": "votre flux de dépôt et de retrait existant reste actif. Verrouillez le prix $HERMESOS d'aujourd'hui pour le tier souhaité, puis envoyez le montant indiqué à votre adresse de dépôt. Le tier Free fonctionne toujours sans dépôt.",
        "selfCustodyIntroStrong": "Connectez votre propre portefeuille",
        "selfCustodyIntroBody": "détenez $HermesOS et VVV vous-même, puis signez un message pour prouver votre propriété. Le tier Free fonctionne toujours sans vérification de token.",
        "priceUnavailable": "Prix du token indisponible — veuillez réessayer plus tard.",
        "buyToken": {
          "ariaLabel": "Acheter $HermesOS",
          "eyebrow": "Obtenir $HermesOS",
          "title": "Acheter sur Uniswap (réseau Base).",
          "action": "Acheter sur Uniswap →",
          "contractLabel": "Adresse du contrat (Base)",
          "copyContractLabel": "Copier l'adresse du contrat",
          "copied": "Copié",
          "copy": "Copier",
          "warningPrefix": "Vérifiez toujours l'adresse du contrat sur",
          "warningLink": "hermesos.cloud/token",
          "warningSuffix": "avant d'envoyer des fonds. Ignorez les adresses copiées depuis des DMs, réponses ou captures d'écran."
        },
        "verification": {
          "ariaLabel": "Vérification du portefeuille",
          "eyebrow": "Vérification auto-custody",
          "connectedTitle": "Portefeuille connecté.",
          "disconnectedTitle": "Vérifiez depuis votre portefeuille.",
          "activeWallet": "Portefeuille actif",
          "lastCheckedPrefix": "Dernière vérification",
          "connecting": "Connexion...",
          "checking": "Vérification...",
          "connectWallet": "Connecter le portefeuille",
          "changeWallet": "Changer de portefeuille",
          "refreshBalance": "Actualiser le solde",
          "checkLock": "Vérifier le verrou {tier}",
          "lockPrice": "Verrouiller le prix {tier}",
          "lockedFor20": "Prix {tier} verrouillé pour 20 minutes à",
          "holdAtLeastThatAmount": "Détenez au moins ce montant dans ce portefeuille avant l'expiration du verrou.",
          "yourRateLockedAt": "Votre tarif {tier} est verrouillé à",
          "lockNext": "Verrouillez le prix {tier} ensuite si vous souhaitez ce tier.",
          "keepEligible": "Conservez ce montant dans ce portefeuille pour rester éligible.",
          "detected": "Détecté",
          "snapshotInstruction": "Verrouillez le prix {tier} pour capturer le montant de tokens pendant 20 minutes.",
          "refreshInstruction": "Actualisez le solde pour confirmer votre tier actuel.",
          "connectedFootnote": "Un seul portefeuille peut être actif à la fois. Changer de portefeuille remplace le portefeuille actif ; les signatures ne peuvent pas déplacer des tokens.",
          "disconnectedBody": "Conservez $HermesOS et VVV dans votre propre portefeuille Base. Un message signé prouve la propriété sans envoyer de tokens à Hivra.",
          "verifiedSuffix": "vérifié."
        },
        "eligibility": {
          "ariaLabel": "Éligibilité au tier",
          "eyebrow": "Éligibilité au tier",
          "currentBalancePrefix": "Solde actuel :",
          "autoRefreshPrefix": "Actualisation automatique toutes les 5 min · dernière vérification",
          "refreshBalanceLabel": "Actualiser le solde",
          "refresh": "Actualiser",
          "thresholdsMissing": "Les seuils de tier n'ont pas encore été configurés. L'éligibilité n'est pas évaluée. Revenez quand le flux de dépôt sera disponible.",
          "proTier": "Tier Pro",
          "powerTier": "Tier Power",
          "eligible": "Éligible",
          "breached": "Seuil franchi — éligibilité terminée",
          "notYetEligible": "Pas encore éligible",
          "holdAtLeast": "Détenir au moins",
          "depositAtLeast": "Déposer au moins",
          "selfCustodyQualifySuffix": "dans votre portefeuille vérifié pour être éligible au tier {tier} sans abonnement.",
          "custodyQualifySuffix": "pour être éligible au tier {tier} sans abonnement.",
          "lockedAtPrice": "Verrouillé au prix que vous avez demandé — se réinitialise à l'expiration du devis."
        },
        "agentWallets": {
          "ariaLabel": "Portefeuilles des agents",
          "title": "Portefeuilles d’agents.",
          "subtitle": "Un portefeuille par agent · Votre propre compte Bankr · Base uniquement",
          "emptyNoAgents": "Lancez un agent, puis connectez votre propre compte Bankr pour lui donner un portefeuille.",
          "deployAgent": "Déployer un agent",
          "runningEmpty": "Les agents en cours d'exécution apparaîtront ici."
        }
      },
      "billing": {
        "eyebrow": "Facturation et abonnement",
        "titlePrefix": "Gestion",
        "titleSeparator": " du ",
        "titleEmphasis": "plan",
        "titleSuffix": ".",
        "subtitle": "Votre offre, votre mode de paiement et votre consommation.",
        "refreshing": "Actualisation…",
        "credits": {
          "title": "Solde de crédits",
          "available": "disponibles",
          "description": "Les crédits du compte paient l'utilisation. Ils ne définissent pas votre offre : elle vient d'un abonnement, d'un paiement annuel en $HermesOS ou de la détention de $HermesOS.",
          "monthlyGrantSuffix": "crédits du plan mensuel"
        },
        "activity": {
          "eyebrow": "Activité de facturation",
          "title": "Mouvements de compte récents",
          "loading": "Chargement",
          "ledger": "Grand livre",
          "ledgerLoading": "Chargement du grand livre...",
          "ledgerEmpty": "Aucune entrée dans le grand livre pour l'instant.",
          "payments": "Paiements",
          "paymentsLoading": "Chargement des paiements...",
          "paymentsEmpty": "Aucun paiement pour l'instant.",
          "compute": "Calcul",
          "computeLoading": "Chargement du compute...",
          "computeEmpty": "Aucune utilisation compute pour l'instant.",
          "llm": "LLM",
          "llmLoading": "Chargement LLM...",
          "llmEmpty": "Aucune utilisation LLM pour l'instant."
        },
        "tokenAccess": {
          "eyebrow": "Accès par token",
          "title": "Détention $HermesOS",
          "description": "Détenez au moins le minimum de $HermesOS dans un portefeuille vérifié pour débloquer une machine de base. Si votre solde passe sous le minimum, les agents de cette machine continuent de tourner pendant une période de grâce, puis se mettent en pause jusqu'à ce que vous déteniez de nouveau assez.",
          "checking": "Vérification",
          "unavailable": "Indisponible",
          "ready": "Minimum atteint",
          "belowMinimum": "Sous le minimum",
          "noWallet": "Aucun portefeuille vérifié",
          "wallet": "Portefeuille",
          "balance": "Solde",
          "minimum": "Minimum",
          "notVerified": "Non vérifié",
          "noSnapshot": "Aucun snapshot",
          "refresh": "Actualiser le statut du token",
          "refreshing": "Actualisation...",
          "connectWallet": "Connecter un portefeuille",
          "connecting": "Connexion...",
          "verifyDifferent": "Vérifier un autre portefeuille"
        },
        "cryptoCredits": {
          "eyebrow": "Crédits crypto",
          "description": "Choisissez un montant et nous vous donnerons une adresse où envoyer des USDC sur Base. Les crédits sont ajoutés une fois le transfert confirmé.",
          "bonusPath": "Voie bonus préparée",
          "pendingDeposit": "Dépôt en attente",
          "createTopUpLabel": "Créer une recharge USDC pour {credits} crédits",
          "sendPrefix": "Envoyer",
          "onNetwork": "sur",
          "reference": "Référence"
        },
        "activePlan": {
          "title": "Plan actuel",
          "heldViaTokens": "DÉTENU VIA $HERMESOS",
          "perMonth": "/mois",
          "agents": "Agents",
          "cpuBudget": "Budget CPU",
          "ramBudget": "Budget RAM",
          "manageSubscription": "Gérer l’abonnement",
          "opening": "Ouverture..."
        },
        "switcher": {
          "title": "Changer de plan",
          "description": "Montez en gamme à tout moment. Les rétrogradations ne sont pas disponibles — les serveurs dédiés ne peuvent pas être réduits.",
          "currentPlan": "Plan actuel",
          "upgrade": "Mettre à niveau",
          "lowerTier": "Tier inférieur",
          "unlimited": "Illimité",
          "agents": "agents",
          "active": "Actif",
          "guarantee": "Politique de remboursement 48h · Plans avec upgrade uniquement"
        },
        "noSubscription": {
          "title": "Aucun abonnement actif"
        },
        "plate": {
          "slots": "Emplacements",
          "vcpu": "vCPU",
          "memory": "Mémoire",
          "idlePolicy": "Mise en veille",
          "alwaysOn": "Toujours actif",
          "sleepsAfterIdle": "En veille après {days} jours d'inactivité"
        }
      },
      "settings": {
        "loading": "Chargement...",
        "returnToCommandCenter": "Retour au centre de commande",
        "titlePrefix": "Paramètres",
        "titleSeparator": " ",
        "titleEmphasis": "globaux",
        "titleSuffix": ".",
        "intro": "Configurez votre espace de travail, les thèmes d'interface et le comportement de l'application.",
        "sections": {
          "appearance": "Apparence",
          "chatInterface": "Interface Chat & Agent",
          "capabilities": "Capacités & Plugins",
          "dangerZone": "Zone de danger"
        },
        "theme": {
          "label": "Thème",
          "description": "Clair, sombre ou comme votre appareil.",
          "light": "Clair",
          "dark": "Sombre",
          "system": "Système"
        },
        "language": {
          "label": "Langue du site",
          "description": "Choisissez la langue utilisée dans Hivra."
        },
        "reducedMotion": {
          "label": "Mouvement réduit",
          "description": "Minimiser les transitions et les animations d'interface lourdes."
        },
        "autoScroll": {
          "label": "Défilement automatique du chat",
          "description": "Ancrer automatiquement en bas à l'arrivée de nouveaux messages."
        },
        "streamingAnimations": {
          "label": "Animations de streaming",
          "description": "Afficher les effets Markdown en fondu lors de la réception de flux d'agents."
        },
        "aiReasoning": {
          "label": "Développer le raisonnement IA",
          "description": "Démarrer avec le bloc \"Réflexion\" de l'IA automatiquement développé."
        },
        "persistentMemory": {
          "label": "Activer la mémoire persistante",
          "description": "Autoriser Hermes à écrire ses propres mémorisations dans MEMORY.md entre les sessions en utilisant le fournisseur de mémoire modulaire."
        },
        "plugins": {
          "label": "Activer les plugins / compétences extensibles",
          "description": "Donner à Hermes accès aux compétences MCP/ACP upstream et aux outils expérimentaux."
        },
        "clearCache": {
          "label": "Vider le cache local",
          "description": "Efface les données du tableau de bord en cache dans ce navigateur et les choix de mise en page enregistrés ici, comme les onglets du terminal, puis recharge la page. Votre compte, vos agents et vos ordinateurs ne sont pas affectés.",
          "action": "Vider le cache"
        },
        "hub": {
          "title": "Paramètres",
          "intro": "Votre compte, la facturation, les clés et les outils de vos agents, ainsi que l'apparence de Hivra dans ce navigateur.",
          "groups": {
            "account": "Compte",
            "billing": "Offre et facturation",
            "connections": "Clés et connexions",
            "toolkit": "Boîte à outils des agents",
            "device": "Sur cet appareil",
            "apps": "Applis et aide",
            "reset": "Réinitialiser ce navigateur"
          },
          "profile": {
            "title": "Profil et connexion",
            "signedInAs": "Connecté en tant que {email}",
            "fallback": "Votre nom, votre e-mail, la sécurité et la déconnexion.",
            "selfHostTitle": "Connexion",
            "selfHostFallback": "Connecté à cette instance Hivra auto-hébergée.",
            "signOut": "Se déconnecter",
            "signingOut": "Déconnexion…",
            "signOutFailed": "Impossible de se déconnecter. Réessayez."
          },
          "rows": {
            "billing": { "description": "Offre, moyens de paiement, crédits et factures" },
            "wallets": { "title": "Portefeuilles", "description": "Portefeuilles des agents et accès $HermesOS" },
            "apiKeys": { "title": "Clés API", "description": "Clés des fournisseurs et agents qui les utilisent" },
            "infrastructure": { "description": "Les machines et comptes cloud sur lesquels tournent vos agents" },
            "memory": { "title": "Mémoire partagée des agents", "description": "Ce que chaque nouvel agent sait dès le départ" },
            "tools": { "title": "Outils et capacités", "description": "Ajoutez des outils aux agents de votre choix" },
            "library": { "title": "Bibliothèque de prompts", "description": "Rôles d'agent prêts à l'emploi avec des prompts éprouvés" },
            "templates": { "title": "Modèles", "description": "Enregistrez un agent configuré et relancez-le" },
            "referral": { "title": "Parrainer et gagner", "description": "Partagez votre lien et gagnez des crédits ensemble" },
            "applications": { "title": "Applis", "description": "Utilisez Hivra dans votre navigateur ou comme appli web" },
            "help": { "title": "Aide", "description": "Assistance, communauté et informations légales" }
          },
          "motionNote": "Les animations suivent le réglage « Réduire les animations » de votre appareil.",
          "clearCacheConfirm": "Appuyez à nouveau pour vider et recharger",
          "clearCacheArmed": "Appuyez à nouveau sur le bouton dans les 4 secondes pour vider le cache et recharger."
        }
      },
      "userModeSuffix": "Mode",
      "versionLabel": "Foundation v0.9.0"
    },
    "stats": {
      "hero": {
        "eyebrow": "En direct · agents déployés",
        "label": "déployés au total",
        "fullStats": "Statistiques complètes →"
      },
      "page": {
        "eyebrow": "Compteur en direct",
        "headlinePrefix": "Agents",
        "headlineEmphasis": "déployés",
        "headlineSuffix": "sur Hivra",
        "body": "Chaque fois qu'un agent est déployé avec succès, ce compteur s'incrémente.",
        "allTimeLabel": "Déploiements réussis au total",
        "ariaTotal": "agents déployés au total",
        "cards": {
          "last24h": "Dernières 24 heures",
          "last7d": "Derniers 7 jours",
          "firstDeploy": "Premier déploiement"
        },
        "sparkline": {
          "titlePrefix": "Déploiements quotidiens,",
          "titleEmphasis": "derniers 30 jours",
          "hint": "Survolez ou focalisez une barre pour le total exact",
          "peak": "jour record",
          "total": "total 30 jours",
          "barLabel": "{date} : {count} déploiements"
        },
        "cta": {
          "button": "Déployez votre agent →",
          "subtitle": "Niveau gratuit — 1 agent, 0,5 vCPU, 1 Go RAM"
        }
      }
    },
    "footer": {
      "links": {
        "features": "Fonctionnalités",
        "compare": "Comparer",
        "blog": "Blog",
        "roadmap": "Feuille de route",
        "tokenVerification": "Vérification du token",
        "privacy": "Confidentialité",
        "terms": "Conditions"
      }
    }
  },
  "de": {
    "localeLabel": "Deutsch",
    "languageSelectorLabel": "Sprache",
    "nav": {
      "pricing": "Preise",
      "roadmap": "Roadmap",
      "tokenVerification": "Token-Verifizierung",
      "register": "Registrieren",
      "login": "Anmelden",
      "openDashboard": "Dashboard öffnen",
      "mobileMenu": "Menü öffnen",
      "closeMobileMenu": "Menü schließen"
    },
    "hero": {
      "eyebrow": "Jetzt live",
      "headlinePrefix": "Deine KI-Agenten,",
      "headlineEmphasis": "immer aktiv.",
      "primary": "Hivra startet deinen Hermes-Agenten in unter 5 Minuten, mit persistentem Gedächtnis, Browser-Automatisierung und Tools.",
      "secondary": "Der Free-Tarif ist live. Pro und Power sind für ernsthafte Workloads verfügbar.",
      "primaryCta": "Kostenlos starten",
      "secondaryCta": "So funktioniert es",
      "proofPoints": [
        "Free-Tarif dauerhaft",
        "Eigener Key, kein Aufschlag",
        "Auf Hermes Agent gebaut"
      ]
    },
    "ticker": {
      "proofPoints": [
        "Basiert auf Hermes Agent (Nous Research)",
        "Eigener API-Key, kein Aufschlag",
        "Free-Tier immer verfügbar"
      ]
    },
    "positioning": {
      "title": "OpenClaw vergisst. Hermes wächst.",
      "body": "Von Nous Research entwickelt, läuft Hermes auf einem Server und erinnert sich an alles — Projekte, Einstellungen, gelernte Lektionen. Jede Session macht ihn schärfer. Self-Hosting kostet die meisten ein Wochenende.",
      "punchline": "Hivra macht daraus 5 Minuten."
    },
    "features": {
      "eyebrow": "Was enthalten ist",
      "titlePrefix": "Alles, was dein Agent braucht.",
      "titleEmphasis": "Nichts, was du nicht brauchst.",
      "items": [
        {
          "headline": "Null Konfiguration. Voller Stack.",
          "body": "Browser-Automatisierung, Tool-Nutzung, Terminal, Memory und cron — vorkonfiguriert. Kein Docker, kein StackOverflow um Mitternacht."
        },
        {
          "headline": "Multi-Agent vom ersten Tag an.",
          "body": "Unbegrenzte Agent-Profile auf einer Instanz. Researcher, Operators, Spezialisten — kein Aufpreis pro Agent."
        },
        {
          "headline": "Dein Key. Kein Aufschlag.",
          "body": "OpenRouter, OpenAI oder Anthropic. Verschlüsselt gespeichert, beim Deploy injiziert. Wir sehen deine KI-Ausgaben nie."
        },
        {
          "headline": "Überall chatten.",
          "body": "Eingebautes Dashboard mit Streaming. Telegram, Discord, Slack oder WhatsApp verbinden — out of the box."
        },
        {
          "headline": "OpenClaw-Migration inklusive.",
          "body": "Dein bestehendes Setup, Prompts und Skills werden vollständig übernommen. Kein Neustart von vorne."
        },
        {
          "headline": "Stabil. Wiederherstellbar. Always on.",
          "body": "Updates werden vor dem Rollout gegen deine Konfiguration getestet. Auto-Neustart bei Ausfall. Tägliche Backups — nie mehr als 24 Stunden von einem sauberen Restore entfernt."
        }
      ]
    },
    "howItWorks": {
      "eyebrow": "So funktioniert es",
      "titlePrefix": "Drei Schritte.",
      "titleEmphasis": "Kein Terminal nötig.",
      "steps": [
        {
          "step": "1",
          "headline": "Tier wählen",
          "body": "Kostenlos starten, upgraden wenn du mehr brauchst. Monatlich per Karte zahlen, jährlich für Rabatt — oder $HermesOS halten, um Zugang ohne Abo zu behalten."
        },
        {
          "step": "2",
          "headline": "AI-Key hinzufügen",
          "body": "OpenRouter-, OpenAI- oder Anthropic-Key einmal einfügen. Verschlüsselt, injiziert, fertig."
        },
        {
          "step": "3",
          "headline": "Deploy. Chatten. Automatisieren.",
          "body": "Dein Agent ist in Minuten live — Chat, Terminal, Monitoring. Telegram oder Discord verbinden und er folgt dir überallhin."
        }
      ],
      "footer": "Bereit, vom Lesen zum Einrichten zu wechseln? Tier wählen und direkt zur Kontoerstellung.",
      "cta": "Tier wählen"
    },
    "useCases": {
      "eyebrow": "Anwendungsfälle",
      "titlePrefix": "Was macht ein 24/7-Agent",
      "titleEmphasis": "mit Memory wirklich?",
      "intro": "Browsen, coden, Dateien verwalten, APIs aufrufen, cron-Tasks ausführen — autonom. Und er erinnert sich, was er letzte Woche gelernt hat.",
      "items": [
        {
          "headline": "DevOps & Monitoring",
          "body": "Liest Logs, startet fehlerhafte Dienste neu, benachrichtigt dich nur wenn ein Mensch wirklich gebraucht wird. Kennt deinen Stack."
        },
        {
          "headline": "Recherche & Wettbewerbsanalyse",
          "body": "Thema und Deadline angeben. Er browst, aggregiert und liefert ein strukturiertes Briefing — und speichert das Gelernte für das nächste Mal."
        },
        {
          "headline": "Hintergrundautomatisierung",
          "body": "E-Mail-Triage, Planung, API-Aufrufe, Tabellen — alles Repetitive. Läuft per cron während du schläfst."
        },
        {
          "headline": "Customer-Support-Triage",
          "body": "Deine Docs rein. Er löst häufige Tickets, eskaliert die schwierigen und wird mit jedem Gespräch besser."
        }
      ],
      "footer": "Siehst du die Arbeit, die Hermes dir abnehmen kann? Plan wählen und den passenden Workflow starten.",
      "cta": "Pläne ansehen & starten"
    },
    "whatsComing": {
      "eyebrow": "Was kommt als Nächstes",
      "titlePrefix": "Das ist erst",
      "titleEmphasis": "der Anfang.",
      "intro": "Das Hosting ist das Fundament. Bald verfügbar:",
      "items": [
        {
          "title": "Operator Packs",
          "body": "Vorgefertigte Agent-Templates für spezifische Aufgaben — Research, Trading-Insights, Content-Automatisierung. Mit einem Klick deployen."
        },
        {
          "title": "Marketplace",
          "body": "Operator Packs bauen, an die Community ausliefern, an der Nutzung verdienen. Abgerechnet in $HermesOS."
        },
        {
          "title": "Agent Endpoints",
          "body": "Deinen Agenten als aufrufbares API exponieren. Andere Agenten zahlen dir pro Request."
        },
        {
          "title": "Hive Mind",
          "body": "Agenten teilen, was sie lernen. Das gesamte Netzwerk wird gemeinsam klüger."
        }
      ],
      "footer": "Hivra ist die Infrastruktur für eine Agent-Ökonomie. Hosting ist Schritt eins. Alles andere baut darauf auf."
    },
    "pricing": {
      "eyebrow": "Preise",
      "titlePrefix": "Einfache Pläne.",
      "titleEmphasis": "Ernsthaftes Compute.",
      "intro": "Dediziertes Compute. Unbegrenzte Agent-Profile. Eigener Key, kein Aufschlag.",
      "compute": "Rechenleistung",
      "mostPopular": "Beliebteste Wahl",
      "forPros": "Für Profis",
      "getStarted": "Loslegen",
      "recommended": "Empfohlen",
      "accessPrefix": "Drei Zugangswege",
      "footnote": "Bis zu 40 % sparen bei Zahlung mit $HermesOS. Launch-Preise für die erste Welle — können sich mit Reife der Plattform ändern.",
      "guarantee": "Free-Tier — erst testen, dann upgraden · 48-Std.-Rückerstattung bei Kartenzahlung",
      "tiers": [
        {
          "name": "Free",
          "tagline": "Die meisten Nutzer können ohne Karte starten; bei höherem Risiko im Free-Tier kann eine Kartenverifizierung erforderlich sein.",
          "price": "$0",
          "priceNote": "Immer kostenlos; Karte nur wenn Risikoprüfung es verlangt",
          "specs": [
            {
              "label": "vCPU",
              "value": "0.5"
            },
            {
              "label": "RAM",
              "value": "1 GB"
            },
            {
              "label": "Aktive Agenten",
              "value": "1"
            }
          ],
          "features": [
            "Persistentes Memory",
            "Alle Integrationen inklusive",
            "Fair-Use-Limits gelten"
          ],
          "ctaLabel": "Kostenlos starten"
        },
        {
          "name": "Pro",
          "tagline": "Für echte Arbeit, nicht nur Experimente.",
          "price": "$9.99",
          "priceCadence": "/Monat",
          "priceNote": "Monatliches Abo per Karte",
          "specs": [
            {
              "label": "vCPU",
              "value": "2"
            },
            {
              "label": "RAM",
              "value": "4 GB"
            },
            {
              "label": "Parallele Agenten",
              "value": "3",
              "tooltip": "Wie viele deiner Agenten gleichzeitig Tasks ausführen können. Profile sind unbegrenzt — das ist das Live-Execution-Limit."
            }
          ],
          "features": [
            "Unbegrenzte Agent-Profile",
            "Alles aus Free",
            "Vorrang gegenüber Free-Tier"
          ],
          "paymentPaths": [
            {
              "label": "Monatlich per Karte",
              "detail": "$9.99/mo"
            },
            {
              "label": "Jährlich",
              "detail": "$79/Jahr Karte · $49/Jahr in $HermesOS"
            },
            {
              "label": "$HermesOS halten",
              "detail": "~$99 (Einführungspreis, erste 30 Tage)"
            }
          ],
          "ctaLabel": "Pro holen"
        },
        {
          "name": "Power",
          "tagline": "Für anspruchsvolle Workflows und Multi-Agent-Betrieb.",
          "price": "$19.99",
          "priceCadence": "/Monat",
          "priceNote": "Monatliches Abo per Karte",
          "specs": [
            {
              "label": "vCPU",
              "value": "4"
            },
            {
              "label": "RAM",
              "value": "8 GB"
            },
            {
              "label": "Parallele Agenten",
              "value": "Unbegrenzt",
              "tooltip": "So viele Agenten gleichzeitig ausführen, wie dein Compute-Pool unterstützt — mehrere Agenten arbeiten parallel, kein plattformseitiges Limit."
            }
          ],
          "features": [
            "Unbegrenzte Agent-Profile",
            "Alles aus Pro",
            "Burst-CPU wenn Kapazität verfügbar"
          ],
          "paymentPaths": [
            {
              "label": "Monatlich per Karte",
              "detail": "$19.99/mo"
            },
            {
              "label": "Jährlich",
              "detail": "$149/Jahr Karte · $99/Jahr in $HermesOS"
            },
            {
              "label": "$HermesOS halten",
              "detail": "~$199 (Einführungspreis, erste 30 Tage)"
            }
          ],
          "ctaLabel": "Power holen"
        }
      ]
    },
    "token": {
      "eyebrow": "Über $HermesOS",
      "title": "Die Zugriffsschicht der Plattform.",
      "body": "$HermesOS ermöglicht es, Abos mit Rabatt zu bezahlen, das Tier ohne monatliche Zahlung zu halten oder Transaktionen in der Agent-Ökonomie abzuwickeln, sobald wir sie ausliefern.",
      "secondary": "Das Token ist für die Nutzung von Hivra nicht erforderlich — der Free-Tier bleibt ohne Token verfügbar, mit Anti-Abuse-Prüfungen wo nötig. Wer tiefer ins Ökosystem einsteigen will, erhält durch das Halten von $HermesOS mehr Flexibilität bei Zahlung und Zugang.",
      "cta": "Token-Verifizierungsseite"
    },
    "faq": {
      "eyebrow": "Häufige Fragen",
      "title": "Klare Antworten.",
      "items": [
        {
          "q": "Ist mein API-Key sicher?",
          "a": "Ja. Verschlüsselt gespeichert, beim Deploy per Umgebungsvariablen injiziert. Wir proxen oder loggen deine KI-Anfragen nie."
        },
        {
          "q": "Können Updates mein Setup kaputt machen?",
          "a": "Nein. Jedes Update wird vor der Auslieferung gegen Container-Konfigurationen getestet. Tägliche Backups bedeuten, dass du nie mehr als 24 Stunden von einem sauberen Restore entfernt bist."
        },
        {
          "q": "Was ist der Unterschied zu OpenClaw?",
          "a": "OpenClaw ist ein exzellentes Open-Source-Desktop-Framework. Hivra ist eine vollständig verwaltete, produktionsreife Cloud-Umgebung. Hermes Agent hat stabileres Memory, höhere Zuverlässigkeit und Updates, die bestehende Features nicht brechen."
        },
        {
          "q": "Was passiert, wenn mein Agent abstürzt?",
          "a": "Er startet automatisch neu. Zustand, Logs und Ressourcenverbrauch sind im Dashboard jederzeit sichtbar."
        },
        {
          "q": "Kann ich mehrere Agenten auf einem Plan betreiben?",
          "a": "Ja — unbegrenzte Profile pro Instanz. Free führt 1 aktiven Agenten aus, Pro 3, Power hat kein paralleles Limit. Dein Compute-Pool ist die einzige echte Grenze."
        },
        {
          "q": "Welche KI-Anbieter werden unterstützt?",
          "a": "OpenRouter, OpenAI und Anthropic. OpenRouter allein gibt dir Hunderte von Modellen mit einem einzigen Key."
        },
        {
          "q": "Muss ich $HermesOS verwenden, um auf die Plattform zuzugreifen?",
          "a": "Nein. Der Free-Tier erfordert es nicht. Pro und Power können per Karte bezahlt werden. Das Token bietet Rabatte und einen dritten Zahlungsweg für alle, die ihn nutzen möchten."
        },
        {
          "q": "Was kommt als Nächstes?",
          "a": "Operator Packs (vorgefertigte Agent-Templates) erscheinen in den nächsten Wochen. Marketplace, Agent Endpoints und Hive Mind folgen. Die Roadmap ist auf hermesos.cloud/roadmap."
        }
      ]
    },
    "finalCta": {
      "eyebrow": "Jetzt starten",
      "title": "Bereit zum Deployen?",
      "body": "Free-Tier ist live mit Abuse-Schutz. Pro und Power sind jetzt verfügbar.",
      "primary": "Kostenlos starten",
      "secondary": "Preise ansehen",
      "note": "Die meisten Free-Nutzer können ohne Karte starten; bei höherem Risiko kann eine Karte hinterlegt werden müssen.",
      "accountPrefix": "Bereits ein Konto?",
      "accountLink": "Anmelden"
    },
    "getStarted": {
      "loadingCheckout": "Weiterleitung zum Checkout...",
      "steps": {
        "choosePlan": "Plan wählen",
        "createAccount": "Konto erstellen",
        "activate": "Aktivieren",
        "payment": "Zahlung"
      },
      "badges": {
        "free": "Immer kostenlos",
        "paid": "7-Tage-Geld-zurück-Garantie"
      },
      "yourPlan": "Dein Plan",
      "perMonth": "/Monat",
      "perYear": "/Jahr",
      "cadence": {
        "monthly": "Monatlich",
        "yearly": "Jährlich",
        "saveLabel": "spare ~{percent}%",
        "saveDollarsLabel": "Spare ~${dollars}/Jahr"
      },
      "marketAnchor": "Vergleichbare Agent-Plattformen beginnen bei rund 19 $/Monat",
      "mostPopular": "Am beliebtesten",
      "freeGap": "Kein Web-Browsing · kein persistentes Gedächtnis · keine geplanten Aufgaben · 0,5 vCPU",
      "specs": {
        "agents": "Agenten",
        "cpu": "CPU",
        "ram": "RAM"
      },
      "guarantee": {
        "free": "Kein Checkout erforderlich",
        "paid": "7-Tage-Geld-zurück-Garantie"
      },
      "switchPlan": "Plan wechseln",
      "bestFit": "Beste Wahl",
      "planGuidance": {
        "free": "Free eignet sich am besten, um Hermes mit einem gesicherten Agenten auszuprobieren. Die meisten Nutzer können ohne Karte starten; bei höherem Risiko im Free-Tier kann eine Kartenverifizierung nötig sein.",
        "operator": "Pro ist ideal für Solo-Entwickler, Hackathon-Projekte und den schnellen Start mit einem Agenten.",
        "fleet": "Power ist optimal für Multi-Agent-Workflows, intensiveres Browsen und Teams, die sofort mehr Compute-Headroom benötigen.",
        "command": "Command eignet sich am besten für die größten Workloads, den schnellsten Skalierungspfad und maximales Compute pro Deployment."
      },
      "createAccountTitle": "Konto erstellen.",
      "createAccountIntroFree": "Deine Kontodaten werden zu deinen Login-Zugangsdaten. Nach der Registrierung aktivieren wir deinen Free-Plan und leiten dich direkt zum Deployment weiter. Die meisten Nutzer können ohne Karte starten; bei höherem Risiko im Free-Tier kann eine Kartenverifizierung nötig sein.",
      "createAccountIntroPaid": "Deine Kontodaten werden zu deinen Login-Zugangsdaten. Nach der Registrierung geht es zum sicheren Checkout. Geschützt durch unsere 7-Tage-Geld-zurück-Garantie.",
      "legalPrefix": "Mit dem Fortfahren stimmst du unseren",
      "terms": "Nutzungsbedingungen",
      "and": "und der",
      "privacy": "Datenschutzrichtlinie"
    },
    "dashboard": {
      "nav": {
        "chat": "Chat",
        "commandCenter": "Kommandozentrale",
        "home": "Startseite",
        "computers": "Computer",
        "agents": "Agenten",
        "infrastructure": "Infrastruktur",
        "collaboration": "Zusammenarbeit",
        "settings": "Einstellungen",
        "launch": "Starten",
        "ops": "Ops",
        "promptLibrary": "Prompt-Bibliothek",
        "wallet": "Wallet",
        "billing": "Abrechnung"
      },
      "sections": {
        "advanced": "Erweitert",
        "support": "Support"
      },
      "support": {
        "discord": "Discord",
        "xTwitter": "X (Twitter)",
        "email": "E-Mail-Support"
      },
      "legal": {
        "terms": "Nutzungsbedingungen",
        "privacy": "Datenschutz"
      },
      "controls": {
        "expandSidebarTitle": "Seitenleiste ausklappen",
        "collapseSidebarTitle": "Seitenleiste einklappen",
        "expandSidebarLabel": "Dashboard-Seitenleiste ausklappen",
        "collapseSidebarLabel": "Dashboard-Seitenleiste einklappen",
        "globalSettings": "Globale Einstellungen"
      },
      "commandCenter": {
        "phase": "Phase II: Flottenbetrieb",
        "titlePrefix": "Kommando",
        "titleSeparator": " ",
        "titleEmphasis": "Zentrale",
        "titleSuffix": ".",
        "labelSeparator": ": ",
        "sections": {
          "activeAgents": "Aktive Agenten",
          "activeCoreInstances": "Aktive Core-Instanzen",
          "infrastructureNodes": "Infrastruktur-Nodes"
        },
        "actions": {
          "advancedConsole": "Erweiterte Konsole",
          "applyChanges": "Änderungen anwenden",
          "applying": "Wird angewendet...",
          "cancel": "Abbrechen",
          "confirmRemove": "Entfernung bestätigen",
          "coreConsole": "Core-Konsole",
          "initializeAgent": "Agent initialisieren",
          "manageAllocation": "Zuteilung verwalten",
          "removeNode": "Node entfernen",
          "removing": "Wird entfernt..."
        },
        "alerts": {
          "activeFailureTitle": "Aktiver Fehler erfordert Aufmerksamkeit",
          "activeFailurePrefix": "Hermes hat einen aktiven Fehler auf",
          "activeFailureSingular": "Instanz",
          "activeFailurePlural": "Instanzen",
          "activeFailureSuffix": "Jedes Element zeigt jetzt, wer den nächsten Schritt übernimmt.",
          "recoveryPrefix": "Wiederherstellung",
          "updateTitle": "Update erfordert Aufmerksamkeit",
          "updateSummaryPrefix": "Hermes hat ein Update-Problem auf",
          "updateSummarySingular": "Instanz",
          "updateSummaryPlural": "Instanzen",
          "updateSummarySuffix": "Deine eingebundenen Docker-Daten bleiben erhalten, aber diese Agenten benötigen eine kurze Prüfung.",
          "scheduledUpdateFailed": "Das letzte automatische Update ist fehlgeschlagen. Deine Docker-Volumes bleiben eingebunden, aber diese Instanz benötigt eine kurze Prüfung.",
          "manualUpdateFailed": "Das letzte manuelle Update ist fehlgeschlagen. Deine Docker-Volumes bleiben eingebunden, aber diese Instanz benötigt eine kurze Prüfung."
        },
        "status": {
          "running": "läuft",
          "provisioning": "wird bereitgestellt",
          "stopped": "gestoppt",
          "error": "Fehler",
          "failed": "fehlgeschlagen"
        },
        "instance": {
          "activeAgentSingular": "Aktiver Agent",
          "activeAgentPlural": "Aktive Agenten",
          "configuredInAgentSettings": "In den Agent-Einstellungen konfiguriert",
          "coreSingular": "Kern",
          "corePlural": "Kerne",
          "fetchingProfiles": "Profile werden geladen...",
          "hostInstancePrefix": "Host-Instanz",
          "idPrefix": "ID",
          "primaryAgent": "Primärer Agent",
          "profileNode": "Profil-Node",
          "secondaryAgent": "Sekundärer Agent"
        },
        "telemetry": {
          "activeModel": "Aktives Modell",
          "containerState": "Container-Status",
          "cpuUtilization": "CPU-Auslastung",
          "hostComputeNode": "Host-Compute-Node",
          "limitPrefix": "Limit",
          "llmInferenceEngine": "LLM-Inferenz-Engine",
          "memoryAllocation": "Speicherzuteilung",
          "networkIo": "Netzwerk-I/O",
          "provider": "Anbieter",
          "providerPrefix": "Anbieter",
          "totalTxPrefix": "Gesamt-Tx",
          "unrestricted": "UNBEGRENZT",
          "uptimePrefix": "Betriebszeit"
        },
        "allocation": {
          "cpuAllocated": "CPU zugeteilt",
          "cpuAllocation": "CPU-Zuteilung",
          "cpuCapacityError": "Gesamte CPU-Zuteilung ({allocated}) überschreitet die Node-Kapazität ({capacity}).",
          "dangerZone": "Gefahrenzone",
          "deleteConfirmationPhrase": "bitte löschen",
          "deletePromptPrefix": "Tippe",
          "deletePromptSuffix": "zur Bestätigung der Entfernung. Dies zerstört die Infrastruktur und alle Offline-Agenten darauf dauerhaft.",
          "failedToRemoveHost": "Host konnte nicht entfernt werden",
          "memoryAllocated": "Speicher zugeteilt",
          "memoryAllocation": "Speicher (RAM) Zuteilung",
          "memoryCapacityError": "Gesamte Speicherzuteilung ({allocated}GB) überschreitet die Node-Kapazität ({capacity}GB).",
          "noActiveAgents": "Keine aktiven Agenten auf diesem Node.",
          "nodeAllocationPrefix": "Node-Zuteilung",
          "projectedNodeUsage": "Prognostizierte Node-Auslastung"
        },
        "errors": {
          "failedToLoadOperations": "Operations-Daten konnten nicht geladen werden"
        }
      },
      "library": {
        "returnToCommandCenter": "Zurück zum Command Center",
        "titlePrefix": "Prompt-",
        "titleSeparator": "",
        "titleEmphasis": "Bibliothek",
        "titleSuffix": ".",
        "intro": "Hochspezialisierte Agent-Templates mit battle-tested System-Prompts deployen. Kuratiert aus dem Premium-Agency-Blueprint.",
        "sourcePrefix": "Templates freundlicherweise bereitgestellt von",
        "sourceLinkLabel": "Michal Sitarzewski's Agency Agents",
        "sourceSuffix": ".",
        "searchPlaceholder": "Vorlagen nach Name oder Beschreibung suchen...",
        "featured": "Empfohlen",
        "allTemplates": "Alle Vorlagen",
        "viewPrompt": "Prompt ansehen",
        "deploy": "Bereitstellen",
        "empty": "Keine Templates gefunden, die deinen Kriterien entsprechen",
        "copied": "Kopiert!",
        "copyPrompt": "Prompt kopieren",
        "deployTemplate": "Diese Vorlage bereitstellen",
        "closePreview": "Prompt-Vorschau schließen",
        "categories": {
          "All": "Alle",
          "Engineering": "Entwicklung",
          "Design": "Design",
          "Marketing": "Marketing",
          "Product": "Produkt",
          "Operations": "Betrieb",
          "Research": "Forschung",
          "Security": "Sicherheit",
          "Finance": "Finanzen"
        }
      },
      "wallet": {
        "eyebrowLegacy": "Wallet · Einzahlen & Abheben",
        "eyebrowSelfCustody": "Wallet · Signaturprüfung",
        "titlePrefix": "Deine",
        "titleSeparator": " ",
        "titleEmphasis": "$HermesOS",
        "titleSuffix": " Wallet.",
        "legacyIntroStrong": "Bestandskunden-Custody-Wallet",
        "legacyIntroBody": "dein bestehender Einzahlungs- und Auszahlungsflow bleibt aktiv. Den heutigen $HERMESOS-Preis für das gewünschte Tier sperren, dann den genannten Betrag an deine Einzahlungsadresse senden. Der Free-Tier funktioniert immer ohne Einzahlung.",
        "selfCustodyIntroStrong": "Verbinde deine eigene Wallet",
        "selfCustodyIntroBody": "$HermesOS und VVV selbst halten, dann eine Nachricht signieren um den Besitz zu bestätigen. Der Free-Tier funktioniert immer ohne Token-Verifizierung.",
        "priceUnavailable": "Token-Preis nicht verfügbar — bitte später erneut versuchen.",
        "buyToken": {
          "ariaLabel": "$HermesOS kaufen",
          "eyebrow": "$HermesOS erwerben",
          "title": "Auf Uniswap kaufen (Base-Netzwerk).",
          "action": "Auf Uniswap kaufen →",
          "contractLabel": "Vertragsadresse (Base)",
          "copyContractLabel": "Vertragsadresse kopieren",
          "copied": "Kopiert",
          "copy": "Kopieren",
          "warningPrefix": "Vertragsadresse immer auf",
          "warningLink": "hermesos.cloud/token",
          "warningSuffix": "verifizieren, bevor Gelder gesendet werden. Adressen aus DMs, Antworten oder Screenshots ignorieren."
        },
        "verification": {
          "ariaLabel": "Wallet-Verifizierung",
          "eyebrow": "Self-Custody-Verifizierung",
          "connectedTitle": "Wallet verbunden.",
          "disconnectedTitle": "Aus deiner Wallet verifizieren.",
          "activeWallet": "Aktive Wallet",
          "lastCheckedPrefix": "Zuletzt geprüft",
          "connecting": "Wird verbunden...",
          "checking": "Wird geprüft...",
          "connectWallet": "Wallet verbinden",
          "changeWallet": "Wallet wechseln",
          "refreshBalance": "Guthaben aktualisieren",
          "checkLock": "{tier}-Sperre prüfen",
          "lockPrice": "{tier}-Preis sperren",
          "lockedFor20": "{tier}-Preis für 20 Minuten gesperrt bei",
          "holdAtLeastThatAmount": "Mindestens diesen Betrag in dieser Wallet halten, bevor die Sperre abläuft.",
          "yourRateLockedAt": "Dein {tier}-Tarif ist gesperrt bei",
          "lockNext": "Den {tier}-Preis als Nächstes sperren, wenn du dieses Tier möchtest.",
          "keepEligible": "Diesen Betrag in dieser Wallet halten, um berechtigt zu bleiben.",
          "detected": "Erkannt",
          "snapshotInstruction": "{tier}-Preis sperren, um den Token-Betrag für 20 Minuten zu erfassen.",
          "refreshInstruction": "Guthaben aktualisieren, um dein aktuelles Tier zu bestätigen.",
          "connectedFootnote": "Es kann immer nur eine Wallet aktiv sein. Das Wechseln der Wallet ersetzt die aktive Wallet; Signaturen können keine Token übertragen.",
          "disconnectedBody": "$HermesOS und VVV in deiner eigenen Base-Wallet halten. Eine signierte Nachricht beweist den Besitz, ohne Token an Hivra zu senden.",
          "verifiedSuffix": "verifiziert."
        },
        "eligibility": {
          "ariaLabel": "Tier-Berechtigung",
          "eyebrow": "Tier-Berechtigung",
          "currentBalancePrefix": "Aktuelles Guthaben:",
          "autoRefreshPrefix": "Automatische Aktualisierung alle 5 Min · zuletzt geprüft",
          "refreshBalanceLabel": "Guthaben aktualisieren",
          "refresh": "Aktualisieren",
          "thresholdsMissing": "Tier-Schwellenwerte wurden noch nicht konfiguriert. Berechtigung wird nicht ausgewertet. Bitte erneut prüfen, wenn der Einzahlungsflow live geht.",
          "proTier": "Pro-Tier",
          "powerTier": "Power-Tier",
          "eligible": "Berechtigt",
          "breached": "Unterschritten — Berechtigung beendet",
          "notYetEligible": "Noch nicht berechtigt",
          "holdAtLeast": "Halte mindestens",
          "depositAtLeast": "Zahle mindestens ein",
          "selfCustodyQualifySuffix": "in deiner verifizierten Wallet, um für den {tier}-Tier ohne Abo zu qualifizieren.",
          "custodyQualifySuffix": "um für den {tier}-Tier ohne Abo zu qualifizieren.",
          "lockedAtPrice": "Zum notierten Preis gesperrt — aktualisiert sich wenn das Angebot abläuft."
        },
        "agentWallets": {
          "ariaLabel": "Agent-Wallets",
          "title": "Agent-Wallets.",
          "subtitle": "Eine Wallet pro Agent · Dein eigenes Bankr-Konto · Nur Base",
          "emptyNoAgents": "Starte einen Agenten und verbinde dann dein eigenes Bankr-Konto, um ihm eine Wallet zu geben.",
          "deployAgent": "Agent deployen",
          "runningEmpty": "Laufende Agenten erscheinen hier."
        }
      },
      "billing": {
        "eyebrow": "Abrechnung und Abo",
        "titlePrefix": "Plan",
        "titleSeparator": "-",
        "titleEmphasis": "Verwaltung",
        "titleSuffix": ".",
        "subtitle": "Dein Tarif, wie du zahlst und was du verbraucht hast.",
        "refreshing": "Wird aktualisiert…",
        "credits": {
          "title": "Guthaben",
          "available": "verfügbar",
          "description": "Kontoguthaben bezahlt die Nutzung. Es bestimmt nicht deinen Tarif: Der kommt aus einem Abo, einer Jahreszahlung in $HermesOS oder dem Halten von $HermesOS.",
          "monthlyGrantSuffix": "monatliche Plan-Credits"
        },
        "activity": {
          "eyebrow": "Abrechnungsaktivität",
          "title": "Aktuelle Kontobewegungen",
          "loading": "Wird geladen",
          "ledger": "Verlauf",
          "ledgerLoading": "Ledger wird geladen...",
          "ledgerEmpty": "Noch keine Ledger-Einträge.",
          "payments": "Zahlungen",
          "paymentsLoading": "Zahlungen werden geladen...",
          "paymentsEmpty": "Noch keine Zahlungen.",
          "compute": "Rechenleistung",
          "computeLoading": "Compute wird geladen...",
          "computeEmpty": "Noch keine Compute-Nutzung.",
          "llm": "LLM",
          "llmLoading": "LLM wird geladen...",
          "llmEmpty": "Noch keine LLM-Nutzung."
        },
        "tokenAccess": {
          "eyebrow": "Token-Zugang",
          "title": "$HermesOS Holding",
          "description": "Halte mindestens das Minimum an $HermesOS in einer verifizierten Wallet, um eine Basis-Maschine freizuschalten. Fällt dein Guthaben unter das Minimum, laufen die Agents auf dieser Maschine für eine Kulanzfrist weiter und pausieren dann, bis du wieder genug hältst.",
          "checking": "Wird geprüft",
          "unavailable": "Nicht verfügbar",
          "ready": "Minimum erreicht",
          "belowMinimum": "Unter Minimum",
          "noWallet": "Keine verifizierte Wallet",
          "wallet": "Wallet",
          "balance": "Saldo",
          "minimum": "Minimum",
          "notVerified": "Nicht verifiziert",
          "noSnapshot": "Kein Snapshot",
          "refresh": "Token-Status aktualisieren",
          "refreshing": "Wird aktualisiert...",
          "connectWallet": "Wallet verbinden",
          "connecting": "Wird verbunden...",
          "verifyDifferent": "Andere Wallet verifizieren"
        },
        "cryptoCredits": {
          "eyebrow": "Krypto-Guthaben",
          "description": "Wähle einen Betrag, und wir geben dir eine Adresse, an die du USDC auf Base sendest. Das Guthaben wird gutgeschrieben, sobald die Überweisung bestätigt ist.",
          "bonusPath": "Bonuspfad vorbereitet",
          "pendingDeposit": "Ausstehende Einzahlung",
          "createTopUpLabel": "USDC-Aufladung für {credits} Credits erstellen",
          "sendPrefix": "Senden",
          "onNetwork": "auf",
          "reference": "Referenz"
        },
        "activePlan": {
          "title": "Aktueller Plan",
          "heldViaTokens": "GEHALTEN VIA $HERMESOS",
          "perMonth": "/Monat",
          "agents": "Agenten",
          "cpuBudget": "CPU-Budget",
          "ramBudget": "RAM-Budget",
          "manageSubscription": "Abo verwalten",
          "opening": "Wird geöffnet..."
        },
        "switcher": {
          "title": "Plan wechseln",
          "description": "Jederzeit upgraden. Downgrades sind nicht möglich — dedizierte Server können nicht herunterskaliert werden.",
          "currentPlan": "Aktueller Plan",
          "upgrade": "Upgraden",
          "lowerTier": "Niedrigeres Tier",
          "unlimited": "Unbegrenzt",
          "agents": "Agenten",
          "active": "Aktiv",
          "guarantee": "48-Stunden-Rückerstattungsrichtlinie · Nur Upgrade-Pläne"
        },
        "noSubscription": {
          "title": "Kein aktives Abo"
        },
        "plate": {
          "slots": "Plätze",
          "vcpu": "vCPU",
          "memory": "Arbeitsspeicher",
          "idlePolicy": "Leerlauf",
          "alwaysOn": "Immer an",
          "sleepsAfterIdle": "Ruht nach {days} Tagen ohne Aktivität"
        }
      },
      "settings": {
        "loading": "Wird geladen...",
        "returnToCommandCenter": "Zurück zum Command Center",
        "titlePrefix": "Globale",
        "titleSeparator": " ",
        "titleEmphasis": "Einstellungen",
        "titleSuffix": ".",
        "intro": "Workspace, Interface-Themes und Anwendungsverhalten konfigurieren.",
        "sections": {
          "appearance": "Darstellung",
          "chatInterface": "Chat & Agent-Interface",
          "capabilities": "Funktionen & Plugins",
          "dangerZone": "Gefahrenzone"
        },
        "theme": {
          "label": "Design",
          "description": "Hell, dunkel oder wie dein Gerät.",
          "light": "Hell",
          "dark": "Dunkel",
          "system": "System"
        },
        "language": {
          "label": "Website-Sprache",
          "description": "Wähle die Sprache für Hivra."
        },
        "reducedMotion": {
          "label": "Reduzierte Bewegung",
          "description": "Übergänge und aufwendige UI-Animationen minimieren."
        },
        "autoScroll": {
          "label": "Chat-Frame automatisch scrollen",
          "description": "Automatisch ans Ende scrollen, wenn neue Nachrichten eintreffen."
        },
        "streamingAnimations": {
          "label": "Streaming-Animationen",
          "description": "Einblend-Markdown-Effekte beim Empfang von Agent-Streams anzeigen."
        },
        "aiReasoning": {
          "label": "KI-Reasoning aufklappen",
          "description": "Den \"Thinking\"-Block der KI automatisch ausgeklappt starten."
        },
        "persistentMemory": {
          "label": "Persistentes Memory aktivieren",
          "description": "Hermes erlauben, eigene Erinnerungen sitzungsübergreifend in MEMORY.md zu schreiben — über den konfigurierbaren Memory-Provider."
        },
        "plugins": {
          "label": "Erweiterbare Plugins / Skills aktivieren",
          "description": "Hermes Zugriff auf Upstream-MCP/ACP-Skills und experimentelle Tools geben."
        },
        "clearCache": {
          "label": "Lokalen Cache leeren",
          "description": "Löscht zwischengespeicherte Dashboard-Daten in diesem Browser und die hier gespeicherten Layout-Einstellungen, etwa Terminal-Tabs, und lädt die Seite neu. Dein Konto, deine Agents und deine Computer bleiben unberührt.",
          "action": "Cache leeren"
        },
        "hub": {
          "title": "Einstellungen",
          "intro": "Dein Konto, Abrechnung, Schlüssel und Agent-Tools – und wie Hivra in diesem Browser aussieht.",
          "groups": {
            "account": "Konto",
            "billing": "Tarif und Abrechnung",
            "connections": "Schlüssel und Verbindungen",
            "toolkit": "Agent-Werkzeuge",
            "device": "Auf diesem Gerät",
            "apps": "Apps und Hilfe",
            "reset": "Diesen Browser zurücksetzen"
          },
          "profile": {
            "title": "Profil und Anmeldung",
            "signedInAs": "Angemeldet als {email}",
            "fallback": "Name, E-Mail, Sicherheit und Abmelden.",
            "selfHostTitle": "Anmeldung",
            "selfHostFallback": "Bei diesem selbst gehosteten Hivra angemeldet.",
            "signOut": "Abmelden",
            "signingOut": "Wird abgemeldet…",
            "signOutFailed": "Abmelden fehlgeschlagen. Versuch es noch einmal."
          },
          "rows": {
            "billing": { "description": "Tarif, Zahlungsmethoden, Guthaben und Rechnungen" },
            "wallets": { "title": "Krypto-Wallets", "description": "Agent-Wallets und $HermesOS-Zugang" },
            "apiKeys": { "title": "API-Schlüssel", "description": "Anbieter-Schlüssel und welche Agents sie nutzen" },
            "infrastructure": { "description": "Die Maschinen und Cloud-Konten, auf denen deine Agents laufen" },
            "memory": { "title": "Gemeinsames Agent-Gedächtnis", "description": "Was jeder neue Agent von Anfang an weiß" },
            "tools": { "title": "Tools und Fähigkeiten", "description": "Füge den Agents deiner Wahl Tools hinzu" },
            "library": { "title": "Prompt-Bibliothek", "description": "Fertige Agent-Rollen mit erprobten Prompts" },
            "templates": { "title": "Vorlagen", "description": "Einen konfigurierten Agent speichern und erneut starten" },
            "referral": { "title": "Einladen und verdienen", "description": "Teile deinen Link und verdient gemeinsam Guthaben" },
            "applications": { "title": "Anwendungen", "description": "Nutze Hivra im Browser oder als Web-App" },
            "help": { "title": "Hilfe", "description": "Support, Community und rechtliche Informationen" }
          },
          "motionNote": "Animationen folgen der Einstellung „Bewegung reduzieren“ deines Geräts.",
          "clearCacheConfirm": "Erneut drücken zum Leeren und Neuladen",
          "clearCacheArmed": "Drücke die Schaltfläche innerhalb von 4 Sekunden erneut, um den Cache zu leeren und neu zu laden."
        }
      },
      "userModeSuffix": "Modus",
      "versionLabel": "Foundation v0.9.0"
    },
    "stats": {
      "hero": {
        "eyebrow": "Live · bereitgestellte Agenten",
        "label": "insgesamt bereitgestellt",
        "fullStats": "Alle Statistiken →"
      },
      "page": {
        "eyebrow": "Live-Zähler",
        "headlinePrefix": "Auf Hivra",
        "headlineEmphasis": "bereitgestellte",
        "headlineSuffix": "Agenten",
        "body": "Jedes Mal, wenn jemand erfolgreich einen Agenten bereitstellt, zählt dieser Zähler hoch.",
        "allTimeLabel": "Erfolgreiche Bereitstellungen insgesamt",
        "ariaTotal": "insgesamt bereitgestellte Agenten",
        "cards": {
          "last24h": "Letzte 24 Stunden",
          "last7d": "Letzte 7 Tage",
          "firstDeploy": "Erste Bereitstellung"
        },
        "sparkline": {
          "titlePrefix": "Tägliche Bereitstellungen,",
          "titleEmphasis": "letzte 30 Tage",
          "hint": "Balken hovern oder fokussieren für den genauen Wert",
          "peak": "Spitzentag",
          "total": "30-Tage-Summe",
          "barLabel": "{date}: {count} Bereitstellungen"
        },
        "cta": {
          "button": "Stelle deinen Agenten bereit →",
          "subtitle": "Free-Tarif — 1 Agent, 0,5 vCPU, 1 GB RAM, immer aktiv"
        }
      }
    },
    "footer": {
      "links": {
        "features": "Funktionen",
        "compare": "Vergleichen",
        "blog": "Blog",
        "roadmap": "Roadmap",
        "tokenVerification": "Token-Verifizierung",
        "privacy": "Datenschutz",
        "terms": "Bedingungen"
      }
    }
  },
  "ja": {
    "localeLabel": "日本語",
    "languageSelectorLabel": "言語",
    "nav": {
      "pricing": "料金",
      "roadmap": "ロードマップ",
      "tokenVerification": "トークン確認",
      "register": "登録",
      "login": "ログイン",
      "openDashboard": "ダッシュボードを開く",
      "mobileMenu": "メニューを開く",
      "closeMobileMenu": "メニューを閉じる"
    },
    "hero": {
      "eyebrow": "公開中",
      "headlinePrefix": "あなたの AI エージェントを、",
      "headlineEmphasis": "常時稼働。",
      "primary": "Hivra は Hermes Agent を 5 分以内に起動し、永続メモリ、ブラウザ自動化、ツール利用を標準で備えます。",
      "secondary": "無料プランは利用可能です。Pro と Power は本格的なワークロード向けです。",
      "primaryCta": "無料で始める",
      "secondaryCta": "仕組みを見る",
      "proofPoints": [
        "無料プランは常時利用可",
        "自分のキー、上乗せなし",
        "Hermes Agent ベース"
      ]
    },
    "ticker": {
      "proofPoints": [
        "Hermes Agent（Nous Research）搭載",
        "自前のキーをそのまま使用。マークアップなし",
        "Free プランは常時利用可能"
      ]
    },
    "positioning": {
      "title": "OpenClaw は忘れる。Hermes は積み重ねる。",
      "body": "Nous Research が開発した Hermes は、サーバー上で常時稼働し、プロジェクト・設定・学びをすべて記憶します。セッションを重ねるほど精度が上がる AI エージェントです。セルフホストの構築には、通常 1 週間ほどかかります。",
      "punchline": "Hivra なら、その 1 週間がわずか 5 分に。"
    },
    "features": {
      "eyebrow": "含まれる機能",
      "titlePrefix": "エージェントに必要なものは、すべてここに。",
      "titleEmphasis": "余計なものは何もない。",
      "items": [
        {
          "headline": "設定不要。フルスタック。",
          "body": "ブラウザ自動化、ツール利用、ターミナル、メモリ、cron —— すべて設定済み。Docker も深夜の StackOverflow も不要です。"
        },
        {
          "headline": "マルチエージェント、最初から。",
          "body": "1 つのインスタンスで無制限のエージェントプロファイルを利用可能。リサーチャー、オペレーター、スペシャリスト —— エージェントごとの追加料金なし。"
        },
        {
          "headline": "自前のキー。マークアップなし。",
          "body": "OpenRouter、OpenAI、Anthropic に対応。保存時は暗号化、デプロイ時に注入。AI への支出を当社が知ることはありません。"
        },
        {
          "headline": "どこからでもチャット。",
          "body": "ストリーミング対応の組み込みダッシュボード。Telegram、Discord、Slack、WhatsApp もすぐに接続できます。"
        },
        {
          "headline": "OpenClaw からの移行も組み込み済み。",
          "body": "既存のセットアップ、プロンプト、スキルをそのまま移行。ゼロから始める必要はありません。"
        },
        {
          "headline": "安定。復旧可能。常時稼働。",
          "body": "アップデートはリリース前にあなたの設定でテスト済み。障害時は自動再起動。毎日バックアップ —— クリーンな復元まで最大 24 時間以内。"
        }
      ]
    },
    "howItWorks": {
      "eyebrow": "使い方",
      "titlePrefix": "3 ステップ。",
      "titleEmphasis": "ターミナル不要。",
      "steps": [
        {
          "step": "1",
          "headline": "プランを選ぶ",
          "body": "まず無料で始め、必要になったらアップグレード。カードで月払い・年払い（割引あり）、または $HermesOS を保有してサブスクリプションなしでアクセスを維持。"
        },
        {
          "step": "2",
          "headline": "AI キーを追加",
          "body": "OpenRouter、OpenAI、または Anthropic のキーを一度貼り付けるだけ。暗号化・注入・完了。"
        },
        {
          "step": "3",
          "headline": "デプロイ。対話。自動化。",
          "body": "数分でエージェントが起動 —— チャット、ターミナル、モニタリングが揃っています。Telegram や Discord に接続すれば、どこにいても追いかけてきます。"
        }
      ],
      "footer": "読むだけから実際のセットアップへ。プランを選んで、そのままアカウント作成へ進んでください。",
      "cta": "プランを選ぶ"
    },
    "useCases": {
      "eyebrow": "活用例",
      "titlePrefix": "メモリを持つ 24 時間 365 日のエージェントは",
      "titleEmphasis": "実際に何をするのか？",
      "intro": "ブラウジング、コーディング、ファイル管理、API 呼び出し、cron タスクの実行 —— すべて自律的に。しかも先週学んだことを覚えています。",
      "items": [
        {
          "headline": "DevOps & モニタリング",
          "body": "ログを読み、障害サービスを再起動し、人間が本当に必要なときだけ通知。あなたのスタックを記憶します。"
        },
        {
          "headline": "リサーチ & 競合インテリジェンス",
          "body": "テーマと締め切りを渡すだけ。ブラウジング・集約・構造化レポートの作成まで実行し、次回のために学んだことを保存します。"
        },
        {
          "headline": "バックグラウンド自動化",
          "body": "メールのトリアージ、スケジュール管理、API 呼び出し、スプレッドシート —— あらゆる繰り返し作業。あなたが眠っている間も cron で動き続けます。"
        },
        {
          "headline": "カスタマーサポートのトリアージ",
          "body": "ドキュメントを読み込ませるだけ。よくあるチケットを解決し、難しいものをエスカレーション。会話のたびに賢くなります。"
        }
      ],
      "footer": "Hermes があなたの仕事を肩代わりできるイメージが湧きましたか？プランを選んで、ワークフローを今すぐ立ち上げましょう。",
      "cta": "プランを見て始める"
    },
    "whatsComing": {
      "eyebrow": "Coming soon",
      "titlePrefix": "これは",
      "titleEmphasis": "はじまりにすぎない。",
      "intro": "ホスティングは基盤です。近日公開予定：",
      "items": [
        {
          "title": "Operator Packs",
          "body": "特定業務向けのエージェントテンプレート —— リサーチ、トレーディングインテリジェンス、コンテンツ自動化。ワンクリックでデプロイ。"
        },
        {
          "title": "Marketplace",
          "body": "Operator Packs を作成してコミュニティに公開し、利用量に応じて収益化。報酬は $HermesOS で決済。"
        },
        {
          "title": "Agent Endpoints",
          "body": "自分のエージェントを呼び出し可能な API として公開。他のエージェントがリクエストごとに支払います。"
        },
        {
          "title": "Hive Mind",
          "body": "エージェントが学びを共有。ネットワーク全体がともに賢くなります。"
        }
      ],
      "footer": "Hivra はエージェントエコノミーのインフラです。ホスティングはステップ 1。そのすべてがこの基盤の上に構築されていきます。"
    },
    "pricing": {
      "eyebrow": "料金",
      "titlePrefix": "シンプルなプラン。",
      "titleEmphasis": "本格的なコンピュート。",
      "intro": "専有コンピュート。エージェントプロファイル無制限。自前のキー、マークアップなし。",
      "compute": "コンピュート",
      "mostPopular": "最も人気",
      "forPros": "プロ向け",
      "getStarted": "今すぐ始める",
      "recommended": "おすすめ",
      "accessPrefix": "3 つのアクセス方法",
      "footnote": "$HermesOS での支払いで最大 40% 割引。ローンチ価格は初回ウェーブ限定 —— プラットフォームの成熟に伴い料金が変更になる場合があります。",
      "guarantee": "Free プランで試してからアップグレード · カード決済は 48 時間返金保証",
      "tiers": [
        {
          "name": "Free",
          "tagline": "ほとんどのユーザーはカードなしで起動できます。リスクの高い Free プランのデプロイでは、先にカード認証が必要な場合があります。",
          "price": "$0",
          "priceNote": "常時無料。リスクチェックが必要な場合のみカード",
          "specs": [
            {
              "label": "vCPU",
              "value": "0.5"
            },
            {
              "label": "RAM",
              "value": "1 GB"
            },
            {
              "label": "アクティブエージェント",
              "value": "1"
            }
          ],
          "features": [
            "永続メモリ",
            "全インテグレーション込み",
            "フェアユース制限あり"
          ],
          "ctaLabel": "無料で始める"
        },
        {
          "name": "Pro",
          "tagline": "実験ではなく、本番ワークのために。",
          "price": "$9.99",
          "priceCadence": "/月",
          "priceNote": "カードで月払い",
          "specs": [
            {
              "label": "vCPU",
              "value": "2"
            },
            {
              "label": "RAM",
              "value": "4 GB"
            },
            {
              "label": "同時実行エージェント",
              "value": "3",
              "tooltip": "同時にタスクを実行できるエージェント数。プロファイルは無制限 —— これはライブ実行の上限です。"
            }
          ],
          "features": [
            "エージェントプロファイル無制限",
            "Free のすべてを含む",
            "Free プランより優先処理"
          ],
          "paymentPaths": [
            {
              "label": "カード月払い",
              "detail": "$9.99/月"
            },
            {
              "label": "年払い",
              "detail": "カード $79/年 · $HermesOS $49/年"
            },
            {
              "label": "$HermesOS 保有",
              "detail": "約 $99（ローンチレート、最初の 30 日間）"
            }
          ],
          "ctaLabel": "Pro を始める"
        },
        {
          "name": "Power",
          "tagline": "本格的なワークフローとマルチエージェント運用のために。",
          "price": "$19.99",
          "priceCadence": "/月",
          "priceNote": "カードで月払い",
          "specs": [
            {
              "label": "vCPU",
              "value": "4"
            },
            {
              "label": "RAM",
              "value": "8 GB"
            },
            {
              "label": "同時実行エージェント",
              "value": "無制限",
              "tooltip": "コンピュートプールが対応できる限り、同時に何台でもエージェントを並列実行可能。プラットフォームによる上限なし。"
            }
          ],
          "features": [
            "エージェントプロファイル無制限",
            "Pro のすべてを含む",
            "空き容量があればバースト CPU 利用可"
          ],
          "paymentPaths": [
            {
              "label": "カード月払い",
              "detail": "$19.99/月"
            },
            {
              "label": "年払い",
              "detail": "カード $149/年 · $HermesOS $99/年"
            },
            {
              "label": "$HermesOS 保有",
              "detail": "約 $199（ローンチレート、最初の 30 日間）"
            }
          ],
          "ctaLabel": "Power を始める"
        }
      ]
    },
    "token": {
      "eyebrow": "$HermesOS について",
      "title": "プラットフォームへのアクセス層。",
      "body": "$HermesOS を使えば、サブスクリプションを割引料金で支払ったり、月払いなしでティアを維持したり、構築中のエージェントエコノミー全体で取引したりできます。",
      "secondary": "Hivra を利用するためにトークンは必須ではありません —— Free プランはトークンなしで利用でき、必要に応じてアンチアビューズチェックが適用されます。エコシステムにより深く関わりたい場合、$HermesOS を保有することで支払い方法とアクセス手段の柔軟性が広がります。",
      "cta": "トークン認証ページ"
    },
    "faq": {
      "eyebrow": "よくある質問",
      "title": "率直な回答。",
      "items": [
        {
          "q": "API キーは安全ですか？",
          "a": "はい。保存時は暗号化され、環境変数経由でデプロイ時に注入されます。AI リクエストのプロキシやログ記録は一切行いません。"
        },
        {
          "q": "アップデートで設定が壊れることはありますか？",
          "a": "ありません。すべてのアップデートはリリース前にコンテナ設定に対してテスト済みです。毎日バックアップを取っているため、クリーンな復元まで最大 24 時間以内です。"
        },
        {
          "q": "OpenClaw との違いは何ですか？",
          "a": "OpenClaw は優れたオープンソースのデスクトップフレームワークです。Hivra はフルマネージドの本番グレードクラウド環境です。Hermes Agent はより安定したメモリ、高い信頼性、そして既存機能を壊さないアップデートを提供します。"
        },
        {
          "q": "エージェントがクラッシュしたらどうなりますか？",
          "a": "自動的に再起動されます。ヘルス状態、ログ、リソース使用状況はダッシュボードで常時確認できます。"
        },
        {
          "q": "1 つのプランで複数のエージェントを動かせますか？",
          "a": "はい —— インスタンスあたりプロファイル数は無制限です。Free は同時 1 エージェント、Pro は 3 エージェント、Power は同時実行数の上限なし。実際の制限はコンピュートプールのみです。"
        },
        {
          "q": "どの AI プロバイダーに対応していますか？",
          "a": "OpenRouter、OpenAI、Anthropic に対応。OpenRouter だけで 1 つのキーから数百のモデルを利用できます。"
        },
        {
          "q": "プラットフォームを利用するために $HermesOS は必要ですか？",
          "a": "いいえ。Free プランはトークン不要。Pro と Power はカードで支払えます。トークンは割引と、希望する方向けの第 3 の支払い手段を提供します。"
        },
        {
          "q": "次に追加される機能は何ですか？",
          "a": "Operator Packs（事前構築済みエージェントテンプレート）が数週間以内にリリース予定です。続いて Marketplace、Agent Endpoints、Hive Mind が登場します。ロードマップは hermesos.cloud/roadmap をご覧ください。"
        }
      ]
    },
    "finalCta": {
      "eyebrow": "今すぐ始める",
      "title": "デプロイする準備はできましたか？",
      "body": "Free プランはアビューズ対策を施して稼働中。Pro と Power は今すぐご利用いただけます。",
      "primary": "無料で始める",
      "secondary": "料金を見る",
      "note": "ほとんどの Free ユーザーはカードなしで始められます。リスクの高いサインアップではカード登録が必要な場合があります。",
      "accountPrefix": "すでにアカウントをお持ちの方は",
      "accountLink": "ログイン"
    },
    "getStarted": {
      "loadingCheckout": "チェックアウトへ移動中...",
      "steps": {
        "choosePlan": "プランを選ぶ",
        "createAccount": "アカウント作成",
        "activate": "有効化",
        "payment": "お支払い"
      },
      "badges": {
        "free": "常時無料",
        "paid": "7 日間返金保証"
      },
      "yourPlan": "あなたのプラン",
      "perMonth": "/月",
      "perYear": "/年",
      "cadence": {
        "monthly": "月払い",
        "yearly": "年払い",
        "saveLabel": "約{percent}%お得",
        "saveDollarsLabel": "年間 約${dollars} お得"
      },
      "marketAnchor": "同等のエージェントプラットフォームは月額 $19 程度から",
      "mostPopular": "一番人気",
      "freeGap": "ウェブブラウジングなし · 永続メモリなし · 定期タスクなし · 0.5 vCPU",
      "specs": {
        "agents": "エージェント",
        "cpu": "CPU",
        "ram": "RAM"
      },
      "guarantee": {
        "free": "チェックアウト不要",
        "paid": "7 日間返金保証"
      },
      "switchPlan": "プランを変更",
      "bestFit": "おすすめ",
      "planGuidance": {
        "free": "Free は 1 つのエージェントで Hermes を試したい方に最適です。ほとんどのユーザーはカードなしで起動できますが、リスクの高い Free プランのデプロイでは先にカード認証が必要な場合があります。",
        "operator": "Pro は個人ビルダー、ハッカソンプロジェクト、1 つのエージェントを素早く立ち上げたい方に最適です。",
        "fleet": "Power はマルチエージェントのワークフロー、ヘビーなブラウジング、すぐに多くのコンピュートが必要なチームに最適です。",
        "command": "Command は最大規模のワークロード、最速のスケーリング、デプロイあたりの最大コンピュートが必要な方に最適です。"
      },
      "createAccountTitle": "アカウントを作成してください。",
      "createAccountIntroFree": "入力したアカウント情報がログイン認証情報になります。サインアップ後、Free プランを有効化してデプロイ画面に直接進みます。ほとんどのユーザーはカードなしで起動できますが、リスクの高い Free プランのデプロイでは先にカード認証が必要な場合があります。",
      "createAccountIntroPaid": "入力したアカウント情報がログイン認証情報になります。サインアップ後、安全なチェックアウトへ進みます。7 日間返金保証付き。",
      "legalPrefix": "続行することで、以下に同意したものとみなされます：",
      "terms": "利用規約",
      "and": "および",
      "privacy": "プライバシーポリシー"
    },
    "dashboard": {
      "nav": {
        "chat": "チャット",
        "commandCenter": "コマンドセンター",
        "home": "ホーム",
        "computers": "コンピューター",
        "agents": "エージェント",
        "infrastructure": "インフラストラクチャ",
        "collaboration": "コラボレーション",
        "settings": "設定",
        "launch": "起動",
        "ops": "運用",
        "promptLibrary": "プロンプトライブラリ",
        "wallet": "ウォレット",
        "billing": "請求"
      },
      "sections": {
        "advanced": "詳細設定",
        "support": "サポート"
      },
      "support": {
        "discord": "Discord",
        "xTwitter": "X (Twitter)",
        "email": "メールサポート"
      },
      "legal": {
        "terms": "利用規約",
        "privacy": "プライバシー"
      },
      "controls": {
        "expandSidebarTitle": "サイドバーを展開",
        "collapseSidebarTitle": "サイドバーを折りたたむ",
        "expandSidebarLabel": "ダッシュボードのサイドバーを展開する",
        "collapseSidebarLabel": "ダッシュボードのサイドバーを折りたたむ",
        "globalSettings": "グローバル設定"
      },
      "commandCenter": {
        "phase": "フェーズ II：フリート オペレーション",
        "titlePrefix": "コマンド",
        "titleSeparator": " ",
        "titleEmphasis": "センター",
        "titleSuffix": "。",
        "labelSeparator": "：",
        "sections": {
          "activeAgents": "アクティブエージェント",
          "activeCoreInstances": "アクティブコアインスタンス",
          "infrastructureNodes": "インフラストラクチャノード"
        },
        "actions": {
          "advancedConsole": "高度なコンソール",
          "applyChanges": "変更を適用",
          "applying": "適用中...",
          "cancel": "キャンセル",
          "confirmRemove": "削除を確認",
          "coreConsole": "コアコンソール",
          "initializeAgent": "エージェントを初期化",
          "manageAllocation": "割り当てを管理",
          "removeNode": "ノードを削除",
          "removing": "削除中..."
        },
        "alerts": {
          "activeFailureTitle": "対応が必要なアクティブな障害",
          "activeFailurePrefix": "Hermes がアクティブな障害を検出しました：",
          "activeFailureSingular": "インスタンス",
          "activeFailurePlural": "インスタンス",
          "activeFailureSuffix": "各項目に次のアクションの担当者が表示されています。",
          "recoveryPrefix": "リカバリ",
          "updateTitle": "アップデートの確認が必要",
          "updateSummaryPrefix": "Hermes がアップデートの問題を検出しました：",
          "updateSummarySingular": "インスタンス",
          "updateSummaryPlural": "インスタンス",
          "updateSummarySuffix": "マウントされた Docker データはそのままですが、これらのエージェントは簡単な確認が必要です。",
          "scheduledUpdateFailed": "最後の自動アップデートが失敗しました。Docker ボリュームはマウントされたままですが、このインスタンスは簡単な確認が必要です。",
          "manualUpdateFailed": "最後の手動アップデートが失敗しました。Docker ボリュームはマウントされたままですが、このインスタンスは簡単な確認が必要です。"
        },
        "status": {
          "running": "実行中",
          "provisioning": "プロビジョニング中",
          "stopped": "停止",
          "error": "エラー",
          "failed": "失敗"
        },
        "instance": {
          "activeAgentSingular": "アクティブエージェント",
          "activeAgentPlural": "アクティブエージェント",
          "configuredInAgentSettings": "エージェント設定で構成済み",
          "coreSingular": "コア",
          "corePlural": "コア",
          "fetchingProfiles": "プロファイルを取得中...",
          "hostInstancePrefix": "ホストインスタンス",
          "idPrefix": "ID",
          "primaryAgent": "プライマリエージェント",
          "profileNode": "プロファイルノード",
          "secondaryAgent": "セカンダリエージェント"
        },
        "telemetry": {
          "activeModel": "アクティブモデル",
          "containerState": "コンテナ状態",
          "cpuUtilization": "CPU 使用率",
          "hostComputeNode": "ホストコンピュートノード",
          "limitPrefix": "上限",
          "llmInferenceEngine": "LLM 推論エンジン",
          "memoryAllocation": "メモリ割り当て",
          "networkIo": "ネットワーク I/O",
          "provider": "プロバイダー",
          "providerPrefix": "プロバイダー",
          "totalTxPrefix": "総送信量",
          "unrestricted": "制限なし",
          "uptimePrefix": "稼働時間"
        },
        "allocation": {
          "cpuAllocated": "CPU 割り当て済み",
          "cpuAllocation": "CPU 割り当て",
          "cpuCapacityError": "CPU 割り当ての合計（{allocated}）がノード容量（{capacity}）を超えています。",
          "dangerZone": "危険ゾーン",
          "deleteConfirmationPhrase": "削除",
          "deletePromptPrefix": "確認のため",
          "deletePromptSuffix": "と入力してください。インフラとオフラインエージェントがすべて完全に削除されます。",
          "failedToRemoveHost": "ホストの削除に失敗しました",
          "memoryAllocated": "メモリ割り当て済み",
          "memoryAllocation": "メモリ（RAM）割り当て",
          "memoryCapacityError": "メモリ割り当ての合計（{allocated}GB）がノード容量（{capacity}GB）を超えています。",
          "noActiveAgents": "このノードにアクティブなエージェントはありません。",
          "nodeAllocationPrefix": "ノード割り当て",
          "projectedNodeUsage": "予測ノード使用量"
        },
        "errors": {
          "failedToLoadOperations": "オペレーションデータの読み込みに失敗しました"
        }
      },
      "library": {
        "returnToCommandCenter": "コマンドセンターへ戻る",
        "titlePrefix": "プロンプト",
        "titleSeparator": "",
        "titleEmphasis": "ライブラリ",
        "titleSuffix": "。",
        "intro": "実績のあるシステムプロンプトを備えた高度に専門化されたエージェントテンプレートをデプロイ。プレミアム Agency ブループリントからキュレーション。",
        "sourcePrefix": "テンプレートの提供元：",
        "sourceLinkLabel": "Michal Sitarzewski の Agency Agents",
        "sourceSuffix": "。",
        "searchPlaceholder": "名前または説明でテンプレートを検索...",
        "featured": "注目",
        "allTemplates": "すべてのテンプレート",
        "viewPrompt": "プロンプトを見る",
        "deploy": "デプロイ",
        "empty": "条件に一致するテンプレートが見つかりません",
        "copied": "コピーしました！",
        "copyPrompt": "プロンプトをコピー",
        "deployTemplate": "このテンプレートをデプロイ",
        "closePreview": "プロンプトプレビューを閉じる",
        "categories": {
          "All": "すべて",
          "Engineering": "エンジニアリング",
          "Design": "デザイン",
          "Marketing": "マーケティング",
          "Product": "プロダクト",
          "Operations": "オペレーション",
          "Research": "リサーチ",
          "Security": "セキュリティ",
          "Finance": "ファイナンス"
        }
      },
      "wallet": {
        "eyebrowLegacy": "ウォレット · 入金 & 出金",
        "eyebrowSelfCustody": "ウォレット · 署名確認",
        "titlePrefix": "あなたの",
        "titleSeparator": " ",
        "titleEmphasis": "$HermesOS",
        "titleSuffix": " ウォレット。",
        "legacyIntroStrong": "移行前のカストディウォレット",
        "legacyIntroBody": "既存の入金・出金フローはそのまま有効です。希望するティアの $HERMESOS 価格を今日ロックし、入金アドレスに見積もり額を送金してください。Free プランはデポジットなしで常時利用可能です。",
        "selfCustodyIntroStrong": "自分のウォレットを接続",
        "selfCustodyIntroBody": "$HermesOS と VVV を自分で保有し、メッセージに署名して所有権を証明します。Free プランはトークン認証なしで常時利用可能です。",
        "priceUnavailable": "トークン価格を取得できません —— しばらくしてから再試行してください。",
        "buyToken": {
          "ariaLabel": "$HermesOS を購入",
          "eyebrow": "$HermesOS を手に入れる",
          "title": "Uniswap（Base ネットワーク）で購入。",
          "action": "Uniswap で購入 →",
          "contractLabel": "コントラクトアドレス（Base）",
          "copyContractLabel": "コントラクトアドレスをコピー",
          "copied": "コピーしました",
          "copy": "コピー",
          "warningPrefix": "送金前に必ずコントラクトアドレスを",
          "warningLink": "hermesos.cloud/token",
          "warningSuffix": "で確認してください。DM、リプライ、スクリーンショットからコピーしたアドレスは無視してください。"
        },
        "verification": {
          "ariaLabel": "ウォレット認証",
          "eyebrow": "セルフカストディ認証",
          "connectedTitle": "ウォレット接続済み。",
          "disconnectedTitle": "ウォレットから確認します。",
          "activeWallet": "アクティブウォレット",
          "lastCheckedPrefix": "最終確認",
          "connecting": "接続中...",
          "checking": "確認中...",
          "connectWallet": "ウォレットを接続",
          "changeWallet": "ウォレットを変更",
          "refreshBalance": "残高を更新",
          "checkLock": "{tier} のロックを確認",
          "lockPrice": "{tier} 価格をロック",
          "lockedFor20": "{tier} の価格を 20 分間ロック済み：",
          "holdAtLeastThatAmount": "ロックが期限切れになる前に、このウォレットにその金額以上を保有してください。",
          "yourRateLockedAt": "あなたの {tier} レートのロック価格：",
          "lockNext": "そのティアを希望する場合は、次に {tier} の価格をロックしてください。",
          "keepEligible": "資格を維持するために、このウォレットにその金額を保有し続けてください。",
          "detected": "検出済み",
          "snapshotInstruction": "{tier} 価格をロックして、20 分間トークン量のスナップショットを取得します。",
          "refreshInstruction": "残高を更新して現在のティアを確認します。",
          "connectedFootnote": "アクティブにできるウォレットは一度に 1 つです。ウォレットを変更するとアクティブウォレットが置き換えられます。署名でトークンを移動することはできません。",
          "disconnectedBody": "$HermesOS と VVV を自分の Base ウォレットで保管してください。署名付きメッセージにより、Hivra へトークンを送らずに所有権を証明できます。",
          "verifiedSuffix": "認証済み。"
        },
        "eligibility": {
          "ariaLabel": "ティア資格",
          "eyebrow": "ティア資格",
          "currentBalancePrefix": "現在の残高：",
          "autoRefreshPrefix": "5 分ごとに自動更新 · 最終確認",
          "refreshBalanceLabel": "残高を更新",
          "refresh": "更新",
          "thresholdsMissing": "ティアの閾値がまだ設定されていません。資格は評価されていません。入金フローが開始されたら再度ご確認ください。",
          "proTier": "Pro ティア",
          "powerTier": "Power ティア",
          "eligible": "資格あり",
          "breached": "違反 —— 資格終了",
          "notYetEligible": "まだ資格なし",
          "holdAtLeast": "少なくとも保持",
          "depositAtLeast": "少なくとも入金",
          "selfCustodyQualifySuffix": "をあなたの認証済みウォレットに保有することで、サブスクリプションなしで {tier} ティアの資格を得られます。",
          "custodyQualifySuffix": "を保有することで、サブスクリプションなしで {tier} ティアの資格を得られます。",
          "lockedAtPrice": "見積もり価格でロック済み —— 見積もりが期限切れになると更新されます。"
        },
        "agentWallets": {
          "ariaLabel": "エージェントウォレット",
          "title": "エージェントウォレット。",
          "subtitle": "エージェントごとに 1 つ · ご自身の Bankr アカウント · Base のみ",
          "emptyNoAgents": "エージェントを起動し、ご自身の Bankr アカウントを接続してウォレットを使えるようにします。",
          "deployAgent": "エージェントをデプロイ",
          "runningEmpty": "実行中のエージェントがここに表示されます。"
        }
      },
      "billing": {
        "eyebrow": "請求とサブスクリプション",
        "titlePrefix": "プラン",
        "titleSeparator": "",
        "titleEmphasis": "管理",
        "titleSuffix": "。",
        "subtitle": "プラン、支払い方法、利用状況。",
        "refreshing": "更新中…",
        "credits": {
          "title": "クレジット残高",
          "available": "利用可能",
          "description": "アカウントのクレジットは利用料金の支払いに使われます。プランはクレジットでは決まらず、サブスクリプション、$HermesOS での年払い、または $HermesOS の保有で決まります。",
          "monthlyGrantSuffix": "月次プランクレジット"
        },
        "activity": {
          "eyebrow": "請求アクティビティ",
          "title": "最近のアカウント動向",
          "loading": "読み込み中",
          "ledger": "台帳",
          "ledgerLoading": "台帳を読み込み中...",
          "ledgerEmpty": "台帳エントリがまだありません。",
          "payments": "支払い",
          "paymentsLoading": "支払い情報を読み込み中...",
          "paymentsEmpty": "支払いがまだありません。",
          "compute": "コンピュート",
          "computeLoading": "コンピュート情報を読み込み中...",
          "computeEmpty": "コンピュートの使用履歴がまだありません。",
          "llm": "LLM",
          "llmLoading": "LLM 情報を読み込み中...",
          "llmEmpty": "LLM の使用履歴がまだありません。"
        },
        "tokenAccess": {
          "eyebrow": "トークンアクセス",
          "title": "$HermesOS 保有",
          "description": "認証済みウォレットで最低数量以上の $HermesOS を保有すると、ベーシックマシンが使えるようになります。残高が最低数量を下回ると、そのマシンのエージェントは猶予期間中は動き続け、その後は十分な量を再び保有するまで一時停止します。",
          "checking": "確認中",
          "unavailable": "利用不可",
          "ready": "最低数量を満たしています",
          "belowMinimum": "最低水準以下",
          "noWallet": "認証済みウォレットなし",
          "wallet": "ウォレット",
          "balance": "残高",
          "minimum": "最低水準",
          "notVerified": "未認証",
          "noSnapshot": "スナップショットなし",
          "refresh": "トークンステータスを更新",
          "refreshing": "更新中...",
          "connectWallet": "ウォレットを接続",
          "connecting": "接続中...",
          "verifyDifferent": "別のウォレットを認証"
        },
        "cryptoCredits": {
          "eyebrow": "暗号資産クレジット",
          "description": "金額を選ぶと、Base で USDC を送るためのアドレスが表示されます。送金が確認されるとクレジットが追加されます。",
          "bonusPath": "ボーナスパス準備完了",
          "pendingDeposit": "保留中の入金",
          "createTopUpLabel": "{credits} クレジットの USDC チャージを作成",
          "sendPrefix": "送金",
          "onNetwork": "（ネットワーク：",
          "reference": "参照番号"
        },
        "activePlan": {
          "title": "現在のプラン",
          "heldViaTokens": "$HERMESOS 保有中",
          "perMonth": "/月",
          "agents": "エージェント",
          "cpuBudget": "CPU 予算",
          "ramBudget": "RAM 予算",
          "manageSubscription": "サブスクリプションを管理",
          "opening": "開いています..."
        },
        "switcher": {
          "title": "プランを変更",
          "description": "いつでもアップグレードできます。ダウングレードは不可 —— 専有サーバーはスケールダウンできません。",
          "currentPlan": "現在のプラン",
          "upgrade": "アップグレード",
          "lowerTier": "下位ティア",
          "unlimited": "無制限",
          "agents": "エージェント",
          "active": "有効",
          "guarantee": "48 時間返金ポリシー · アップグレード専用プラン"
        },
        "noSubscription": {
          "title": "有効なサブスクリプションなし"
        },
        "plate": {
          "slots": "スロット",
          "vcpu": "vCPU",
          "memory": "メモリ",
          "idlePolicy": "アイドル時",
          "alwaysOn": "常時稼働",
          "sleepsAfterIdle": "{days} 日間アイドルでスリープ"
        }
      },
      "settings": {
        "loading": "読み込み中...",
        "returnToCommandCenter": "コマンドセンターへ戻る",
        "titlePrefix": "グローバル",
        "titleSeparator": "",
        "titleEmphasis": "設定",
        "titleSuffix": "。",
        "intro": "ワークスペース、インターフェーステーマ、アプリの動作を設定します。",
        "sections": {
          "appearance": "外観",
          "chatInterface": "チャット & エージェントインターフェース",
          "capabilities": "機能 & プラグイン",
          "dangerZone": "危険ゾーン"
        },
        "theme": {
          "label": "テーマ",
          "description": "ライト、ダーク、またはデバイスに合わせる。",
          "light": "ライト",
          "dark": "ダーク",
          "system": "システム"
        },
        "language": {
          "label": "サイト言語",
          "description": "Hivra で使用する言語を選択します。"
        },
        "reducedMotion": {
          "label": "モーション軽減",
          "description": "トランジションと重い UI アニメーションを最小化します。"
        },
        "autoScroll": {
          "label": "チャットの自動スクロール",
          "description": "新しいメッセージが届いたとき、自動的に最下部に固定します。"
        },
        "streamingAnimations": {
          "label": "ストリーミングアニメーション",
          "description": "エージェントのストリーム受信時にフェードインのマークダウン効果を表示します。"
        },
        "aiReasoning": {
          "label": "AI の推論を展開表示",
          "description": "AI の「思考」ブロックを最初から展開した状態で表示します。"
        },
        "persistentMemory": {
          "label": "永続メモリを有効化",
          "description": "プラグイン可能なメモリプロバイダーを使用して、Hermes がセッションをまたいで MEMORY.md に自分のメモを書き込めるようにします。"
        },
        "plugins": {
          "label": "拡張プラグイン / スキルを有効化",
          "description": "上流の MCP/ACP スキルと実験的ツールへのアクセスを Hermes に付与します。"
        },
        "clearCache": {
          "label": "ローカルキャッシュを消去",
          "description": "このブラウザにキャッシュされたダッシュボードのデータと、ここに保存されたレイアウトの選択（ターミナルのタブなど）を消去し、ページを再読み込みします。アカウント、エージェント、コンピューターには影響しません。",
          "action": "キャッシュを消去"
        },
        "hub": {
          "title": "設定",
          "intro": "アカウント、請求、キー、エージェントのツール、そしてこのブラウザでの Hivra の表示。",
          "groups": {
            "account": "アカウント",
            "billing": "プランと請求",
            "connections": "キーと接続",
            "toolkit": "エージェントツール",
            "device": "このデバイス",
            "apps": "アプリとヘルプ",
            "reset": "このブラウザをリセット"
          },
          "profile": {
            "title": "プロフィールとサインイン",
            "signedInAs": "{email} でサインイン中",
            "fallback": "名前、メール、セキュリティ、サインアウト。",
            "selfHostTitle": "サインイン",
            "selfHostFallback": "このセルフホストの Hivra にサインイン中。",
            "signOut": "サインアウト",
            "signingOut": "サインアウト中…",
            "signOutFailed": "サインアウトできませんでした。もう一度お試しください。"
          },
          "rows": {
            "billing": { "description": "プラン、支払い方法、クレジット、請求書" },
            "wallets": { "title": "ウォレット", "description": "エージェントのウォレットと $HermesOS アクセス" },
            "apiKeys": { "title": "API キー", "description": "プロバイダーのキーと、それを使うエージェント" },
            "infrastructure": { "description": "エージェントが動くマシンとクラウドアカウント" },
            "memory": { "title": "共有エージェントメモリー", "description": "新しいエージェントが最初から知っていること" },
            "tools": { "title": "ツールと機能", "description": "選んだエージェントにツールを追加" },
            "library": { "title": "プロンプトライブラリ", "description": "検証済みプロンプト付きのエージェントロール" },
            "templates": { "title": "テンプレート", "description": "設定済みのエージェントを保存して再度起動" },
            "referral": { "title": "招待して獲得", "description": "リンクを共有して一緒にクレジットを獲得" },
            "applications": { "title": "アプリ", "description": "ブラウザまたは Web アプリで Hivra を使う" },
            "help": { "title": "ヘルプ", "description": "サポート、コミュニティ、法的情報" }
          },
          "motionNote": "動きはデバイスの「視差効果を減らす」設定に従います。",
          "clearCacheConfirm": "もう一度押すと消去して再読み込み",
          "clearCacheArmed": "4 秒以内にもう一度ボタンを押すと、キャッシュを消去して再読み込みします。"
        }
      },
      "userModeSuffix": "モード",
      "versionLabel": "Foundation v0.9.0"
    },
    "stats": {
      "hero": {
        "eyebrow": "ライブ · デプロイ済みエージェント",
        "label": "累計デプロイ",
        "fullStats": "詳細な統計 →"
      },
      "page": {
        "eyebrow": "ライブカウンター",
        "headlinePrefix": "Hivra で",
        "headlineEmphasis": "デプロイ",
        "headlineSuffix": "された AI エージェント",
        "body": "誰かがエージェントのデプロイに成功するたび、このカウンターが進みます。",
        "allTimeLabel": "累計成功デプロイ",
        "ariaTotal": "累計デプロイ済みエージェント",
        "cards": {
          "last24h": "過去 24 時間",
          "last7d": "過去 7 日間",
          "firstDeploy": "初回デプロイ"
        },
        "sparkline": {
          "titlePrefix": "日次デプロイ、",
          "titleEmphasis": "直近 30 日間",
          "hint": "バーをホバーまたはフォーカスすると正確な値が表示されます",
          "peak": "最大日",
          "total": "30 日間合計",
          "barLabel": "{date}: {count} 件"
        },
        "cta": {
          "button": "あなたのエージェントをデプロイ →",
          "subtitle": "無料プラン — エージェント 1、0.5 vCPU、1 GB RAM、常時稼働"
        }
      }
    },
    "footer": {
      "links": {
        "features": "機能",
        "compare": "比較",
        "blog": "ブログ",
        "roadmap": "ロードマップ",
        "tokenVerification": "トークン確認",
        "privacy": "プライバシー",
        "terms": "利用規約"
      }
    }
  },
  "ko": {
    "localeLabel": "한국어",
    "languageSelectorLabel": "언어",
    "nav": {
      "pricing": "가격",
      "roadmap": "로드맵",
      "tokenVerification": "토큰 확인",
      "register": "가입",
      "login": "로그인",
      "openDashboard": "대시보드 열기",
      "mobileMenu": "메뉴 열기",
      "closeMobileMenu": "메뉴 닫기"
    },
    "hero": {
      "eyebrow": "출시됨",
      "headlinePrefix": "당신의 AI 에이전트를,",
      "headlineEmphasis": "항상 온라인으로.",
      "primary": "Hivra는 Hermes Agent를 5분 안에 실행하고 지속 메모리, 브라우저 자동화, 도구 사용을 기본 제공합니다.",
      "secondary": "무료 플랜은 이미 열려 있습니다. Pro와 Power는 본격 워크로드용입니다.",
      "primaryCta": "무료로 시작",
      "secondaryCta": "작동 방식 보기",
      "proofPoints": [
        "항상 무료 플랜",
        "내 키 사용, 마진 없음",
        "Hermes Agent 기반"
      ]
    },
    "ticker": {
      "proofPoints": [
        "Hermes Agent(Nous Research) 기반",
        "내 키 사용, 수수료 없음",
        "Free 티어 상시 운영"
      ]
    },
    "positioning": {
      "title": "OpenClaw은 잊어버린다. Hermes는 쌓아간다.",
      "body": "Nous Research가 만든 Hermes는 서버에서 살아 숨 쉬며 모든 것을 기억합니다 — 프로젝트, 설정, 배운 것들까지. 세션마다 더 날카로워집니다. 셀프 호스팅을 설정하려면 대부분 주말 한 번이 필요합니다.",
      "punchline": "Hivra는 그 주말을 5분으로 줄입니다."
    },
    "features": {
      "eyebrow": "포함 기능",
      "titlePrefix": "에이전트에 필요한 모든 것.",
      "titleEmphasis": "불필요한 건 하나도 없이.",
      "items": [
        {
          "headline": "설정 제로. 풀스택.",
          "body": "브라우저 자동화, 도구 사용, 터미널, 메모리, cron — 모두 사전 구성됨. Docker도, 자정의 StackOverflow도 필요 없습니다."
        },
        {
          "headline": "첫날부터 멀티 에이전트.",
          "body": "단일 인스턴스에서 무제한 에이전트 프로필. 리서처, 오퍼레이터, 스페셜리스트 — 에이전트당 추가 비용 없음."
        },
        {
          "headline": "내 키. 수수료 없음.",
          "body": "OpenRouter, OpenAI, 또는 Anthropic. 저장 시 암호화, 배포 시 주입. 귀하의 AI 비용은 우리가 볼 수 없습니다."
        },
        {
          "headline": "어디서나 채팅.",
          "body": "스트리밍이 내장된 대시보드. Telegram, Discord, Slack, WhatsApp을 바로 연결 — 즉시 사용 가능."
        },
        {
          "headline": "OpenClaw 마이그레이션 내장.",
          "body": "기존 설정, 프롬프트, 스킬이 그대로 이전됩니다. 처음부터 다시 시작할 필요 없음."
        },
        {
          "headline": "안정적. 복구 가능. 항상 켜진 상태.",
          "body": "업데이트는 배포 전 컨테이너 설정으로 검증. 장애 시 자동 재시작. 매일 백업 — 클린 복구까지 항상 24시간 이내."
        }
      ]
    },
    "howItWorks": {
      "eyebrow": "작동 방식",
      "titlePrefix": "세 단계.",
      "titleEmphasis": "터미널 불필요.",
      "steps": [
        {
          "step": "1",
          "headline": "티어 선택",
          "body": "Free로 시작하고, 필요할 때 업그레이드하세요. 카드로 월 결제, 할인을 위한 연 결제, 또는 $HermesOS를 보유해 구독 없이 이용 가능."
        },
        {
          "step": "2",
          "headline": "AI 키 추가",
          "body": "OpenRouter, OpenAI, 또는 Anthropic 키를 한 번만 붙여넣으세요. 암호화, 주입, 완료."
        },
        {
          "step": "3",
          "headline": "배포. 대화. 자동화.",
          "body": "에이전트가 수분 내 가동됩니다 — 채팅, 터미널, 모니터링. Telegram 또는 Discord와 연결하면 어디서든 함께합니다."
        }
      ],
      "footer": "읽는 것에서 설정으로 넘어갈 준비가 됐나요? 티어를 선택하고 바로 계정 생성으로 이동하세요.",
      "cta": "티어 선택하기"
    },
    "useCases": {
      "eyebrow": "활용 사례",
      "titlePrefix": "메모리를 가진 24/7 에이전트는",
      "titleEmphasis": "실제로 무엇을 할까요?",
      "intro": "브라우징, 코딩, 파일 관리, API 호출, cron 작업 — 자율적으로. 그리고 지난주에 배운 것도 기억합니다.",
      "items": [
        {
          "headline": "DevOps & 모니터링",
          "body": "로그를 읽고, 실패한 서비스를 재시작하며, 사람이 실제로 필요할 때만 알림. 귀하의 스택을 기억합니다."
        },
        {
          "headline": "리서치 & 경쟁사 인텔리전스",
          "body": "주제와 마감일을 주면, 브라우징하고 집계해 구조화된 브리핑을 제공 — 다음을 위해 배운 것도 저장합니다."
        },
        {
          "headline": "백그라운드 자동화",
          "body": "이메일 분류, 일정 관리, API 호출, 스프레드시트 — 반복 작업 모두. 잠든 사이 cron으로 실행됩니다."
        },
        {
          "headline": "고객 지원 분류",
          "body": "문서를 입력해 두세요. 일반 티켓을 처리하고, 어려운 건 에스컬레이션하며, 대화마다 더 똑똑해집니다."
        }
      ],
      "footer": "Hermes가 처리할 수 있는 업무를 확인하셨나요? 플랜을 선택하고 워크로드에 맞는 워크플로를 시작하세요.",
      "cta": "플랜 보기 & 시작"
    },
    "whatsComing": {
      "eyebrow": "출시 예정",
      "titlePrefix": "이건 시작일",
      "titleEmphasis": "뿐입니다.",
      "intro": "호스팅은 토대입니다. 곧 출시 예정:",
      "items": [
        {
          "title": "Operator Packs",
          "body": "특정 업무를 위한 사전 제작 에이전트 템플릿 — 리서치, 트레이딩 인텔, 콘텐츠 자동화. 원클릭으로 배포."
        },
        {
          "title": "Marketplace",
          "body": "오퍼레이터 팩을 만들어 커뮤니티에 배포하고 사용량에서 수익을 얻으세요. $HermesOS로 정산."
        },
        {
          "title": "Agent Endpoints",
          "body": "에이전트를 호출 가능한 API로 공개하세요. 다른 에이전트가 요청당 비용을 지불합니다."
        },
        {
          "title": "Hive Mind",
          "body": "에이전트들이 배운 것을 공유합니다. 네트워크 전체가 함께 더 똑똑해집니다."
        }
      ],
      "footer": "Hivra는 에이전트 경제를 위한 인프라입니다. 호스팅이 첫 번째 단계이며, 나머지 모든 것이 그 위에 구축됩니다."
    },
    "pricing": {
      "eyebrow": "요금제",
      "titlePrefix": "간단한 플랜.",
      "titleEmphasis": "강력한 컴퓨팅.",
      "intro": "전용 컴퓨팅. 무제한 에이전트 프로필. 내 키 사용, 수수료 없음.",
      "compute": "컴퓨팅",
      "mostPopular": "가장 인기 있음",
      "forPros": "전문가용",
      "getStarted": "시작하기",
      "recommended": "추천",
      "accessPrefix": "이용 방법 세 가지",
      "footnote": "$HermesOS 결제 시 최대 40% 절약. 첫 번째 웨이브를 위한 런칭 요금 — 플랫폼 성숙에 따라 조정될 수 있습니다.",
      "guarantee": "Free 티어 — 업그레이드 전 체험 · 카드 결제 48시간 환불",
      "tiers": [
        {
          "name": "Free",
          "tagline": "대부분의 사용자는 카드 없이 시작할 수 있습니다. 위험도가 높은 Free 티어 배포는 카드 인증이 먼저 필요할 수 있습니다.",
          "price": "$0",
          "priceNote": "항상 무료; 위험 확인이 필요한 경우에만 카드",
          "specs": [
            {
              "label": "vCPU",
              "value": "0.5"
            },
            {
              "label": "RAM",
              "value": "1 GB"
            },
            {
              "label": "활성 에이전트",
              "value": "1"
            }
          ],
          "features": [
            "영구 메모리",
            "모든 통합 포함",
            "합리적 사용 제한 적용"
          ],
          "ctaLabel": "무료로 시작"
        },
        {
          "name": "Pro",
          "tagline": "실험이 아닌 실제 작업을 위해.",
          "price": "$9.99",
          "priceCadence": "/월",
          "priceNote": "카드로 월 구독",
          "specs": [
            {
              "label": "vCPU",
              "value": "2"
            },
            {
              "label": "RAM",
              "value": "4 GB"
            },
            {
              "label": "동시 에이전트",
              "value": "3",
              "tooltip": "같은 순간에 작업을 실행할 수 있는 에이전트 수. 프로필은 무제한 — 이것은 동시 실행 상한선입니다."
            }
          ],
          "features": [
            "무제한 에이전트 프로필",
            "Free의 모든 기능 포함",
            "Free 티어 대비 우선권"
          ],
          "paymentPaths": [
            {
              "label": "월간 카드",
              "detail": "$9.99/mo"
            },
            {
              "label": "연간",
              "detail": "$79/년 카드 · $49/년 $HermesOS"
            },
            {
              "label": "$HermesOS 보유",
              "detail": "~$99 (출시 가격, 첫 30일)"
            }
          ],
          "ctaLabel": "Pro 시작"
        },
        {
          "name": "Power",
          "tagline": "본격적인 워크플로와 멀티 에이전트 운영을 위해.",
          "price": "$19.99",
          "priceCadence": "/월",
          "priceNote": "카드로 월 구독",
          "specs": [
            {
              "label": "vCPU",
              "value": "4"
            },
            {
              "label": "RAM",
              "value": "8 GB"
            },
            {
              "label": "동시 에이전트",
              "value": "무제한",
              "tooltip": "컴퓨팅 풀이 지원하는 만큼 에이전트를 동시에 실행 — 여러 에이전트가 병렬로 작업, 플랫폼 상한선 없음."
            }
          ],
          "features": [
            "무제한 에이전트 프로필",
            "Pro의 모든 기능 포함",
            "여유 용량 시 CPU 버스트"
          ],
          "paymentPaths": [
            {
              "label": "월간 카드",
              "detail": "$19.99/mo"
            },
            {
              "label": "연간",
              "detail": "$149/년 카드 · $99/년 $HermesOS"
            },
            {
              "label": "$HermesOS 보유",
              "detail": "~$199 (출시 가격, 첫 30일)"
            }
          ],
          "ctaLabel": "Power 시작"
        }
      ]
    },
    "token": {
      "eyebrow": "$HermesOS 소개",
      "title": "플랫폼의 접근 레이어.",
      "body": "$HermesOS로 구독을 할인 결제하거나, 보유하여 월 결제 없이 티어를 유지하거나, 에이전트 경제 전반에서 거래하세요.",
      "secondary": "토큰은 Hivra 이용에 필수가 아닙니다 — Free 티어는 없이도 이용 가능하며, 필요한 경우 어뷰징 방지 확인이 적용됩니다. 생태계에 더 깊이 참여하고 싶다면 $HermesOS 보유로 결제 및 접근 방식에서 더 많은 유연성을 얻을 수 있습니다.",
      "cta": "토큰 인증 페이지"
    },
    "faq": {
      "eyebrow": "자주 묻는 질문",
      "title": "명확한 답변.",
      "items": [
        {
          "q": "API 키는 안전한가요?",
          "a": "네. 저장 시 암호화되고, 배포 시 환경 변수로 주입됩니다. AI 요청을 프록시하거나 로그에 기록하지 않습니다."
        },
        {
          "q": "업데이트가 설정을 망가뜨릴 수 있나요?",
          "a": "아니요. 모든 업데이트는 배포 전 컨테이너 설정으로 검증됩니다. 매일 백업으로 클린 복구까지 항상 24시간 이내입니다."
        },
        {
          "q": "OpenClaw과 어떻게 다른가요?",
          "a": "OpenClaw은 우수한 오픈 소스 데스크탑 프레임워크입니다. Hivra는 완전 관리형 프로덕션급 클라우드 환경입니다. Hermes Agent는 더 안정적인 메모리, 높은 신뢰성, 기존 기능을 망가뜨리지 않는 업데이트를 제공합니다."
        },
        {
          "q": "에이전트가 충돌하면 어떻게 되나요?",
          "a": "자동으로 재시작됩니다. 상태, 로그, 리소스 사용량은 대시보드에서 항상 확인 가능합니다."
        },
        {
          "q": "하나의 플랜으로 여러 에이전트를 실행할 수 있나요?",
          "a": "네 — 인스턴스당 무제한 프로필. Free는 활성 에이전트 1개, Pro는 3개, Power는 동시 실행 제한 없음. 컴퓨팅 풀이 유일한 실질적 한계입니다."
        },
        {
          "q": "어떤 AI 공급자가 지원되나요?",
          "a": "OpenRouter, OpenAI, Anthropic. OpenRouter만으로도 단일 키로 수백 개의 모델을 사용할 수 있습니다."
        },
        {
          "q": "플랫폼을 이용하려면 $HermesOS가 필요한가요?",
          "a": "아니요. Free 티어는 필요하지 않습니다. Pro와 Power는 카드로 결제할 수 있습니다. 토큰은 원하는 분들을 위한 할인과 세 번째 결제 수단을 제공합니다."
        },
        {
          "q": "다음에 무엇이 출시되나요?",
          "a": "오퍼레이터 팩(사전 제작 에이전트 템플릿)이 몇 주 내로 출시됩니다. Marketplace, 에이전트 엔드포인트, Hive Mind가 뒤따릅니다. 로드맵은 hermesos.cloud/roadmap에서 확인하세요."
        }
      ]
    },
    "finalCta": {
      "eyebrow": "지금 시작",
      "title": "배포할 준비가 됐나요?",
      "body": "Free 티어가 어뷰징 방지와 함께 운영 중입니다. Pro와 Power는 지금 이용 가능합니다.",
      "primary": "무료로 시작",
      "secondary": "요금제 보기",
      "note": "대부분의 무료 사용자는 카드 없이 시작 가능합니다. 위험도가 높은 가입은 카드 등록 확인이 필요할 수 있습니다.",
      "accountPrefix": "이미 계정이 있으신가요?",
      "accountLink": "로그인"
    },
    "getStarted": {
      "loadingCheckout": "결제 페이지로 이동 중...",
      "steps": {
        "choosePlan": "플랜 선택",
        "createAccount": "계정 만들기",
        "activate": "활성화",
        "payment": "결제"
      },
      "badges": {
        "free": "항상 무료",
        "paid": "7일 환불 보장"
      },
      "yourPlan": "내 플랜",
      "perMonth": "/월",
      "perYear": "/년",
      "cadence": {
        "monthly": "월간",
        "yearly": "연간",
        "saveLabel": "약 {percent}% 절약",
        "saveDollarsLabel": "연 약 ${dollars} 절약"
      },
      "marketAnchor": "비슷한 에이전트 플랫폼은 월 $19 정도부터 시작합니다",
      "mostPopular": "가장 인기",
      "freeGap": "웹 브라우징 없음 · 영구 메모리 없음 · 예약 작업 없음 · 0.5 vCPU",
      "specs": {
        "agents": "에이전트",
        "cpu": "CPU",
        "ram": "RAM"
      },
      "guarantee": {
        "free": "결제 불필요",
        "paid": "7일 환불 보장"
      },
      "switchPlan": "플랜 변경",
      "bestFit": "최적 선택",
      "planGuidance": {
        "free": "Free는 하나의 보호된 에이전트로 Hermes를 체험하기에 가장 적합합니다. 대부분의 사용자는 카드 없이 시작할 수 있으며, 위험도가 높은 Free 티어 배포는 카드 인증이 필요할 수 있습니다.",
        "operator": "Pro는 개인 빌더, 해커톤 프로젝트, 에이전트를 빠르게 가동하는 데 가장 적합합니다.",
        "fleet": "Power는 멀티 에이전트 워크플로, 무거운 브라우징, 즉각적으로 더 많은 컴퓨팅 여유를 원하는 팀에 가장 적합합니다.",
        "command": "Command는 최대 규모의 워크로드, 가장 빠른 확장 경로, 배포당 최대 컴퓨팅에 가장 적합합니다."
      },
      "createAccountTitle": "계정을 만드세요.",
      "createAccountIntroFree": "계정 정보가 로그인 자격 증명이 됩니다. 가입 후 Free 플랜을 활성화하고 배포로 바로 이동합니다. 대부분의 사용자는 카드 없이 시작할 수 있으며, 위험도가 높은 Free 티어 배포는 카드 인증이 필요할 수 있습니다.",
      "createAccountIntroPaid": "계정 정보가 로그인 자격 증명이 됩니다. 가입 후 안전한 결제 단계로 진행됩니다. 7일 환불 보장이 적용됩니다.",
      "legalPrefix": "계속 진행하면 다음에 동의하는 것입니다:",
      "terms": "이용약관",
      "and": "및",
      "privacy": "개인정보처리방침"
    },
    "dashboard": {
      "nav": {
        "chat": "채팅",
        "commandCenter": "명령 센터",
        "home": "홈",
        "computers": "컴퓨터",
        "agents": "에이전트",
        "infrastructure": "인프라",
        "collaboration": "협업",
        "settings": "설정",
        "launch": "시작",
        "ops": "운영",
        "promptLibrary": "프롬프트 라이브러리",
        "wallet": "지갑",
        "billing": "청구"
      },
      "sections": {
        "advanced": "고급",
        "support": "지원"
      },
      "support": {
        "discord": "Discord",
        "xTwitter": "X (Twitter)",
        "email": "이메일 지원"
      },
      "legal": {
        "terms": "약관",
        "privacy": "개인정보"
      },
      "controls": {
        "expandSidebarTitle": "사이드바 펼치기",
        "collapseSidebarTitle": "사이드바 접기",
        "expandSidebarLabel": "대시보드 사이드바 펼치기",
        "collapseSidebarLabel": "대시보드 사이드바 접기",
        "globalSettings": "전역 설정"
      },
      "commandCenter": {
        "phase": "Phase II: 플리트 운영",
        "titlePrefix": "커맨드",
        "titleSeparator": " ",
        "titleEmphasis": "센터",
        "titleSuffix": ".",
        "labelSeparator": ": ",
        "sections": {
          "activeAgents": "활성 에이전트",
          "activeCoreInstances": "활성 코어 인스턴스",
          "infrastructureNodes": "인프라 노드"
        },
        "actions": {
          "advancedConsole": "고급 콘솔",
          "applyChanges": "변경 사항 적용",
          "applying": "적용 중...",
          "cancel": "취소",
          "confirmRemove": "제거 확인",
          "coreConsole": "코어 콘솔",
          "initializeAgent": "에이전트 초기화",
          "manageAllocation": "할당 관리",
          "removeNode": "노드 제거",
          "removing": "제거 중..."
        },
        "alerts": {
          "activeFailureTitle": "즉각 조치가 필요한 활성 장애",
          "activeFailurePrefix": "Hermes가 활성 장애를 감지했습니다",
          "activeFailureSingular": "인스턴스",
          "activeFailurePlural": "인스턴스",
          "activeFailureSuffix": "각 항목에 다음 조치 담당자가 표시됩니다.",
          "recoveryPrefix": "복구",
          "updateTitle": "업데이트 확인 필요",
          "updateSummaryPrefix": "Hermes가 업데이트 문제를 감지했습니다",
          "updateSummarySingular": "인스턴스",
          "updateSummaryPlural": "인스턴스",
          "updateSummarySuffix": "마운트된 Docker 데이터는 유지되지만 이 에이전트들은 빠른 확인이 필요합니다.",
          "scheduledUpdateFailed": "마지막 자동 업데이트가 실패했습니다. Docker 볼륨은 마운트된 상태를 유지하지만 이 인스턴스는 빠른 확인이 필요합니다.",
          "manualUpdateFailed": "마지막 수동 업데이트가 실패했습니다. Docker 볼륨은 마운트된 상태를 유지하지만 이 인스턴스는 빠른 확인이 필요합니다."
        },
        "status": {
          "running": "실행 중",
          "provisioning": "프로비저닝 중",
          "stopped": "중지됨",
          "error": "오류",
          "failed": "실패"
        },
        "instance": {
          "activeAgentSingular": "활성 에이전트",
          "activeAgentPlural": "활성 에이전트",
          "configuredInAgentSettings": "에이전트 설정에서 구성됨",
          "coreSingular": "코어",
          "corePlural": "코어",
          "fetchingProfiles": "프로필 불러오는 중...",
          "hostInstancePrefix": "호스트 인스턴스",
          "idPrefix": "ID",
          "primaryAgent": "기본 에이전트",
          "profileNode": "프로필 노드",
          "secondaryAgent": "보조 에이전트"
        },
        "telemetry": {
          "activeModel": "활성 모델",
          "containerState": "컨테이너 상태",
          "cpuUtilization": "CPU 사용률",
          "hostComputeNode": "호스트 컴퓨팅 노드",
          "limitPrefix": "한도",
          "llmInferenceEngine": "LLM 추론 엔진",
          "memoryAllocation": "메모리 할당",
          "networkIo": "네트워크 I/O",
          "provider": "공급자",
          "providerPrefix": "공급자",
          "totalTxPrefix": "총 Tx",
          "unrestricted": "무제한",
          "uptimePrefix": "가동 시간"
        },
        "allocation": {
          "cpuAllocated": "할당된 CPU",
          "cpuAllocation": "CPU 할당",
          "cpuCapacityError": "총 CPU 할당({allocated})이 노드 용량({capacity})을 초과합니다.",
          "dangerZone": "위험 구역",
          "deleteConfirmationPhrase": "삭제",
          "deletePromptPrefix": "",
          "deletePromptSuffix": "를 입력하여 제거를 확인하세요. 이 작업은 인프라와 그 위의 오프라인 에이전트를 영구적으로 삭제합니다.",
          "failedToRemoveHost": "호스트 제거 실패",
          "memoryAllocated": "할당된 메모리",
          "memoryAllocation": "메모리(RAM) 할당",
          "memoryCapacityError": "총 메모리 할당({allocated}GB)이 노드 용량({capacity}GB)을 초과합니다.",
          "noActiveAgents": "이 노드에 활성 에이전트가 없습니다.",
          "nodeAllocationPrefix": "노드 할당",
          "projectedNodeUsage": "예상 노드 사용량"
        },
        "errors": {
          "failedToLoadOperations": "운영 데이터 로드 실패"
        }
      },
      "library": {
        "returnToCommandCenter": "명령 센터로 돌아가기",
        "titlePrefix": "프롬프트",
        "titleSeparator": " ",
        "titleEmphasis": "라이브러리",
        "titleSuffix": ".",
        "intro": "검증된 시스템 프롬프트를 갖춘 고도로 전문화된 에이전트 템플릿을 배포하세요. 프리미엄 Agency 청사진에서 엄선되었습니다.",
        "sourcePrefix": "템플릿 출처:",
        "sourceLinkLabel": "Michal Sitarzewski의 Agency Agents",
        "sourceSuffix": ".",
        "searchPlaceholder": "이름 또는 설명으로 템플릿 검색...",
        "featured": "추천",
        "allTemplates": "모든 템플릿",
        "viewPrompt": "프롬프트 보기",
        "deploy": "배포",
        "empty": "조건에 맞는 템플릿을 찾을 수 없습니다",
        "copied": "복사됨!",
        "copyPrompt": "프롬프트 복사",
        "deployTemplate": "이 템플릿 배포",
        "closePreview": "프롬프트 미리보기 닫기",
        "categories": {
          "All": "전체",
          "Engineering": "엔지니어링",
          "Design": "디자인",
          "Marketing": "마케팅",
          "Product": "제품",
          "Operations": "운영",
          "Research": "리서치",
          "Security": "보안",
          "Finance": "금융"
        }
      },
      "wallet": {
        "eyebrowLegacy": "지갑 · 입금 및 출금",
        "eyebrowSelfCustody": "지갑 · 서명 확인",
        "titlePrefix": "내",
        "titleSeparator": " ",
        "titleEmphasis": "$HermesOS",
        "titleSuffix": " 지갑.",
        "legacyIntroStrong": "레거시 수탁 지갑",
        "legacyIntroBody": "기존 입출금 플로우가 계속 활성 상태입니다. 원하는 티어의 $HERMESOS 가격을 오늘 잠그고, 입금 주소로 견적 금액을 보내세요. Free 티어는 입금 없이 항상 이용 가능합니다.",
        "selfCustodyIntroStrong": "내 지갑 연결",
        "selfCustodyIntroBody": "$HermesOS와 VVV를 직접 보유하고, 메시지에 서명해 소유권을 인증하세요. Free 티어는 토큰 인증 없이 항상 이용 가능합니다.",
        "priceUnavailable": "토큰 가격을 불러올 수 없습니다 — 나중에 다시 시도하세요.",
        "buyToken": {
          "ariaLabel": "$HermesOS 구매",
          "eyebrow": "$HermesOS 구하기",
          "title": "Uniswap(Base 네트워크)에서 구매.",
          "action": "Uniswap에서 구매 →",
          "contractLabel": "컨트랙트 주소(Base)",
          "copyContractLabel": "컨트랙트 주소 복사",
          "copied": "복사됨",
          "copy": "복사",
          "warningPrefix": "항상 컨트랙트 주소를",
          "warningLink": "hermesos.cloud/token",
          "warningSuffix": "에서 확인하세요. DM, 답글, 스크린샷에서 복사한 주소는 무시하세요."
        },
        "verification": {
          "ariaLabel": "지갑 인증",
          "eyebrow": "자기 수탁 인증",
          "connectedTitle": "지갑 연결됨.",
          "disconnectedTitle": "지갑에서 확인하세요.",
          "activeWallet": "활성 지갑",
          "lastCheckedPrefix": "마지막 확인",
          "connecting": "연결 중...",
          "checking": "확인 중...",
          "connectWallet": "지갑 연결",
          "changeWallet": "지갑 변경",
          "refreshBalance": "잔액 새로고침",
          "checkLock": "{tier} 잠금 확인",
          "lockPrice": "{tier} 가격 잠금",
          "lockedFor20": "{tier} 가격이 20분간 잠겼습니다:",
          "holdAtLeastThatAmount": "잠금이 만료되기 전에 이 지갑에 해당 금액 이상을 보유하세요.",
          "yourRateLockedAt": "{tier} 요금이 잠겼습니다:",
          "lockNext": "{tier} 가격을 잠가서 해당 티어를 원하는 경우 다음에 활성화하세요.",
          "keepEligible": "자격을 유지하려면 이 지갑에 해당 금액을 유지하세요.",
          "detected": "감지됨",
          "snapshotInstruction": "{tier} 가격을 잠가 토큰 수량을 20분간 스냅샷하세요.",
          "refreshInstruction": "잔액을 새로고침하여 현재 티어를 확인하세요.",
          "connectedFootnote": "한 번에 하나의 지갑만 활성화할 수 있습니다. 지갑을 변경하면 활성 지갑이 교체되며, 서명으로는 토큰을 이동할 수 없습니다.",
          "disconnectedBody": "$HermesOS와 VVV를 자신의 Base 지갑에 보유하세요. 서명된 메시지로 Hivra에 토큰을 보내지 않고도 소유권을 증명합니다.",
          "verifiedSuffix": "인증됨."
        },
        "eligibility": {
          "ariaLabel": "티어 자격",
          "eyebrow": "티어 자격",
          "currentBalancePrefix": "현재 잔액:",
          "autoRefreshPrefix": "5분마다 자동 새로고침 · 마지막 확인",
          "refreshBalanceLabel": "잔액 새로고침",
          "refresh": "새로고침",
          "thresholdsMissing": "티어 기준이 아직 설정되지 않았습니다. 자격이 평가되지 않습니다. 입금 플로우가 시작되면 다시 확인하세요.",
          "proTier": "Pro 티어",
          "powerTier": "Power 티어",
          "eligible": "자격 있음",
          "breached": "위반 — 자격 종료",
          "notYetEligible": "아직 자격 없음",
          "holdAtLeast": "최소 보유",
          "depositAtLeast": "최소 입금",
          "selfCustodyQualifySuffix": "인증된 지갑에 보유하여 구독 없이 {tier} 티어 자격을 얻으세요.",
          "custodyQualifySuffix": "구독 없이 {tier} 티어 자격을 얻으세요.",
          "lockedAtPrice": "견적 가격으로 잠김 — 견적 만료 시 새로고침됩니다."
        },
        "agentWallets": {
          "ariaLabel": "에이전트 지갑",
          "title": "에이전트 지갑.",
          "subtitle": "에이전트당 하나 · 내 Bankr 계정 · Base 전용",
          "emptyNoAgents": "에이전트를 실행한 뒤 내 Bankr 계정을 연결해 지갑을 설정하세요.",
          "deployAgent": "에이전트 배포",
          "runningEmpty": "실행 중인 에이전트가 여기에 표시됩니다."
        }
      },
      "billing": {
        "eyebrow": "청구 및 구독",
        "titlePrefix": "플랜",
        "titleSeparator": " ",
        "titleEmphasis": "관리",
        "titleSuffix": ".",
        "subtitle": "요금제, 결제 방법, 사용량.",
        "refreshing": "새로고침 중…",
        "credits": {
          "title": "크레딧 잔액",
          "available": "사용 가능",
          "description": "계정 크레딧은 사용료를 결제합니다. 요금제는 크레딧이 아니라 구독, $HermesOS 연간 결제 또는 $HermesOS 보유로 정해집니다.",
          "monthlyGrantSuffix": "월간 플랜 크레딧"
        },
        "activity": {
          "eyebrow": "결제 내역",
          "title": "최근 계정 활동",
          "loading": "로딩 중",
          "ledger": "원장",
          "ledgerLoading": "원장 로딩 중...",
          "ledgerEmpty": "원장 항목이 없습니다.",
          "payments": "결제",
          "paymentsLoading": "결제 내역 로딩 중...",
          "paymentsEmpty": "결제 내역이 없습니다.",
          "compute": "컴퓨팅",
          "computeLoading": "컴퓨팅 로딩 중...",
          "computeEmpty": "컴퓨팅 사용 내역이 없습니다.",
          "llm": "LLM",
          "llmLoading": "LLM 로딩 중...",
          "llmEmpty": "LLM 사용 내역이 없습니다."
        },
        "tokenAccess": {
          "eyebrow": "토큰 접근",
          "title": "$HermesOS 보유",
          "description": "검증된 지갑에 최소 수량 이상의 $HermesOS를 보유하면 기본 머신이 열립니다. 잔액이 최소 수량 아래로 내려가면 해당 머신의 에이전트는 유예 기간 동안 계속 실행된 뒤, 다시 충분히 보유할 때까지 일시 중지됩니다.",
          "checking": "확인 중",
          "unavailable": "이용 불가",
          "ready": "최소 수량 충족",
          "belowMinimum": "최솟값 미달",
          "noWallet": "인증된 지갑 없음",
          "wallet": "지갑",
          "balance": "잔액",
          "minimum": "최솟값",
          "notVerified": "인증되지 않음",
          "noSnapshot": "스냅샷 없음",
          "refresh": "토큰 상태 새로고침",
          "refreshing": "새로고침 중...",
          "connectWallet": "지갑 연결",
          "connecting": "연결 중...",
          "verifyDifferent": "다른 지갑 인증"
        },
        "cryptoCredits": {
          "eyebrow": "크립토 크레딧",
          "description": "금액을 선택하면 Base에서 USDC를 보낼 주소를 드립니다. 전송이 확인되면 크레딧이 추가됩니다.",
          "bonusPath": "보너스 경로 준비됨",
          "pendingDeposit": "대기 중인 입금",
          "createTopUpLabel": "{credits} 크레딧을 위한 USDC 충전 생성",
          "sendPrefix": "전송",
          "onNetwork": "네트워크:",
          "reference": "참조"
        },
        "activePlan": {
          "title": "현재 플랜",
          "heldViaTokens": "$HERMESOS 보유",
          "perMonth": "/월",
          "agents": "에이전트",
          "cpuBudget": "CPU 예산",
          "ramBudget": "RAM 예산",
          "manageSubscription": "구독 관리",
          "opening": "열리는 중..."
        },
        "switcher": {
          "title": "플랜 변경",
          "description": "언제든지 업그레이드. 다운그레이드는 불가 — 전용 서버는 축소할 수 없습니다.",
          "currentPlan": "현재 플랜",
          "upgrade": "업그레이드",
          "lowerTier": "하위 티어",
          "unlimited": "무제한",
          "agents": "에이전트",
          "active": "활성",
          "guarantee": "48시간 환불 정책 · 업그레이드 전용 플랜"
        },
        "noSubscription": {
          "title": "활성 구독 없음"
        },
        "plate": {
          "slots": "슬롯",
          "vcpu": "vCPU",
          "memory": "메모리",
          "idlePolicy": "유휴 정책",
          "alwaysOn": "항상 켜짐",
          "sleepsAfterIdle": "{days}일 유휴 시 절전"
        }
      },
      "settings": {
        "loading": "로딩 중...",
        "returnToCommandCenter": "명령 센터로 돌아가기",
        "titlePrefix": "전역",
        "titleSeparator": " ",
        "titleEmphasis": "설정",
        "titleSuffix": ".",
        "intro": "워크스페이스, 인터페이스 테마, 앱 동작을 설정하세요.",
        "sections": {
          "appearance": "외관",
          "chatInterface": "채팅 & 에이전트 인터페이스",
          "capabilities": "기능 & 플러그인",
          "dangerZone": "위험 구역"
        },
        "theme": {
          "label": "테마",
          "description": "라이트, 다크 또는 기기 설정 따르기.",
          "light": "라이트",
          "dark": "다크",
          "system": "시스템"
        },
        "language": {
          "label": "사이트 언어",
          "description": "Hivra에서 사용할 언어를 선택하세요."
        },
        "reducedMotion": {
          "label": "모션 줄이기",
          "description": "전환 효과와 무거운 UI 애니메이션을 최소화합니다."
        },
        "autoScroll": {
          "label": "채팅 자동 스크롤",
          "description": "새 메시지가 도착하면 자동으로 하단에 고정합니다."
        },
        "streamingAnimations": {
          "label": "스트리밍 애니메이션",
          "description": "에이전트 스트림 수신 시 페이드인 마크다운 효과를 표시합니다."
        },
        "aiReasoning": {
          "label": "AI 추론 자동 펼치기",
          "description": "AI의 \"생각\" 블록을 자동으로 펼쳐서 시작합니다."
        },
        "persistentMemory": {
          "label": "영구 메모리 활성화",
          "description": "Hermes가 플러그인 가능한 메모리 공급자를 사용해 세션 간 MEMORY.md에 자체 기억을 작성하도록 허용합니다."
        },
        "plugins": {
          "label": "확장 플러그인 / 스킬 활성화",
          "description": "Hermes에게 업스트림 MCP/ACP 스킬과 실험적 도구에 대한 접근을 부여합니다."
        },
        "clearCache": {
          "label": "로컬 캐시 지우기",
          "description": "이 브라우저에 캐시된 대시보드 데이터와 여기에 저장된 레이아웃 선택(터미널 탭 등)을 지운 뒤 페이지를 새로고침합니다. 계정, 에이전트, 컴퓨터에는 영향이 없습니다.",
          "action": "캐시 지우기"
        },
        "hub": {
          "title": "설정",
          "intro": "계정, 결제, 키, 에이전트 도구, 그리고 이 브라우저에서 Hivra가 보이는 방식.",
          "groups": {
            "account": "계정",
            "billing": "요금제 및 결제",
            "connections": "키 및 연결",
            "toolkit": "에이전트 도구",
            "device": "이 기기",
            "apps": "앱 및 도움말",
            "reset": "이 브라우저 초기화"
          },
          "profile": {
            "title": "프로필 및 로그인",
            "signedInAs": "{email}(으)로 로그인됨",
            "fallback": "이름, 이메일, 보안, 로그아웃.",
            "selfHostTitle": "로그인",
            "selfHostFallback": "이 셀프 호스팅 Hivra에 로그인됨.",
            "signOut": "로그아웃",
            "signingOut": "로그아웃 중…",
            "signOutFailed": "로그아웃하지 못했습니다. 다시 시도하세요."
          },
          "rows": {
            "billing": { "description": "요금제, 결제 수단, 크레딧, 청구서" },
            "wallets": { "title": "지갑", "description": "에이전트 지갑과 $HermesOS 이용 권한" },
            "apiKeys": { "title": "API 키", "description": "제공업체 키와 이를 쓰는 에이전트" },
            "infrastructure": { "description": "에이전트가 실행되는 머신과 클라우드 계정" },
            "memory": { "title": "공유 에이전트 메모리", "description": "새 에이전트가 처음부터 알고 있는 내용" },
            "tools": { "title": "도구 및 기능", "description": "원하는 에이전트에 도구 추가" },
            "library": { "title": "프롬프트 라이브러리", "description": "검증된 프롬프트가 담긴 에이전트 역할" },
            "templates": { "title": "템플릿", "description": "설정한 에이전트를 저장하고 다시 실행" },
            "referral": { "title": "초대하고 받기", "description": "링크를 공유하고 함께 크레딧 받기" },
            "applications": { "title": "앱", "description": "브라우저나 웹 앱으로 Hivra 사용" },
            "help": { "title": "도움말", "description": "지원, 커뮤니티, 법적 정보" }
          },
          "motionNote": "모션은 기기의 '동작 줄이기' 설정을 따릅니다.",
          "clearCacheConfirm": "한 번 더 누르면 지우고 새로고침",
          "clearCacheArmed": "4초 안에 버튼을 다시 누르면 캐시를 지우고 새로고침합니다."
        }
      },
      "userModeSuffix": "모드",
      "versionLabel": "Foundation v0.9.0"
    },
    "stats": {
      "hero": {
        "eyebrow": "라이브 · 배포된 에이전트",
        "label": "누적 배포",
        "fullStats": "전체 통계 →"
      },
      "page": {
        "eyebrow": "라이브 카운터",
        "headlinePrefix": "Hivra에서",
        "headlineEmphasis": "배포된",
        "headlineSuffix": "AI 에이전트",
        "body": "누군가 에이전트를 성공적으로 배포할 때마다 이 카운터가 올라갑니다.",
        "allTimeLabel": "누적 성공 배포",
        "ariaTotal": "누적 배포된 에이전트",
        "cards": {
          "last24h": "지난 24시간",
          "last7d": "지난 7일",
          "firstDeploy": "첫 배포"
        },
        "sparkline": {
          "titlePrefix": "일일 배포,",
          "titleEmphasis": "지난 30일",
          "hint": "막대 위에 마우스를 올리거나 포커스하면 정확한 값이 표시됩니다",
          "peak": "최고일",
          "total": "30일 합계",
          "barLabel": "{date}: {count}건"
        },
        "cta": {
          "button": "에이전트 배포 →",
          "subtitle": "무료 플랜 — 에이전트 1개, 0.5 vCPU, 1 GB RAM, 항상 활성"
        }
      }
    },
    "footer": {
      "links": {
        "features": "기능",
        "compare": "비교",
        "blog": "블로그",
        "roadmap": "로드맵",
        "tokenVerification": "토큰 확인",
        "privacy": "개인정보",
        "terms": "약관"
      }
    }
  }
} satisfies Record<Exclude<Locale, typeof DEFAULT_LOCALE | typeof CHINESE_LOCALE>, DeepPartial<BaseMarketingCopy>>;

export const MARKETING_COPY: Record<Locale, BaseMarketingCopy> = {
  ...BASE_MARKETING_COPY,
  es: mergeCopy<BaseMarketingCopy>(BASE_MARKETING_COPY.en, LOCALE_COPY_OVERRIDES.es),
  "pt-BR": mergeCopy<BaseMarketingCopy>(BASE_MARKETING_COPY.en, LOCALE_COPY_OVERRIDES["pt-BR"]),
  fr: mergeCopy<BaseMarketingCopy>(BASE_MARKETING_COPY.en, LOCALE_COPY_OVERRIDES.fr),
  de: mergeCopy<BaseMarketingCopy>(BASE_MARKETING_COPY.en, LOCALE_COPY_OVERRIDES.de),
  ja: mergeCopy<BaseMarketingCopy>(BASE_MARKETING_COPY.en, LOCALE_COPY_OVERRIDES.ja),
  ko: mergeCopy<BaseMarketingCopy>(BASE_MARKETING_COPY.en, LOCALE_COPY_OVERRIDES.ko),
};
