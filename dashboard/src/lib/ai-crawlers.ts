// The AI crawlers and fetchers that must get Hivra's metadata inside <head>.
//
// Next.js streams title, description and canonical into <body> for dynamic
// generateMetadata pages, except for user agents in `htmlLimitedBots`. Its
// default list covers Bingbot, applebot and Google's tools, but not these AI
// crawlers, and most of them do not run JavaScript, so a page whose metadata is
// streamed looks like it has none. Nothing is broken today (the probe shows all
// metadata in <head>), so this is a guard for the day a page goes dynamic.
//
// Setting the option REPLACES Next's default list, so next.config.ts extends
// it instead of overwriting it. Next turns the RegExp into its source string
// and matches it case-insensitively, so only the source matters.
//
// Vendor documentation for each name:
//   OpenAI      GPTBot (training), OAI-SearchBot (search), ChatGPT-User (user fetches)
//   Anthropic   ClaudeBot (training), Claude-SearchBot (search), Claude-User (user fetches)
//   Perplexity  PerplexityBot (search), Perplexity-User (user fetches)
//   Common Crawl CCBot
// Do not block any of these in robots.txt: OpenAI, Anthropic and Perplexity each
// say blocking their search bot removes or reduces visibility in their answers.

export const AI_CRAWLER_USER_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "CCBot",
] as const;

/** Next's default HTML-limited bot pattern plus the AI crawlers above. */
export function htmlLimitedBotsWithAiCrawlers(nextDefault: RegExp): RegExp {
  return new RegExp(`${nextDefault.source}|${AI_CRAWLER_USER_AGENTS.join("|")}`, "i");
}
