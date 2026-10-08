import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, LARGER_PLAN_PRICE, LARGER_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "../plan-facts";

// Written 2026-10-05 for "codex pricing" (8,100 US searches a month, KD 9, Aug 2026 data), with "codex cost",
// "codex usage limits" and "codex plus vs pro" folded into the sections below.
//
// Vendor facts were read on 5 October 2026 from OpenAI's own pages. Reader copy carries one plain freshness stamp
// ("as of October 2026") on the prices, never "read on DATE" (Ash's voice rule, 2026-10-06):
// - https://learn.chatgpt.com/docs/pricing (plan cards, shared Work/Codex usage, Plus local-message estimates, API key row)
// - https://learn.chatgpt.com/codex/agent-configuration/speed (Fast and Ultrafast billing multipliers and Pro $500 Ultrafast)
// - https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers (Pro 100 / 200 / 500 prices, Ultrafast on Pro 500
//   only, Pro 200 grandfathering window through 29 October 2026)
// - https://learn.chatgpt.com/docs/whats-new/devday-2026 (DevDay 29 September 2026: Astra Ultrafast on Pro $500,
//   reusable cloud environments)
//
// Left out on purpose: any "Nx Plus" usage multiple for Pro tiers (OpenAI's Pro tiers help article does not publish
// them; secondary posts do), dollar credit values for grandfathered Pro 200 (press reports only), and anything
// implying Hivra sells, discounts or raises Codex limits. Hivra plans are named by price and size only, because
// checkout's plan names collide with OpenAI's Pro tiers.

const AS_OF = "October 2026";
const PRICING = "https://learn.chatgpt.com/docs/pricing";
const PRO_TIERS = "https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers";
const SPEED = "https://learn.chatgpt.com/codex/agent-configuration/speed";
const DEVDAY = "https://learn.chatgpt.com/docs/whats-new/devday-2026";

