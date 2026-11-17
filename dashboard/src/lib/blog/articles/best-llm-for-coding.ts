import { BlogArticle } from "../types";

// Written 2026-11-17 for "best llm for coding" (US ~1,600/month, very low difficulty).
// All facts fetched 2026-11-17 (fetched 2026-11-17). Sources:
// Anthropic models and pricing: https://platform.claude.com/docs/en/models/overview
// Anthropic Opus 5.5 announcement (22 Sep 2026): https://www.anthropic.com/news/claude-opus-5-5
// Anthropic Sonnet 5.5 announcement (28 Sep 2026): https://www.anthropic.com/news/claude-sonnet-5-5
// Claude Code model config: https://code.claude.com/docs/en/model-config
// OpenAI models and pricing: https://developers.openai.com/api/docs/models
// Codex models and retirements: https://learn.chatgpt.com/docs/models
// GPT-6.1 Sol launch coverage (OpenAI page itself did not fetch): https://thenextweb.com/news/openai-gpt-6-1-sol-price-astra-devday
// Google models: https://ai.google.dev/gemini-api/docs/models
// Gemini 4 Carbon announcement (10 Nov 2026): https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-carbon-now-available/
// Terminal-Bench leaderboard (version 4.1): https://www.tbench.ai/leaderboard
// SWE-bench site: https://www.swebench.com/
// Aider polyglot leaderboard: https://aider.chat/docs/leaderboards/
// LiveCodeBench: https://livecodebench.github.io/leaderboard.html (data did not load on fetch)
// DeepSeek API pricing: https://api-docs.deepseek.com/quick_start/pricing
// DeepSeek V4.1 Flash model card: https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017
// Kimi K3.1 Pro announcement: https://kimi.com/blog/kimi-k3-1-pro
// Kimi K3.1 Pro model card: https://huggingface.co/moonshotai/Kimi-K3.1-Pro
// Kimi API pricing page (price table did not render): https://platform.kimi.ai/docs/pricing/chat
// Qwen3.8-27B model card: https://huggingface.co/Qwen/Qwen3.8-27B
// Qwen org on Hugging Face: https://huggingface.co/Qwen
// Mistral models overview: https://docs.mistral.ai/getting-started/models/models_overview/
// Cursor models and pricing: https://cursor.com/docs/models
//
// Left out because not verified: Kimi K3.1 Pro API price, Qwen API prices, Mistral per-token prices,
// Gemini 4 Carbon/Argon benchmark scores from Google (blog gives none), any SWE-bench Verified score
// for 2026 models (the 2026 vendor posts we read do not report it), current LiveCodeBench leaderboard.

