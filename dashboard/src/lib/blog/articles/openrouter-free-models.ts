import { BlogArticle } from "../types";

// Written 2026-11-17 for "openrouter free models" (US ~2,400/month, low difficulty).
// Sources, all fetched 2026-11-17:
// https://openrouter.ai/api/v1/models (authoritative list; filtered to ids ending ":free", 14 of 470 models)
// https://openrouter.ai/docs/api-reference/limits (free usage limits table, credit and in-flight budget notes)
// https://openrouter.ai/docs/faq (rate limit and free tier answers)
// https://openrouter.ai/docs/guides/routing/model-variants/free (the :free variant, paid fallback warning)
// https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground (openrouter/free router)
// https://openrouter.ai/docs/guides/privacy/logging (training and retention settings, separate for paid and free)
// Not verified: per-provider retention terms for each free model (the logging page renders them as a live table), model quality.
// Hivra is not affiliated with OpenRouter. The free list changes often, so every list fact is date-stamped.

export const article: BlogArticle = {
  slug: "openrouter-free-models",
  title: "OpenRouter free models: the current list, real limits and how to use them",
  metaTitle: "OpenRouter free models: list, limits, how to use",
  metaDescription:
    "The OpenRouter free models available in November 2026, the real rate limits (20 a minute, 50 or 1,000 a day), API examples and privacy caveats.",
  publishedDate: "2026-11-17",
  lastModified: "2026-11-17",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "Fourteen free models, one hard daily cap, and a few things to know before you point an agent at them.",
  intro:
    "OpenRouter lists a handful of models you can call without paying per token. They are real, they support tool calling, and they come with tight limits and weaker privacy terms. This guide shows the list as of November 2026, the exact limits, a working API call, and where free stops being enough.",
  shortAnswer:
    "OpenRouter free models are model IDs ending in `:free`. As of November 2026 there are 14. Limits are 20 requests a minute, and 50 requests a day, or 1,000 a day once you have bought at least 10 credits. Call them like any other model, but expect rate limits and weaker privacy.",
  sections: [
    {
      heading: "What counts as an OpenRouter free model?",
      paragraphs: [
        "A free model on OpenRouter is a separate catalog entry whose ID ends in `:free`. It has its own pricing (zero), its own context length and its own endpoints. OpenRouter's [docs on the free variant](https://openrouter.ai/docs/guides/routing/model-variants/free) say you append `:free` to the ID of a model that has a free entry, and only models that list one support it. You cannot add `:free` to any model you like.",
        "There is also a router called `openrouter/free`. It picks a free model at random from the available free models, and filters for the features your request needs, such as image input, tool calling and structured outputs. Its own context length is listed at 200,000 tokens. Use it when you do not care which free model answers.",
        "Free here means no per-token charge. It does not mean no rules. The limits below apply, the privacy terms are different, and free models come and go. One model on the current list carries an expiration date of 31 December 2026 in the API.",
      ],
    },
    {
      heading: "Which OpenRouter models are free right now?",
      paragraphs: [
        "This table comes from OpenRouter's own models API, filtered to IDs ending in `:free`, fetched in November 2026. It showed 14 free models out of 470 in total. Every one of the 14 lists tool calling as a supported parameter. Treat the list as a snapshot, because OpenRouter adds and retires free models often.",
        [
          "| Model ID | Context length (tokens) | Input | Good for |",
          "|---|---|---|---|",
          "| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | Text | The biggest free model. NVIDIA describes it as a reasoning and orchestration model, so try it first for agent planning |",
          "| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | Text | High-throughput agent loops and short, specialised tasks. 3B active parameters, so it is fast |",
          "| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | Text, image, video | Reading screenshots, documents and GUIs. Supports structured outputs |",
          "| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256,000 | Text, image, audio, video | Cheap multimodal reasoning when you need audio or video in |",
          "| `cohere/north-mini-code:free` | 256,000 | Text | Coding. Cohere calls it its first agentic coding model (30B total, 3B active) |",
          "| `particle-ai/particle-1:free` | 1,048,576 | Text, image | Coding agents: terminal work and codebase changes. Supports structured outputs |",
          "| `recursive/flint-v1.0:free` | 262,144 | Text | Coding agents. Small active size (about 2.5B), so quality is a test-it-yourself question |",
          "| `baidu/ernie-5.5-flash-preview:free` | 1,024,000 | Text | General work with tools. Baidu cites coding, agentic use and research. A preview |",
          "| `inclusionai/ling-3.2-flash:free` | 1,048,576 | Text, image | General chat and tool use with optional thinking. Supports structured outputs |",
          "| `thinkingmachines/inkling-2-small:free` | 1,048,576 | Text, image | Reasoning tasks. Open-weight, 17B active parameters |",
          "| `google/gemma-4-31b-it:free` | 262,144 | Text, image, video | Dependable general assistant work. Google lists function calling and a thinking mode |",
          "| `google/gemma-4-26b-a4b-it:free` | 262,144 | Text, image, video | A lighter Gemma for quick, simple calls |",
          "| `dots-studio/dots-3-note-preview:free` | 512,000 | Text, image | Long notes and documents. A preview, with an expiration date of 2026-12-31 in the API |",
          "| `liquid/lfm-3-1.7b:free` | 262,144 | Text | Tiny classification, routing and extraction jobs. Only 1.7B parameters and 8,192 max output tokens |",
        ].join("\n"),
        "How to read the \"good for\" column: it is built from the descriptions the model makers gave OpenRouter, plus the supported parameters in the API. It is not a benchmark. Nobody on this page has ranked these models for you, and this guide does not claim any of them matches a paid frontier model.",
        "To get the live list yourself, run `curl -s https://openrouter.ai/api/v1/models` and keep entries whose `id` ends in `:free`. In the browser, open the [models page](https://openrouter.ai/models) and set the maximum price filter to 0. Searching \"free\" in the chat playground model picker also works.",
      ],
    },
    {
      heading: "What are the real limits on free models?",
      paragraphs: [
        "OpenRouter's [limits page](https://openrouter.ai/docs/api-reference/limits) gives a two-row table for any model ID ending in `:free`. Your row depends on the total credits you have ever purchased.",
        [
          "| Credits purchased (all time) | Requests per minute | Requests per day |",
          "|---|---|---|",
          "| Less than 10 | 20 | 50 |",
          "| At least 10 | 20 | 1,000 |",
        ].join("\n"),
        "As of November 2026, that is the whole story. The per-minute cap stays at 20 whichever row you are in. Buying credits only raises the daily cap, from 50 to 1,000. The FAQ says the same thing in plain words: free models have low limits and are \"usually not suitable for production use\".",
        "Three details people miss. First, the 10 credits are a purchase threshold, not something you spend. The docs say the higher daily ceiling starts one credit below the threshold to absorb rounding and top-up fees. Second, making more accounts or API keys does not help. The limits page says OpenRouter governs capacity globally, so extra keys will not raise your limits. Third, if your account balance goes negative you can see errors, including on free models. Topping up above zero fixes it.",
        "Limits are counted per request, not per token. An agent that loops, or makes a tool call every few seconds, can use up 50 requests quickly. At 1,000 a day it is more workable for light personal use, which is why that row is the one worth paying for if you plan to use free models regularly.",
        "You can check where you stand with one call to `GET https://openrouter.ai/api/v1/key`. The response includes a `free_model_daily_requests` field with the daily counter and ceiling. The per-minute limit is not reported there. When you are rate limited on a free model, the error carries `X-RateLimit-*` headers.",
      ],
    },
    {
      heading: "How do I call an OpenRouter free model? Step by step",
      paragraphs: [
        "1. Create an OpenRouter account and make an API key at [openrouter.ai/keys](https://openrouter.ai/keys). Store it in an environment variable, not in a file you commit.",
        "2. Pick a model ID from the table above. Keep the `:free` suffix. Without it, you call the paid version and get charged.",
        "3. Send a normal chat completions request. OpenRouter implements the OpenAI API format, so any OpenAI client works with a changed base URL.",
        "Curl:\n\n```\nexport OPENROUTER_API_KEY=\"sk-or-...\"\n\ncurl https://openrouter.ai/api/v1/chat/completions \\\n  -H \"Authorization: Bearer $OPENROUTER_API_KEY\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"model\": \"nvidia/nemotron-3-ultra-550b-a55b:free\",\n    \"messages\": [{\"role\": \"user\", \"content\": \"Give me three names for a build-status bot.\"}]\n  }'\n```",
        "Python with the OpenAI SDK:\n\n```\nimport os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url=\"https://openrouter.ai/api/v1\",\n    api_key=os.environ[\"OPENROUTER_API_KEY\"],\n)\n\nresp = client.chat.completions.create(\n    model=\"nvidia/nemotron-3-ultra-550b-a55b:free\",\n    messages=[{\"role\": \"user\", \"content\": \"Summarise this in one line: ...\"}],\n)\nprint(resp.choices[0].message.content)\n```",
        "To let OpenRouter choose for you, set the model to `openrouter/free`. To use the playground with no code, open [openrouter.ai/chat](https://openrouter.ai/chat), press Ctrl+K or Cmd+K, type \"free\" and pick a model.",
        "4. Add tools if you need them. All 14 current free models list `tools` as a supported parameter, so a standard OpenAI-style `tools` array is accepted. Whether a given model uses tools well is a separate question, covered below.",
        "5. Handle 429 errors. A free model returns a rate limit error when you pass your cap. Retry with a delay that grows each time, and cap the retries.",
      ],
    },
    {
      heading: "The trap: fallbacks can quietly cost money",
      paragraphs: [
        "OpenRouter lets you send a `models` array so a request falls through to the next model when the first fails. The docs carry a warning about this. If you list a `:free` model in that array, OpenRouter moves to the next entry when the free model is rate limited, unavailable, or has no endpoint that fits your request. Each model is billed at its own price, so falling back to a paid model costs money even though your first choice was free.",
        "To keep a request free, list only `:free` models in `models`, or use `openrouter/free` on its own. On its own, the router falls back only to other free models. If you want a paid safety net on purpose, that is fine, but set a spending limit on the key first. The `GET /api/v1/key` response shows `limit_remaining` for a per-key credit cap.",
      ],
    },
    {
      heading: "Privacy: what changes on free endpoints",
      paragraphs: [
        "This is the caveat that matters most for anything that touches real code or customer data. OpenRouter's [logging page](https://openrouter.ai/docs/guides/privacy/logging) says each provider has its own retention and training policy, and OpenRouter reflects those policies in structured data on every endpoint. Your account's privacy settings control whether you allow routing to providers that may train on your data, with separate settings for paid and free models.",
        "Turning off training for free models in your privacy settings limits routing to providers that do not train, which can shrink the set of free models you can reach. One entry on the current list says so in its own description: `liquid/lfm-3-1.7b:free` states that prompts and outputs may be retained and used.",
        "The November 2026 list also includes models served by providers whose terms vary. The honest summary is that the logging page renders a live table of each provider's terms, and this guide has not audited every row. Open it before you send anything sensitive.",
        "Rules of thumb. Do not send secrets, private source code, customer records or anything under an NDA to a free endpoint. Use free models for public text, throwaway experiments and learning. You can also restrict a single request to providers with a given data policy, or set a data policy filter for your whole account in your privacy settings. Both can shrink the set of models you can actually reach.",
      ],
    },
    {
      heading: "Which free models are actually good for agents and coding?",
      paragraphs: [
        "A fair question, and the one this guide can only partly answer. Every model on the list supports tool calling on paper. That says the API accepts a `tools` array. It does not say the model picks the right tool, formats arguments cleanly, or stays on task over fifty steps.",
        "What the descriptions say. For agent planning, `nvidia/nemotron-3-ultra-550b-a55b:free` is the largest by far (550B total, 55B active, 1,000,000 context) and NVIDIA pitches it as an open reasoning and orchestration model. For coding, three entries are built for it by their makers: `cohere/north-mini-code:free`, `particle-ai/particle-1:free` and `recursive/flint-v1.0:free`. Particle-1 and Ling 3.2 Flash also list structured outputs, which helps when your agent must return JSON.",
        "What to expect. Small active-parameter models are quick but make more tool-call mistakes on long tasks. Preview models can change or disappear. And the 20 per minute cap is a real constraint for an agent that fires many small calls in a row.",
        "If you want to try them in a real agent, [Hermes Agent](/agents/hermes) and [OpenClaw](/agents/openclaw) both take an OpenRouter key and a `:free` model ID.",
        "A sensible way to test: write five tasks from your real work, run each model through them, and count failures. A free model that handles lookup, summarising and file renaming but trips on multi-step refactors is still useful, as long as you route the hard jobs elsewhere. That routing idea, cheap for easy steps and strong for hard ones, is the heart of [AI agent API cost optimization](/blog/ai-agent-api-cost-optimization).",
      ],
    },
    {
      heading: "When free stops being enough",
      paragraphs: [
        "Four signs. You hit the daily cap, because 1,000 requests a day goes fast when an agent runs scheduled jobs. You need the work to finish reliably, and a 429 at 3 a.m. means a missed task. You handle data you would not want logged. Or the model fails often enough that retries cost you more time than the model saves.",
        "The next step is cheap models on paid credits, not a jump to a premium one. Paid models are billed per token, and the in-flight spending budget described on the limits page does not apply to free models, but it can apply to small prepaid balances on paid ones. For rough numbers on what that costs, see [what an AI agent costs per month in API tokens](/blog/ai-agent-api-cost-optimization) and [the real cost of running a persistent AI agent](/blog/cost-of-running-ai-agent).",
        "The 10-credit purchase has a useful side effect. It lifts your free daily cap from 50 to 1,000 whether or not you spend the credits. So the cheapest way to get a workable free setup is to buy the minimum once and keep the free models for easy steps.",
      ],
    },
    {
      heading: "Using an OpenRouter key with an agent",
      paragraphs: [
        "Agent frameworks that support OpenRouter let you paste the key and set the model ID, including a `:free` one. [Hermes Agent](/blog/what-is-hermes-agent) and OpenClaw both support OpenRouter themselves, so you set the provider to OpenRouter and the model to something like `nvidia/nemotron-3-ultra-550b-a55b:free`. Start with one scheduled task, not your whole workload, so you can see how many requests a day it really uses.",
        "Hivra runs agents on their own private cloud computer, and you can bring your own API key, so an OpenRouter key works as a provider key there. Hivra is not affiliated with OpenRouter, and the key is yours, billed and limited by OpenRouter. The limits in this guide apply to it exactly as they would anywhere else. If you want the longer story on keys, read [BYO API key: what it means and why it matters](/blog/byo-api-key-explained).",
        "One practical point for always-on agents. A free key does not change what an agent does when the model returns an error. Make sure the agent retries politely and that a hard 429 on the daily cap does not leave a task half done. If you cannot tolerate that, use paid credits for the scheduled jobs.",
      ],
    },
    {
      heading: "Quick checklist before you rely on a free model",
      paragraphs: [
        "Confirm the ID ends in `:free`. Check your row in the limits table and call `GET /api/v1/key` to see your counter. List only free models in any `models` fallback array. Review your privacy settings and the provider terms for that model. Test it on five of your own tasks. Add retry with backoff. Re-check the list monthly, because models move.",
      ],
    },
    {
      heading: "Conclusion",
      paragraphs: [
        "OpenRouter's free models are a good way to learn, prototype and run light, low-stakes jobs. As of November 2026 you get 14 of them, 20 requests a minute, and 50 requests a day, or 1,000 once you have bought 10 credits. Watch the fallback billing trap, and keep private data off them.",
        "If you outgrow them and want an agent running on a computer of its own, Hivra can host Hermes Agent, OpenClaw and others with your own OpenRouter key. Start with the free models, measure what you use, then decide.",
      ],
    },
  ],
  faqs: [
    {
      q: "How do I find free models on OpenRouter?",
      a: "Look for model IDs ending in `:free`. In the browser, open the models page and set the maximum price to 0, or search \"free\" in the chat playground. Through the API, call `https://openrouter.ai/api/v1/models` and keep the entries whose `id` ends in `:free`. On November 2026 that gave 14 models.",
    },
    {
      q: "Are OpenRouter free models really free?",
      a: "Yes, there is no per-token charge on a `:free` model. The catches are limits and privacy. You get 20 requests a minute, and 50 requests a day, or 1,000 a day after buying at least 10 credits. A `models` fallback array that includes a paid model will bill you if the free one fails.",
    },
    {
      q: "What is the daily limit for OpenRouter free models?",
      a: "As of November 2026, 50 requests a day if you have purchased less than 10 credits in total, and 1,000 requests a day if you have purchased at least 10. The per-minute cap is 20 in both cases. Making extra accounts or keys does not raise it.",
    },
    {
      q: "Do I need to add a credit card to use free models?",
      a: "OpenRouter's FAQ says new users get a small free allowance to test the service, and that free models are available at the lower limit of 50 requests a day. Check the sign-up flow for current payment requirements, since this guide did not verify them. Buying 10 credits raises the daily cap to 1,000.",
    },
    {
      q: "What does the openrouter/free router do?",
      a: "It picks a free model at random from the available free models, filtered for the features your request needs, such as images, tool calling or structured outputs. Used on its own, it falls back only to other free models. You cannot choose which model answers, so it is better for experiments than for repeatable agent work.",
    },
    {
      q: "Do free models support tool calling for agents?",
      a: "All 14 free models on the November 2026 list show tool calling as a supported parameter, so the API accepts tools. How reliably each model uses them is something to test yourself. Agents that make many calls will also hit the 20 per minute cap quickly.",
    },
    {
      q: "Is my data private on OpenRouter free models?",
      a: "Not by default. Each provider sets its own retention and training policy, and some free endpoints may train on or retain prompts. Your privacy settings have separate controls for paid and free models. Keep secrets, private code and customer data off free endpoints unless you have checked that provider's terms.",
    },
    {
      q: "Can I use a free OpenRouter model in Hermes Agent or OpenClaw?",
      a: "Yes. Both support OpenRouter as a provider, so you paste your OpenRouter key and set the model to a `:free` ID. Expect the same limits as any other client. Hivra can run these agents on a private cloud computer with your own key, and Hivra is not affiliated with OpenRouter.",
    },
    {
      q: "Why did my free model stop working?",
      a: "Likely causes: you hit the 20 per minute or daily cap, the model was retired or is a preview with an expiry date, your privacy settings exclude the providers serving it, or your account balance went negative. Check the `GET /api/v1/key` response and the error metadata.",
    },
  ],
  relatedArticles: [
    { slug: "byo-api-key-explained", title: "BYO API key: what it means and why it matters" },
    { slug: "ai-agent-api-cost-optimization", title: "What an AI agent costs per month in API tokens (2026)" },
    { slug: "cost-of-running-ai-agent", title: "The real cost of running a persistent AI agent in 2026" },
    { slug: "what-is-hermes-agent", title: "What is Hermes Agent? A plain-English explanation" },
  ],
};