export const article: BlogArticle = {
  slug: "codex-pricing-by-chatgpt-plan",
  title: "Codex pricing by ChatGPT plan: Plus, Pro 100/200/500 and API keys",
  metaTitle: "Codex pricing by ChatGPT plan (October 2026)",
  metaDescription:
    "Codex pricing by ChatGPT plan: Plus $20, Pro 100/200/500, API keys. October 2026 changes, and why your own computer does not raise Codex limits.",
  publishedDate: "2026-10-05",
  lastModified: "2026-10-05",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "Your ChatGPT plan sets Codex limits. Where Codex runs doesn't change them.",
  intro: `OpenAI folds Codex into ChatGPT plans, and the plan cards keep moving. So we went back through the pricing page, the Pro tiers help article and the speed docs and put it all in one table. One rule never moves: a computer of your own does not raise your Codex allowance.`,
  shortAnswer: `Codex ships inside ChatGPT Free, Go, Plus ($20), Pro ($100, $200 or $500) and Business, Edu or Enterprise, as of ${AS_OF}. Plus and up get web, CLI, IDE and iOS. Pro 500 alone adds Astra Ultrafast among Pro tiers. An API key pays per token, no cloud features. Your own computer does not change Codex limits.`,
  sections: [
    {
      heading: `What does Codex cost on each ChatGPT plan?`,
      paragraphs: [
        `OpenAI's [pricing page](${PRICING}) says ChatGPT Work and Codex are included in Free, Go, Plus, Pro, Business, Edu or Enterprise, and that Work and Codex share the same pricing, credits and usage limits. Prices as of ${AS_OF}, from that page and OpenAI's [Pro tiers help article](${PRO_TIERS}):`,
        [
          "| Plan | Price a month (USD) | What OpenAI lists for Codex |",
          "|---|---|---|",
          "| Free | $0 | Explore Codex on quick coding tasks; GPT-6 Luna at Standard speed in the desktop app, subject to rollout |",
          "| Go | $8 | Lightweight coding tasks; GPT-6 Luna at Standard speed in the desktop app, subject to rollout |",
          "| Plus | $20 | Codex on the web, CLI, IDE extension and iOS; cloud integrations (automatic code review, Slack); GPT-6.1 Sol and GPT-6 Luna; optional ChatGPT credits |",
          "| Pro 100 | $100 | Everything in Plus, plus higher included usage than Plus; Ultrafast not included |",
          "| Pro 200 | $200 | More included usage than Pro 100; Ultrafast not included |",
          "| Pro 500 | $500 | Highest included Pro usage; Astra Ultrafast included |",
          "| API key | Pay per token | Codex in the CLI, SDK or IDE extension; no cloud-based features; billed at API pricing |",
        ].join("\n"),
        `Business, Edu and Enterprise sit on the same pricing page with workspace controls, larger cloud VMs and credit billing. Their seat prices are contract-specific, so we don't invent them. OpenAI's feature table also lists Codex cloud for Plus, Pro, Business and Enterprise or Edu. An API key row on that table has no Codex cloud.`,
        `Prices exclude tax. OpenAI changes these plans often, so check the linked pages before you buy.`,
      ],
    },
    {
      heading: "What changed for Codex pricing this autumn?",
      paragraphs: [
        `Three things, all from OpenAI's own pages.`,
        [
          `First, Pro 500 and Astra Ultrafast. OpenAI's [DevDay 2026 notes](${DEVDAY}) (29 September 2026) and [speed docs](${SPEED}) say GPT-6 Astra Ultrafast is available in Codex and ChatGPT Work on the Pro $500 plan and on eligible Enterprise and Edu plans. The [Pro tiers article](${PRO_TIERS}) says Ultrafast is available only on Pro 500 among Pro plans, and that buying credits on Pro 100 or Pro 200 does not add Ultrafast at launch.`,
          `Second, the Pro 200 allowance got smaller for most people. New Pro 200 subscriptions are open again at $200 a month, with a lower included usage allowance than before. Eligible existing Pro 200 subscribers keep the previous allowance through 29 October 2026 while the subscription stays active, then move to the lower allowance at the same $200 price. Eligibility needs an active Pro 200 subscription at any point from 22 September 2026 through 10 a.m. Pacific Time on 29 September 2026 ([Pro tiers article](${PRO_TIERS})). Keeping that allowance does not add Ultrafast or turn the plan into Pro 500.`,
          `Third, GPT-5.5 retires on 14 October 2026. OpenAI's pricing and speed pages say GPT-5.5 leaves ChatGPT, ChatGPT Work and Codex on all plans that day. The OpenAI API is not affected.`,
        ].join("\n\n"),
        "OpenAI's Pro tiers help article does not publish numeric \"Nx Plus\" multiples for Pro 100, Pro 200 or Pro 500. It only says Pro 200 includes more usage than Pro 100, and Pro 500 offers the highest included usage of the three. So this page doesn't invent multiples either. Check your own usage dashboard.",
      ],
    },
    {
      heading: "How do Codex usage limits work on a ChatGPT plan?",
      paragraphs: [
        `Local messages and cloud chats share one allowance ([pricing page](${PRICING})). Cloud tasks can use more of it than local messages. Weekly limits can also apply. Pro plans currently have no five-hour limit on the estimates table; Plus and Standard Business do.`,
        `OpenAI publishes local-message estimates per five-hour period for Plus and Standard Business. They are ranges, not fixed caps, and they depend on the model and the task:`,
        [
          "| Model | Plus / Standard Business (local messages per 5 hours) |",
          "|---|---|",
          "| GPT-6 Astra | 5 to 45 |",
          "| GPT-6.1 Sol | 15 to 160 |",
          "| GPT-6 Sol | 15 to 150 |",
          "| GPT-6 Luna | 350 to 3,000 |",
        ].join("\n"),
        `Speed modes burn the same pool faster. OpenAI's [speed docs](${SPEED}) and pricing page say Fast mode uses included subscription limits at 2.5x the Standard rate for the same model, and GPT-6 Astra Ultrafast uses them at 8x. Those are billing multipliers, not a promise of how much faster the work finishes.`,
        `When you hit a limit mid-turn, OpenAI says the agent can finish that turn subject to fair use. Plus and Pro users can buy credits to keep going. Business, Edu and Enterprise workspaces on flexible pricing can buy workspace credits. Everyone can keep running local chats on an API key at API rates once the plan allowance is gone.`,
        "Check the usage dashboard. Or type `/status` inside a Codex CLI session.",
      ],
    },
    {
      heading: "API key or ChatGPT subscription for Codex?",
      paragraphs: [
        "They're two separate bills, and you can use both.",
        "A ChatGPT subscription puts Codex inside a monthly plan with an included allowance, shared with ChatGPT Work. Plus and up get cloud features such as Codex cloud, GitHub code review and Slack. Free and Go cards on the pricing page only mention Codex in the desktop app for quick or lightweight tasks.",
        "An API key pays per token at OpenAI API prices. It works in the CLI, SDK and IDE extension. It does not get cloud-based features. Model availability follows whatever the key can call.",
        "Pick the subscription when you want a hard monthly ceiling and cloud features. Pick the API key when you want automation in CI, or when a burst of local work is cheaper to meter than to upgrade the plan. Mixing them is fine: OpenAI lets you finish work on an API key after a plan limit.",
        `For monthly API arithmetic on agent workloads that aren't Codex-only, see [AI agent API cost optimization](/blog/ai-agent-api-cost-optimization).`,
      ],
    },
    {
      heading: "Does a computer of your own change Codex pricing or limits?",
      paragraphs: [
        "No. Usage follows your ChatGPT plan (or your API key) wherever the CLI runs: laptop, VPS, OpenAI's Codex cloud or a Hivra computer. OpenAI's pricing page says local messages and cloud chats share one allowance. Hosting does not add a second pool.",
        `That is the line people miss when they compare hosts. Hivra's ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}, is the computer bill. Codex still bills through your own OpenAI account. Hivra adds no markup on that usage when you sign in with your own ChatGPT login or your own API key.`,
        "If OpenAI's Codex cloud covers the job (one self-contained change to a GitHub repo, on a plan that lists it), use that. There's no second host bill. The [Codex cloud vs own computer guide](/blog/run-codex-24-7-in-the-cloud) spells out when a shell that stays up wins instead.",
      ],
    },
    {
      heading: "Which ChatGPT plan should I get for Codex?",
      paragraphs: [
        "OpenAI doesn't publish a fixed message count per plan, so this is our practical reading of what it does publish. It isn't an OpenAI rule.",
        [
          "| Plan | Good for | Watch out for |",
          "|---|---|---|",
          "| Free or Go | Trying Codex on small tasks in the desktop app | Not built for long agent runs |",
          "| Plus ($20) | A few focused coding sessions a week, Codex on web, CLI, IDE and iOS, and Codex cloud when the job fits | The five-hour estimates and weekly limits |",
          "| Pro 100 ($100) | When Plus stops you most weeks and you don't need Astra Ultrafast | Still no Ultrafast |",
          "| Pro 200 ($200) | More room than Pro 100 | No Ultrafast, and the old higher allowance only lasts through 29 October 2026 for eligible subscribers |",
          "| Pro 500 ($500) | When Ultrafast matters, or Pro 200 still has you buying credits every week | The only Pro tier with Astra Ultrafast, and the priciest |",
          "| API key | CI, scripted `codex exec`, or bursty local work you'd rather meter | No Codex cloud |",
        ].join("\n"),
        "Still choosing between Claude Code and Codex for always-on work? [Claude Code vs Codex for 24/7](/blog/claude-code-vs-codex-24-7) compares them. Claude's own plan math lives on [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code).",
      ],
    },
    {
      heading: "How do I run Codex on a Hivra computer?",
      paragraphs: [
        `If you want a computer that stays on, with files outside GitHub and a shell you can rejoin, launch Codex from [the Codex agent page](/agents/codex), sign in with your own ChatGPT account, and start the CLI inside tmux in the Terminal tab. Plans are ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}, with a ${MONEY_BACK_GUARANTEE}. Paid plans aren't paused for inactivity.`,
        "Your Codex limits still come from OpenAI. Hivra doesn't sell Codex access and doesn't raise the allowance.",
        "Hivra isn't always the better pick. OpenAI's Codex cloud has no separate host bill for tidy GitHub tasks. A keep-awake laptop is enough for short sessions at your desk. A VPS can be cheaper hardware for the money if you want to run the server yourself.",
        "Hivra is independent and is not affiliated with OpenAI.",
      ],
    },
  ],
  faqs: [
    {
      q: "How much does Codex cost?",
      a: `Codex is included in ChatGPT Free, Go ($8), Plus ($20), Pro ($100, $200 or $500) and Business, Edu or Enterprise, as of ${AS_OF} on OpenAI's pricing page. An API key pays per token instead. There is no separate Codex-only subscription on that page.`,
    },
    {
      q: "Is Codex included in ChatGPT Plus?",
      a: `Yes. OpenAI's pricing page lists Codex on the web, CLI, IDE extension and iOS for Plus at $20 a month, plus cloud integrations and optional credits.`,
    },
    {
      q: "What is ChatGPT Pro 500 for Codex?",
      a: `Pro 500 is OpenAI's $500 a month Pro tier. Among Pro plans it alone includes Astra Ultrafast, and OpenAI says it offers the highest included usage of Pro 100, Pro 200 and Pro 500.`,
    },
    {
      q: "What happens to ChatGPT Pro 200 on 29 October 2026?",
      a: "Eligible Pro 200 subscribers keep their previous included allowance through 29 October 2026 while the subscription stays active, then move to the lower allowance at the same $200 price. Eligibility needs an active Pro 200 subscription at any point from 22 September 2026 through 10 a.m. Pacific Time on 29 September 2026. Keeping the allowance does not add Ultrafast.",
    },
    {
      q: "Does Codex cloud cost extra on top of ChatGPT?",
      a: `No separate Codex cloud fee on OpenAI's pricing page. Codex cloud draws from the same shared ChatGPT Work and Codex allowance. OpenAI lists it for Plus, Pro, Business and Enterprise or Edu. An API key does not get cloud-based features.`,
    },
    {
      q: "Can I use Codex with an API key instead of ChatGPT?",
      a: "Yes for the CLI, SDK and IDE extension. OpenAI's pricing page says API key access has no cloud-based features, and usage is billed at API pricing. Codex cloud needs a ChatGPT sign-in.",
    },
    {
      q: "Do Codex limits reset if I run Codex on a different computer?",
      a: "No. Limits follow your ChatGPT plan or API key, not the host. A laptop, a VPS, Codex cloud and a Hivra computer all draw from the same OpenAI allowance for that account.",
    },
    {
      q: "When does GPT-5.5 leave Codex?",
      a: "14 October 2026, from ChatGPT, ChatGPT Work and Codex on all plans, according to OpenAI's pricing and speed pages. The OpenAI API is not affected.",
    },
    {
      q: "How much does Hivra cost on top of Codex?",
      a: `Hivra is ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}, on top of your own ChatGPT plan or OpenAI API usage. Codex itself still bills through OpenAI. Paid plans come with a ${MONEY_BACK_GUARANTEE}. Hivra is independent and is not affiliated with OpenAI.`,
    },
  ],
  relatedArticles: [
    { slug: "run-codex-24-7-in-the-cloud", title: "How to run Codex 24/7 in the cloud (Codex CLI hosting explained)" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
    { slug: "claude-max-vs-pro-for-claude-code", title: "Claude Code pricing: Pro vs Max, and when API billing is cheaper" },
    { slug: "ai-agent-api-cost-optimization", title: "What an AI agent costs per month in API tokens (2026)" },
    { slug: "cost-of-running-ai-agent", title: "How much does it cost to run an AI agent?" },
  ],
};
