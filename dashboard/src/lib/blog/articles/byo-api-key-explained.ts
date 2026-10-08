import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";

export const article: BlogArticle = {
  slug: "byo-api-key-explained",
  title: "BYO API key: what it means and why it matters",
  metaTitle: "What a BYO API key means for cost and privacy",
  metaDescription:
    "With a BYO API key you use your own Anthropic, OpenAI or OpenRouter account, so the provider bills you directly and your tokens carry no markup.",
  publishedDate: "2026-03-21",
  lastModified: "2026-10-05",
  readingTimeMin: 6,
  author: "Hivra team",
  tagline: "Bring your own key and the provider bills you directly: no markup, and no Hivra proxy in between.",
  intro:
    "BYO means bring your own: you supply the AI provider credentials your agent uses. Requests go straight from the agent to the model provider, and the provider sends you the bill. Hivra isn't in that loop.",
  shortAnswer:
    "A BYO API key means you bring your own AI provider credentials. Your agent's requests go straight to the provider, which bills you for that usage, so there's no markup on tokens. You pay Hivra for managed hosting and the dashboard, and your prompts don't pass through a Hivra proxy.",
  sections: [
    {
      heading: "How is a BYO key different from a bundled AI subscription?",
      paragraphs: [
        "Who sends you the bill. Most AI SaaS products buy tokens in bulk, add a markup and fold the AI usage into your subscription. Handy. But you pay the markup, and you rarely see how much you're actually using.",
        `With your own key, you open a developer account straight with the provider (Anthropic, OpenAI, Google, Mistral, or OpenRouter if you want many models in one place), create a key and paste it in. The provider bills you for usage. The product only charges for the platform. That's how Hivra works: you pay Hivra for managed hosting and the dashboard, from ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}, and every AI request your agent makes goes straight to the provider. Hivra never touches that token bill. Would you rather not bring a key? Hivra also sells managed Venice credits.`,
      ],
    },
    {
      heading: "What does a BYO key cost in practice?",
      paragraphs: [
        "Less than most people expect. As of October 2026, Anthropic charges $1 per million input tokens and $5 per million output tokens for Claude Haiku 4.5. The Batch API halves that to $0.50 and $2.50 for work that can wait a few hours. An agent running 10 to 30 scheduled tasks a day on Haiku usually spends $3 to $12 a month.",
        "Claude Sonnet 5.5 ($2/$10 per million tokens, in and out) handles most research and analysis, and it's the default for anything that needs sustained reasoning. Its 1 million token context window has no long-context surcharge, so a long task costs the same per token as a short one. Heavy research or code generation at Sonnet level tends to run $20 to $60 a month (we worked that range out at April 2026 prices and haven't redone it). Opus 5.5 ($4/$20) is the heavy tier. Worth it for hard multi-step synthesis, wasted on monitoring or summaries. Current prices are on [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing).",
        "On OpenAI, GPT-5 mini at $0.25 in and $2 out is a cheap, capable option. Add Hivra hosting to your own API spend and the total almost always comes in under what AI SaaS products charge for the same work, because they stack their margin on top of the same provider prices.",
        "And since the key is yours, every saving lands on your invoice. Caching, batching and resending less each turn all cut your own bill, not somebody else's margin. [What an AI agent costs per month in API tokens](/blog/ai-agent-api-cost-optimization) has a monthly table and the cuts worth making.",
      ],
    },
    {
      heading: "Which AI provider should I get a key from?",
      paragraphs: [
        "For most agent work, start with Anthropic. Haiku 4.5 for speed, Sonnet 5.5 for reasoning, Opus 5.5 for depth. Claude models follow multi-step instructions reliably and stay on script, which is exactly what an agent needs.",
        "OpenAI's API gives you GPT-5 and GPT-5 mini. Mini, at $0.25 in and $2 out, makes sense when you run lots of small tasks and the cost per request adds up. One thing trips people up: ChatGPT Plus and Pro don't include API access. The API is a separate account with OpenAI, billed per token.",
        "OpenRouter puts 300+ models from 60+ providers behind one key and one balance. No monthly minimum. You top up and pay for what you use. It's great for testing five models on the same task, for open-weight models hosted by others, or for an agent that sends different jobs to different models.",
      ],
    },
    {
      heading: "Can I use my Claude or ChatGPT login instead of an API key?",
      paragraphs: [
        "Yes, for the coding agents. Hivra runs the official CLIs, and you sign in with the account you already have. [Claude Code](/agents/claude-code) takes your Anthropic or Claude subscription login. [Codex](/agents/codex) takes your ChatGPT login. You sign in on the agent's computer after launch, the same way you would on your laptop, and the login stays on the agent's VM. One catch if you were planning on an API key: OpenAI's authentication page says Codex cloud only takes a ChatGPT sign-in, not a key. The CLI on a Hivra computer takes either. The [Codex cloud guide](/blog/run-codex-24-7-in-the-cloud) has the full comparison. Hivra is independent and is not affiliated with Anthropic or OpenAI.",
        `The money works the same way as a BYO key: no markup on AI usage. If you already pay for Claude or ChatGPT, running these agents in the cloud adds no new AI cost while they stay inside the subscription's limits. Hosting is the only thing you pay Hivra for. Plans on [the pricing page](/pricing) start at ${ENTRY_PLAN_PRICE}/month for ${ENTRY_PLAN_SIZE}. Not sure your Claude plan covers what you want to run? Try the [Claude Code plan calculator](/tools/claude-code-plan-calculator). [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code) covers which plan fits and when an API key is cheaper.`,
      ],
    },
    {
      heading: "Is a BYO key more private?",
      paragraphs: [
        "Yes, in one specific way. When a service holds the AI keys, your conversations and task data run through its servers. With your own key, requests go straight from the agent to the provider, and the host isn't in the path of your AI traffic.",
        "That doesn't make your data private from the provider. Anthropic, OpenAI and the rest have their own data policies, and depending on your account settings API usage can be used to improve models. What it does mean is that your prompts and replies don't pass through a Hivra proxy or a Hivra-owned key. They aren't invisible to the host, though. Your agent's files and logins live on its VM, and Hivra administrators keep infrastructure access to the hosts Hivra manages. If that line matters for your data, [self-hosting](/blog/how-to-self-host-hermes-agent) is the stricter option.",
      ],
    },
  ],
  faqs: [
    {
      q: "What if I already have a Claude Pro subscription?",
      a: "Claude Pro is the consumer plan and doesn't come with API access. To call Claude through the API you need a separate Anthropic developer account with API credits. The two are billed separately. For Claude Code on a Hivra computer, though, you can sign in with your Pro login.",
    },
    {
      q: "Is there a free tier on any AI provider API?",
      a: "Anthropic and Google both have small free tiers. A real agent burns through them fast. Budget $5 to $20 a month for API costs at moderate use.",
    },
    {
      q: "Can I limit how much API spend the agent can make?",
      a: "Yes. Every major provider lets you set a monthly spend cap on your key. Set one that matches what you expect to use, so a badly set-up task can't run up a surprise bill.",
    },
    {
      q: "Does BYO key affect which models the agent can use?",
      a: "Yes. You can only use the models your provider account has access to. A standard Anthropic API account gets every Claude model. OpenRouter gets you 300+ models from many providers on one key.",
    },
  ],
  relatedArticles: [
    { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent in 2026" },
    {
      slug: "ai-agent-api-cost-optimization",
      title: "What an AI agent costs per month in API tokens (2026)",
    },
    { slug: "self-hosting-hermes-guide", title: "How to self-host Hermes Agent" },
  ],
  relatedFeatures: [
    { slug: "no-docker-hosting", title: "No Docker required" },
  ],
};