export const article: BlogArticle = {
  slug: "best-llm-for-coding",
  title: "Best LLM for coding in November 2026: which model for which job",
  metaTitle: "Best LLM for coding (Nov 2026): picks by job",
  metaDescription:
    "The best LLM for coding as of November 2026, by job: agentic work, cheap bulk, local. Real prices, Terminal-Bench scores and honest caveats.",
  publishedDate: "2026-11-17",
  lastModified: "2026-11-17",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "There is no single winner. There is a best model for each kind of coding work, and the gaps are smaller than the charts suggest.",
  intro:
    "Model rankings change every few weeks, and most pages that answer this question are stale. This one was checked against vendor pricing pages, vendor announcements and the Terminal-Bench leaderboard in November 2026. Every number is dated and sourced, and we left out anything we could not verify.",
  shortAnswer:
    "As of November 2026, Claude Opus 5.5 is the best all-round pick for agentic coding, tied for first on the Terminal-Bench leaderboard. Claude Sonnet 5.5 and GPT-6.1 Sol cost half as much per token. DeepSeek V4.1 Flash covers cheap bulk work, and Gemini 4 Argon is a mid-priced option while its introductory price lasts. Qwen3.8-27B is the realistic local model.",
  sections: [
    {
      heading: "The short version, as of November 2026",
      paragraphs: [
        "If you want one model for hard, multi-file work in an agent like Claude Code or Codex, start with Claude Opus 5.5. If you want most of that for half the price, use Claude Sonnet 5.5 or OpenAI's GPT-6.1 Sol. If you are running thousands of small jobs, DeepSeek V4.1 Flash costs a fraction of any of them. If the code cannot leave your machine, Qwen3.8-27B is the open-weight model that fits on one computer.",
        "That is the whole answer. The rest of this guide shows the numbers behind it, where the benchmarks mislead, and how to pick for your own repo. All prices are US dollars per million tokens, input then output, from each vendor's own pages in November 2026. Prices and rankings move. Check the vendor page before you commit a budget.",
      ],
    },
    {
      heading: "Which models are current right now",
      paragraphs: [
        "The model names changed a lot this year, so here is what each vendor lists as current today.",
        [
          "| Vendor | Current models (API IDs where listed) | Price in / out per 1M tokens | Context |",
          "|---|---|---|---|",
          "| Anthropic | Claude Fable 5.2 (`claude-fable-5-2`) | $8 / $40 | 1M |",
          "| Anthropic | Claude Opus 5.5 (`claude-opus-5-5`) | $4 / $20 | 1M |",
          "| Anthropic | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2 / $10 | 1M |",
          "| Anthropic | Claude Haiku 5.5 (`claude-haiku-5-5`) | from $0.10 / $0.50 | 1M |",
          "| OpenAI | GPT-6 Astra (`gpt-6-astra`) | $10 / $50 | 1.05M |",
          "| OpenAI | GPT-6.1 Sol (`gpt-6.1-sol`) | $2 / $10 | 1.05M |",
          "| OpenAI | GPT-6.1 Terra (`gpt-6.1-terra`) | $1 / $5 | 1.05M |",
          "| OpenAI | GPT-6 Luna (`gpt-6-luna`) | $0.10 / $0.50 | 1.05M |",
          "| Google | Gemini 4 Argon (`gemini-4-argon`) | $2 / $10 introductory, $4 / $20 after | 1M |",
          "| Google | Gemini 4 Carbon | $2 / $10 until 30 Nov 2026, then $4 / $20 | not stated |",
          "| DeepSeek | V4.1 Flash (`deepseek-flash`) | $0.15 miss, $0.60 out off-peak; double at peak | 1M |",
          "| DeepSeek | V4 Pro (`deepseek-v4-pro`) | $0.66 miss, $1.98 out off-peak; double at peak | 1M |",
        ].join("\n"),
        "Anthropic's page also lists older models. Opus 5, Opus 4.8 and Sonnet 5 are still listed, but its own docs tell you to start from Opus 5.5. Fable 5.2 is the priciest tier and Anthropic points to it for the hardest, longest-running work. OpenAI's models page says Astra is for the most demanding work, Sol is close to Astra at a lower cost, Terra is fast and suited to visual work and computer use, and Luna is for high-volume jobs.",
        "Two notes on the table. DeepSeek charges half price off-peak. Peak is 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday to Friday, so scheduled batch jobs can run cheap. And the Gemini 4 Carbon price doubles on 1 December. Google also lists an introductory $2 / $10 for Argon that rises to $4 / $20 afterwards, so treat both introductory numbers as temporary. Google's own words are that Argon stays the better choice for most software engineering, and Carbon is for harder tasks that need more reasoning tokens.",
      ],
    },
    {
      heading: "What the benchmarks say, and which ones still matter",
      paragraphs: [
        "The benchmark landscape shifted. The old headline numbers are stale or saturated, and the field moved to harder, agent-based tests. Here is what we could actually verify.",
        "**Terminal-Bench** is the one to watch. It tests an agent finishing real tasks in a terminal, and each row is an agent and model pair. On its leaderboard (version 4.1, as of November 2026), the top of the table looks like this:",
        [
          "| Rank | Agent | Model (effort) | Score | Date |",
          "|---|---|---|---|---|",
          "| 1 (tie) | Claude Code | Opus 5.5 (max) | 65.8% ± 3.1% | 22 Sep 2026 |",
          "| 1 (tie) | Claude Code | Fable 5.2 (max) | 65.8% ± 2.8% | 9 Nov 2026 |",
          "| 3 | Antigravity CLI | Gemini 4 Carbon (high) | 64.5% ± 3.2% | 28 Oct 2026 |",
          "| 4 | Claude Code | Sonnet 5.5 (max) | 63.9% ± 3.0% | 28 Sep 2026 |",
          "| 5 | Codex | GPT-6.1 Sol (max) | 60.9% ± 3.0% | 29 Sep 2026 |",
          "| 6 | Codex | GPT-6 Astra (max) | 60.3% ± 2.8% | 3 Sep 2026 |",
          "| 7 | Claude Code | Kimi K3.1 Pro (max) | 59.7% ± 4.2% | 24 Oct 2026 |",
        ].join("\n"),
        "Read the plus-or-minus column. Ranks 1 through 4 sit within each other's error bars, so a one-point gap is noise. The honest reading is that Opus 5.5, Fable 5.2, Gemini 4 Carbon and Sonnet 5.5 are a tier. GPT-6.1 Sol and Astra sit a few points behind on this board. Fable 5.2 costs twice as much as Opus 5.5 and does not beat it here, which is worth knowing before you pay for the top tier.",
        "Vendors also publish their own numbers, on a different version of the test. Anthropic's Opus 5.5 post reports 66.4% on Terminal-Bench 4.0, and its Sonnet 5.5 post reports 70.6% for Sonnet 5.5 on the same test. Moonshot reports 65.7% for Kimi K3.1 Pro on 4.0. Those are vendor-run, with the vendor's chosen settings, and Sonnet 5.5 ahead of Opus 5.5 does not match the independent board. Do not mix 4.0 and 4.1 numbers in one ranking.",
        "**SWE-bench Verified** is the benchmark most older articles quote. The swebench.com site still lists it, plus Bash Only, Lite, Multilingual and Multimodal, but its page showed no scores when we read it. The 2026 Anthropic announcements we read do not report it either. We could not verify a current Verified score for any model above, so we are not printing one. Treat any 2026 article that quotes a confident Verified ranking as a copy of an older number.",
        "**Aider polyglot** is dead for ranking new models. Its leaderboard was last updated on 20 November 2025, and its top entry is gpt-5 (high) at 88.0%. No model released this year is on it. **LiveCodeBench** is a contamination-resistant test of competitive-style problems. Its leaderboard data did not load when we fetched it, so we have no current ranking to show. Qwen reports 90.3 on LiveCodeBench v6 for its open 27B model, which is vendor-reported and shows how saturated that test is for single-function problems.",
      ],
    },
    {
      heading: "Why a benchmark score will not predict your results",
      paragraphs: [
        "Benchmarks measure a model inside a specific harness, at a specific effort setting, on tasks that are not your code. Three things move the number more than people expect.",
        "First, the agent matters as much as the model. The Terminal-Bench board lists the same model under different agents and the scores differ. Second, effort settings matter. Anthropic's own Sonnet 5.5 post says the model scored lower at max effort than at xhigh on one benchmark, because of timeouts and out-of-scope edits. More thinking is not always better. Third, cost per task matters. A model that scores two points lower and uses far fewer tokens can be the better buy. Anthropic says Sonnet 5.5 typically uses fewer tokens per task than Sonnet 5, with up to 30% lower cost per task in its own testing.",
        "The practical rule is to treat the leaderboard as a way to build a shortlist of two or three models, then run each on five real tasks from your own repo. Pick the one that needs the least correcting, not the one with the best chart. Test on the kind of work you do: a legacy codebase with odd conventions behaves nothing like a clean greenfield benchmark task.",
      ],
    },
    {
      heading: "Best for agentic, multi-file work",
      paragraphs: [
        "This is the job where model choice matters most: the agent reads a repo, plans, edits many files, runs tests and fixes its own mistakes over a long session. The Terminal-Bench numbers above are the closest public proxy.",
        "**Claude Opus 5.5** is our pick. It is tied first on the independent board, it is the default model in Claude Code on Pro, Max, Team, Enterprise and API accounts, and at $4 / $20 it costs half what Fable 5.2 does. Anthropic says it costs about 40% less to run than Opus 5 on typical workloads. **Claude Fable 5.2** is for when Opus 5.5 at high effort still falls short on your own tests. Anthropic's docs say Fable is never the default and you have to select it on purpose.",
        "**Claude Sonnet 5.5** is the value pick. It is 4th on the board, within the error bars of the leaders, at half Opus 5.5's price. Anthropic's Claude Code docs call the sonnet alias the model for daily coding, and the `opusplan` alias uses Opus to plan and Sonnet to execute, which is a sensible split.",
        "**GPT-6.1 Sol** is the OpenAI equivalent: $2 / $10, available in Codex, 5th on the board at 60.9%. OpenAI says it gets near Astra's performance at a lower cost, and its listed price is a fifth of Astra's. **GPT-6 Astra** at $10 / $50 scored 60.3% on the same board, so on this evidence it is hard to justify the premium for coding. **Gemini 4 Carbon** is the surprise: 3rd on the board at 64.5% through Google's Antigravity CLI. Google offers it to paying API developers and Google AI Ultra subscribers, and its price doubles on 1 December, so check what you can actually get before planning around it.",
      ],
    },
    {
      heading: "Best for autocomplete and quick edits",
      paragraphs: [
        "Autocomplete and small inline edits need low latency and low cost per call. Frontier-model reasoning is wasted here. Use the small tier of whichever family you already pay for: Claude Haiku 5.5 (from $0.10 / $0.50), GPT-6 Luna ($0.10 / $0.50) or GPT-6.1 Terra ($1 / $5).",
        "We have no independent benchmark that ranks these small models for completion, so we are not claiming one is best. Choose by speed in your editor and by whether your tool lets you select them. Cursor, for example, also offers its own Composer 2.5 at $0.50 / $2.50 per million tokens according to its docs, and its own models sit in a weekly usage pool. If you want the tool-by-tool picture, read [Cursor vs Claude Code](/blog/cursor-vs-claude-code).",
      ],
    },
    {
      heading: "Best for cheap bulk work",
      paragraphs: [
        "Bulk work means big volumes of reasonably simple jobs: generating tests, migrating a lot of files, writing docstrings, triaging issues, summarizing diffs. Here the price per task decides.",
        "**DeepSeek V4.1 Flash** is the standout. At $0.15 per million input tokens on a cache miss and $0.60 per million output off-peak, it costs a small fraction of a frontier model. Cache hits are $0.003 per million. Its model card reports 42.3 on Terminal-Bench 4.0 when run with the Claude Code harness, and 77.0 on DeepSWE v1.1 in a different harness. The first number is well behind the leaders, so expect more failures and retries on hard agentic tasks. For well-defined, checkable jobs, it is excellent value.",
        "**DeepSeek V4 Pro** costs about four times as much and is the step up when Flash struggles. **Gemini 4 Argon** at $2 / $10 (introductory, $4 / $20 afterwards) and **Sonnet 5.5** at $2 / $10 are the mid-priced options that still handle real agentic work. Batch discounts help too: Google lists its Batch API at a 50% cost reduction.",
        "A good pattern is to run a cheap model first and escalate. Let Flash attempt the job, run your tests, and send only failures to Opus 5.5 or Sonnet 5.5. That keeps the bill small without capping quality.",
      ],
    },
    {
      heading: "Best open-weight and local models",
      paragraphs: [
        "Open weights mean you can download the model and run it yourself. That matters for privacy, cost at scale and control. It does not mean it fits on your laptop. Most of the strongest open models are enormous.",
        [
          "| Model | Size | License | Context | Vendor-reported coding numbers |",
          "|---|---|---|---|---|",
          "| Kimi K3.1 Pro | 2.8T total, 104B active | Custom Kimi K3.1 Pro License | 1M | Terminal-Bench 4.0: 65.7 (Moonshot) |",
          "| DeepSeek V4.1 Flash (1017) | 763B | MIT | 1M | Terminal-Bench 4.0: 42.3, DeepSWE v1.1: 77.0 |",
          "| Qwen3.8-27B | 27B (listed as 28B on Hugging Face) | Apache-2.0 | 262,144 native, 1M with YaRN | SWE-bench Pro: 61.7, LiveCodeBench v6: 90.3 |",
        ].join("\n"),
        "**Kimi K3.1 Pro** is the most capable open model. Moonshot reports 65.7% on Terminal-Bench 4.0, close to Opus 5.5's vendor-reported 66.4%, and on the independent board it runs 7th at 59.7%. The weights are on Hugging Face under a custom license, so read the terms before you build a product on it. At 2.8T parameters it needs a GPU cluster, not a workstation. Its headline scores come from Moonshot, which is another reason to run your own tasks. We could not verify its API price, so it is not in the price table.",
        "**DeepSeek V4.1 Flash** has MIT-licensed weights, the most permissive of the three, but 763B parameters is also server territory. Its per-token API price is low enough that self-hosting rarely saves money unless you have privacy or volume reasons.",
        "**Qwen3.8-27B** is the realistic local pick. It is Apache-2.0, about 28B parameters, and small enough for a single high-memory GPU or a well-equipped workstation once quantized. Qwen's model card reports 61.7 on SWE-bench Pro, 42.2 on DeepSWE 1.1 and 90.3 on LiveCodeBench v6. It also reports 73.0 on Terminal-Bench 2.1 with the Terminus harness, but that is an older test version and not comparable to the 4.x scores above. Qwen does not state hardware requirements, so check memory needs for the quantization you pick. Qwen also lists a 2.4T-parameter Qwen3.8 model, which is not a local option.",
        "A note on Mistral. Its docs list Mistral Large 4 as an open-weight model under the Mistral Ecosystem Open Weight License, but we found no coding benchmarks or per-token prices for it. The same page marks Devstral 2 as deprecated, so we would not start a new coding setup on it.",
        "Be realistic about what local means. A 27B model is a strong helper for edits, tests and explaining code. It is not equal to Opus 5.5 on long, multi-file agent runs, and vendor-reported numbers from a model card are not independent. If you need frontier-level agent work, use a hosted model. If you need privacy, accept the capability gap.",
      ],
    },
    {
      heading: "Which coding tool uses which model",
      paragraphs: [
        "The model and the tool are separate choices, but each tool has a home team.",
        [
          "| Tool | Models it uses | Notes |",
          "|---|---|---|",
          "| Claude Code | Claude models. Default is Opus 5.5 on Pro, Max, Team, Enterprise and API accounts | Aliases: `opus`, `sonnet`, `haiku`, `fable`, `opusplan`. Fable is never the default. Effort levels low to max |",
          "| Codex | GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Luna | Works with a ChatGPT sign-in or an API key. Sol's default context in Codex is 500,000 tokens |",
          "| Antigravity CLI | Gemini 4 models (on the Terminal-Bench board) | Google's agent. Carbon is offered to paying API developers and Google AI Ultra subscribers |",
          "| Cursor | Claude, GPT and Gemini models at API list price from prepaid credit, plus Cursor's own Composer 2.5 and Grok models | Which plans include third-party models varies. Check Cursor's docs |",
        ].join("\n"),
        "Claude Code's docs cover Claude models, and let you route them through Bedrock, Foundry, Google Cloud's Agent Platform or an LLM gateway. If your team already pays for one vendor's subscription, the simplest path is to use that vendor's agent and its default model. For a deeper look at running Claude Code versus Codex over long sessions, see [Claude Code vs Codex for 24/7 work](/blog/claude-code-vs-codex-24-7). For what the Claude plans cost, see [Claude Code pricing: Pro vs Max](/blog/claude-max-vs-pro-for-claude-code). For Codex plans, see [Codex pricing by ChatGPT plan](/blog/codex-pricing-by-chatgpt-plan).",
        "One caution on Codex: when you sign in with ChatGPT, OpenAI says GPT-5.5 retired from Codex on 14 October 2026 and moves Plus, Pro, Business, Enterprise and Edu users to GPT-6.1 Sol. API-key sessions are not affected by those retirements. Model availability follows your sign-in method.",
      ],
    },
    {
      heading: "Pick by situation",
      paragraphs: [
        [
          "| Your situation | Pick | Why |",
          "|---|---|---|",
          "| Hard multi-file refactor, bugs you cannot find | Claude Opus 5.5 | Tied first on Terminal-Bench, default in Claude Code |",
          "| Opus 5.5 at high effort still fails | Claude Fable 5.2 | Anthropic's top tier, $8 / $40, select it explicitly |",
          "| Daily coding on a budget | Claude Sonnet 5.5 or GPT-6.1 Sol | $2 / $10 each, within a few points of the leaders |",
          "| You live in the OpenAI ecosystem | GPT-6.1 Sol in Codex | Near-Astra performance, a fifth of Astra's listed price |",
          "| You want Google's stack | Gemini 4 Argon | $2 / $10 introductory ($4 / $20 after), Google's pick for most engineering work |",
          "| Thousands of small, checkable jobs | DeepSeek V4.1 Flash | Cheapest capable option, half price off-peak |",
          "| Fast autocomplete and tiny edits | Claude Haiku 5.5 or GPT-6 Luna | $0.10 / $0.50, low latency |",
          "| Code cannot leave your machine | Qwen3.8-27B | Apache-2.0, fits one computer |",
          "| Open weights with near-frontier agent scores | Kimi K3.1 Pro | Needs a cluster. Read its custom license |",
          "| Cost-controlled pipeline | DeepSeek Flash first, escalate to Sonnet 5.5 or Opus 5.5 | Pay frontier prices only for failures |",
        ].join("\n"),
      ],
    },
    {
      heading: "How to choose for your own repo",
      paragraphs: [
        "Pick five real tasks you have already solved: a bug fix, a feature touching three files, a refactor, a test-writing job and one ugly task in your messiest area. Run each candidate on all five with the same agent and the same effort setting. Count how many pass your tests, how many need manual fixes, and what each run costs. Two hours of this beats a week of reading leaderboards.",
        "Keep the effort level fixed when you compare, or you are testing settings and not models. And re-run the comparison when a vendor ships something new. This market turned over repeatedly in 2026, and the model that wins today may not in a month.",
      ],
    },
    {
      heading: "Running these agents without tying up your laptop",
      paragraphs: [
        "Long agent runs are where the model choice gets expensive and where a closed laptop stops the work. On Hivra you can run Claude Code or Codex on a private cloud computer, signed in with your own subscription login or your own API key, so the session keeps going when your machine is off. Hivra is not affiliated with Anthropic or OpenAI. It does not change which model you get or what the vendor charges. That stays between you and the vendor.",
      ],
    },
  ],
  faqs: [
    {
      q: "What is the best LLM for coding right now?",
      a: "As of November 2026, Claude Opus 5.5 is our pick for agentic multi-file work. It is tied for first on the Terminal-Bench leaderboard at 65.8% and is Claude Code's default model on most plans. Claude Sonnet 5.5 and GPT-6.1 Sol are close behind at half the price per token. Run a shortlist on your own tasks before committing.",
    },
    {
      q: "Is Claude or GPT better for coding?",
      a: "On the Terminal-Bench leaderboard as of November 2026, Claude models in Claude Code hold the top spots, with Opus 5.5 at 65.8% and Sonnet 5.5 at 63.9%. GPT-6.1 Sol in Codex scores 60.9% and GPT-6 Astra 60.3%. That is a lead of a few points, and the harness differs between the two, so test both on your own code.",
    },
    {
      q: "What is the best free or cheapest LLM for coding?",
      a: "For cheap API work, DeepSeek V4.1 Flash costs $0.15 per million input tokens on a cache miss and $0.60 per million output tokens off-peak. For free local use, Qwen3.8-27B has Apache-2.0 weights you can run yourself, though you pay for the hardware. Cheap models score lower on hard agentic tests, so expect more retries.",
    },
    {
      q: "Is SWE-bench Verified still a good way to compare coding models?",
      a: "We could not verify a current Verified score for any 2026 model. The swebench.com page showed no scores when we read it, and the 2026 Anthropic announcements we read do not report it. Terminal-Bench, which ran on version 4.1 as of November 2026, is more useful for agentic work.",
    },
    {
      q: "What is the best open-source LLM for coding?",
      a: "Kimi K3.1 Pro is the strongest open-weight model by vendor-reported scores, with 65.7% on Terminal-Bench 4.0, but it has 2.8T parameters and a custom license. For something you can run on one computer, Qwen3.8-27B is Apache-2.0 at about 28B parameters. DeepSeek V4.1 Flash is MIT-licensed but 763B parameters.",
    },
    {
      q: "Can I run a good coding model locally?",
      a: "Yes, with limits. Qwen3.8-27B is small enough for a single high-memory GPU or workstation once quantized, and it reports 61.7 on SWE-bench Pro. Qwen does not state hardware requirements, so check memory for your quantization. It will not match Opus 5.5 on long multi-file agent runs, so use it for edits, tests and private code.",
    },
    {
      q: "Which model does Claude Code use?",
      a: "Per Anthropic's Claude Code docs, the default is Opus 5.5 on Pro, Max, Team, Enterprise and API accounts. The sonnet alias gives Sonnet 5.5 and haiku gives Haiku 5.5 on the Anthropic API. Fable models are never the default, and you select one explicitly. Effort levels run from low to max.",
    },
    {
      q: "Which model does Codex use?",
      a: "Codex lists GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra and GPT-6 Luna as recommended models. OpenAI says Sol gives near-Astra performance at lower cost and has a 500,000-token default context in Codex. With a ChatGPT sign-in, paid plans were moved to GPT-6.1 Sol after GPT-5.5 retired on 14 October 2026.",
    },
    {
      q: "How much does it cost to use these models through the API?",
      a: "Per million input and output tokens in November 2026: Opus 5.5 $4 and $20, Sonnet 5.5 $2 and $10, GPT-6.1 Sol $2 and $10, Gemini 4 Argon $2 and $10 (introductory, $4 and $20 after), GPT-6 Astra $10 and $50, Fable 5.2 $8 and $40. DeepSeek V4.1 Flash is much lower. Subscriptions are priced differently, and caching can cut input cost sharply.",
    },
  ],
  relatedArticles: [
    { slug: "cursor-vs-claude-code", title: "Cursor vs Claude Code: which keeps going when you walk away?" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
    { slug: "claude-max-vs-pro-for-claude-code", title: "Claude Code pricing: Pro vs Max, and when API billing is cheaper" },
    { slug: "codex-pricing-by-chatgpt-plan", title: "Codex pricing by ChatGPT plan: Plus, Pro 100/200/500 and API keys" },
  ],
};
