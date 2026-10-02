import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "byo-api-key-explained",
  title: "BYO API key: what it means and why it matters",
  metaTitle: "What a BYO API key means for cost and privacy",
  metaDescription:
    "With a BYO API key you use your own Anthropic, OpenAI or OpenRouter account, so the provider bills you directly and your tokens carry no markup.",
  publishedDate: "2026-03-21",
  lastModified: "2026-09-30",
  readingTimeMin: 6,
  author: "Hivra team",
  tagline: "Bring your own key and the provider bills you directly: no markup, and no Hivra proxy in between.",
  intro:
    "BYO means bring your own: you supply the AI provider credentials your agent uses. Requests go straight from the agent to the model provider, and the provider sends you the bill. Hivra isn't in that loop.",
  shortAnswer:
    "A BYO API key means you bring your own AI provider credentials. Your agent's requests go straight to the provider, which bills you for that usage, so there's no markup on tokens. You pay Hivra for managed hosting and the dashboard, and your prompts don't pass through a Hivra proxy.",
  sections: [
    {
      heading: "How the two billing models compare",
      paragraphs: [
        "Most AI SaaS products buy tokens wholesale, mark them up, and bundle AI usage into the subscription fee. Convenient, but you are paying the markup and have limited visibility into how much you are actually using.",
        `In the BYO key model, you create a developer account directly with the provider (Anthropic, OpenAI, Google, Mistral, or OpenRouter as an aggregator), generate an API key, and paste it into the product. Your usage is billed directly by the provider. The product company charges only for the platform or infrastructure. Hivra supports this model. You pay Hivra for managed hosting and the dashboard, from ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}. With your own key, every AI request your agent makes goes directly to the provider, and Hivra has nothing to do with that token billing. Hivra also sells managed Venice credits if you would rather not bring a key.`,
      ],
    },
    {
      heading: "What this costs in practice",
      paragraphs: [
        "Anthropic API pricing, read on 30 September 2026: Claude Haiku 4.5 costs $1 per million input tokens and $5 per million output tokens. The Batch API cuts this 50%, to $0.50/$2.50 per MTok, for workloads that can tolerate a few hours of async processing. For a moderately active agent running 10-30 scheduled tasks per day, total API spend typically lands at $3-12/month on Haiku.",
        "Claude Sonnet 5.5 ($2/$10 per MTok) covers most research and analysis tasks: it is the default choice for anything requiring sustained reasoning. With the 1 million token context window at standard pricing (no surcharge), long-context agent tasks cost the same per token as short ones. Agents doing heavy research or code generation at volume typically run $20-60/month at Sonnet-level, a range worked out at April 2026 prices and not recalculated. Opus 5.5 ($4/$20 per MTok) is the heavier tier, worth it for complex multi-step synthesis, not for monitoring or summarization tasks. Prices are on [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing).",
        "If you are on OpenAI, GPT-5 mini at $0.25/$2 per MTok is a low-cost capable option. The combined cost of Hivra hosting plus your API usage is almost always lower than what AI SaaS products charge for equivalent functionality, because those products layer their own margin on top of provider pricing.",
        "Because the key is yours, the bill responds to how you use it. Caching, batching, and cutting what you resend each turn all land directly on your invoice rather than someone else's margin: [AI agent API costs and how developers cut them](/blog/ai-agent-api-cost-optimization) covers the ones worth doing.",
      ],
    },
    {
      heading: "Which provider to use",
      paragraphs: [
        "Anthropic's Claude family (Haiku 4.5 for speed, Sonnet 5.5 for reasoning, Opus 5.5 for depth) is the best default for most agent tasks. Claude's instruction-following is reliable for multi-step agent workflows: the models are trained to follow structured procedures without going off-script.",
        "OpenAI's API offers GPT-5 and GPT-5 mini. GPT-5 mini at $0.25/$2 per MTok is a low-cost capable model, useful if you are running very high-frequency lightweight tasks where cost-per-request matters. Note: ChatGPT Plus and ChatGPT Pro subscriptions do not include API access. The API is a completely separate billing relationship with OpenAI at pay-per-token rates.",
        "OpenRouter gives you access to 300+ models from 60+ providers under a single API key and credit balance. No monthly minimums: you top up credits and pay only for what you use. Useful for evaluation (try 5 models against the same task), for accessing open-weight models hosted by third parties, or for building agents that route different task types to different models.",
      ],
    },
    {
      heading: "BYO login for Claude Code and Codex",
      paragraphs: [
        "BYO is not only about API keys. For coding agents, Hivra runs the official CLIs, and you sign in with the account you already have. [Claude Code](/agents/claude-code) uses your Anthropic or Claude subscription login. [Codex](/agents/codex) uses your ChatGPT login. You sign in on the agent's computer after launch, the same flow as on your laptop. The login is stored on the agent's VM. Hivra is independent and is not affiliated with Anthropic or OpenAI.",
        `The billing consequence is the same as BYO keys: zero markup on AI usage. If you already pay for Claude or ChatGPT, running these agents in the cloud adds no new AI cost while they stay inside the subscription's limits. For that usage, hosting is the only thing you pay Hivra for. Plans on [the pricing page](/pricing) start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}. To check whether your existing Claude subscription covers the usage you plan to run, use the [Claude Code plan calculator](/tools/claude-code-plan-calculator). [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code) covers which plan fits and when paying by API key is cheaper.`,
      ],
    },
    {
      heading: "Privacy implications",
      paragraphs: [
        "With a managed service that controls the AI keys, your conversations and task data route through that service's infrastructure. With BYO key, your requests go directly from the agent to the provider: the hosting service is not in the path of your AI traffic.",
        "This does not mean the data is private from the provider. Anthropic, OpenAI, and others have their own data handling policies, and API usage may be used for model improvement depending on your account settings. What it does mean: your prompts and responses do not pass through a Hivra proxy or a Hivra-owned key. They are not invisible to the host, though. Your agent's files and logins live on its VM, and Hivra administrators keep infrastructure access to the hosts Hivra manages. If that boundary matters for your data, [self-hosting](/blog/how-to-self-host-hermes-agent) is the stricter option.",
      ],
    },
  ],
  faqs: [
    {
      q: "What if I already have a Claude Pro subscription?",
      a: "Claude Pro is the consumer subscription: it does not come with API access. To use Claude via API, you need a separate Anthropic developer account with API credits. The two billing systems are separate.",
    },
    {
      q: "Is there a free tier on any AI provider API?",
      a: "Anthropic and Google both offer limited free tiers on their APIs. For any serious agent use, you will exhaust free credits quickly. Budget $5-20/month for API costs at moderate usage levels.",
    },
    {
      q: "Can I limit how much API spend the agent can make?",
      a: "Yes. All major providers let you set monthly spend caps on your API key. Set a cap that matches your expected usage to prevent runaway costs from a poorly configured agent task.",
    },
    {
      q: "Does BYO key affect which models the agent can use?",
      a: "Yes. You can only use models your provider gives you access to. Standard Anthropic API accounts have access to all Claude models. OpenRouter gives access to 300+ models from multiple providers under a single key.",
    },
  ],
  relatedArticles: [
    { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent in 2026" },
    {
      slug: "ai-agent-api-cost-optimization",
      title: "AI agent API costs in 2026: real numbers and how developers cut them",
    },
    { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
  ],
  relatedFeatures: [
    { slug: "no-docker-hosting", title: "No Docker required" },
  ],
};
