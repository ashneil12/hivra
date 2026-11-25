import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

// Written 2026-11-25 for "claude code mcp" (US 1,900 searches a month, KD 1). It is the hub page for adding MCP servers to
// Claude Code. Keeping a session alive stays in keep-claude-code-running-24-7, the permission flag in
// claude-code-dangerously-skip-permissions, Remote Control in claude-code-remote-control.
// Primary sources, all fetched 2026-11-25:
// https://code.claude.com/docs/en/mcp (claude mcp add for http, sse and stdio, the -- separator, --env, --header, scopes and
//   their storage files, precedence, .mcp.json and ${VAR} / ${VAR:-default} expansion, approval prompt for project servers and
//   claude mcp reset-project-choices, claude mcp list / get / remove, /mcp panel and status markers, OAuth via /mcp, claude mcp
//   login and logout, --callback-port, add-json, add-from-claude-desktop (macOS and WSL only), claude.ai connectors,
//   MCP_TIMEOUT, MAX_MCP_OUTPUT_TOKENS (default 25,000, warning above 10,000), prompt-injection warning, claude --debug-file)
// https://modelcontextprotocol.io/docs/getting-started/intro (what MCP is, the USB-C comparison, supported clients)
// Hivra facts: app/agents/content/claude-code.ts (official Anthropic CLI installed, browser
//   terminal, files, Telegram tab, Hivra administrators retain infrastructure access),
//   lib/blog/runtime-facts.ts (CLI_RUN_LIFETIME), lib/blog/plan-facts.ts (price and size).
// Not claimed: that Hivra preinstalls, manages or vets MCP servers; affiliation with Anthropic; setup times; backups;
// Windows-specific MCP setup (the docs page we could read gives none beyond process shutdown); tool search settings.

export const claudeCodeMcp: BlogArticle = {
  slug: "claude-code-mcp",
  title: "Claude Code MCP: how to add and manage MCP servers",
  metaTitle: "Claude Code MCP: add and manage MCP servers",
  metaDescription:
    "How to connect MCP servers to Claude Code with claude mcp add: HTTP, SSE and stdio, scopes, .mcp.json, OAuth, debugging and the security risks.",
  publishedDate: "2026-11-25",
  lastModified: "2026-11-25",
  readingTimeMin: 12,
  author: "Hivra team",
  tagline: "One command per server, three scopes, and a few cautions worth reading before you paste a URL.",
  intro:
    "MCP is how Claude Code reaches tools and data it can't touch by itself: your issue tracker, a database, a browser, your error monitor. This guide covers the commands for each type of server, where the settings are stored, how sign-in works, how to check and debug what you have added, and the security risks, using only what Anthropic documents as of November 2026.",
  shortAnswer:
    "To add an MCP server to Claude Code, run `claude mcp add --transport http <name> <url>` for a remote server, or `claude mcp add <name> -- <command>` for a local one. Then run `/mcp` inside Claude Code to check status and sign in. Add `--scope project` to share a server through a .mcp.json file.",
  sections: [
    {
      heading: "What MCP is, in short",
      paragraphs: [
        "MCP, the Model Context Protocol, is an open-source standard for connecting AI applications to external systems. The [MCP site](https://modelcontextprotocol.io/docs/getting-started/intro) compares it to a USB-C port for AI: one standard way to plug an assistant into data sources such as files and databases, tools such as search engines, and workflows such as specialised prompts. A server exposes those things, and a client such as Claude Code connects to it. Because the protocol is open, the same server can work with Claude, ChatGPT, Visual Studio Code, Cursor and other clients that support it. For you, that means you add a server once and Claude Code can use what it offers, such as reading a ticket and then writing the fix.",
        "Everything below works the same wherever Claude Code runs, on your laptop, a VPS or a [Claude Code computer on Hivra](/agents/claude-code) that stays on when your laptop is shut.",
      ],
    },
    {
      heading: "The three kinds of server at a glance",
      paragraphs: [
        "Claude Code connects to MCP servers in three ways, which Anthropic's [MCP documentation](https://code.claude.com/docs/en/mcp) calls transports. Almost everything you add will be one of the first two.",
        [
          "| Transport | Where the server runs | Command shape | Use it when |",
          "|---|---|---|---|",
          "| HTTP | On the vendor's servers, reached by URL | `claude mcp add --transport http <name> <url>` | The service offers a remote server. Anthropic's docs recommend this one |",
          "| stdio | As a process on the same computer as Claude Code | `claude mcp add <name> -- <command> [args...]` | The server is an npm package or a program you run locally, such as a database tool |",
          "| SSE | On the vendor's servers, reached by URL | `claude mcp add --transport sse <name> <url>` | An older remote server only offers SSE. Anthropic marks this transport deprecated |",
        ].join("\n"),
      ],
    },
    {
      heading: "Add a remote HTTP server",
      paragraphs: [
        "A remote server is the simplest case, because there is nothing to install. Give it a name and its URL:",
        "```bash\nclaude mcp add --transport http notion https://mcp.notion.com/mcp\n```",
        "If the server wants a token in a header, pass it with `--header`:",
        "```bash\nclaude mcp add --transport http secure-api https://api.example.com/mcp \\\n  --header \"Authorization: Bearer your-token\"\n```",
        "The GitHub server is added the same way, with a personal access token in the header:",
        "```bash\nclaude mcp add --transport http github https://api.githubcopilot.com/mcp/ \\\n  --header \"Authorization: Bearer YOUR_GITHUB_PAT\"\n```",
        "If a service only offers an SSE endpoint, use the same shape with `--transport sse`:",
        "```bash\nclaude mcp add --transport sse asana https://mcp.asana.com/sse\n```",
        "Anthropic's docs also say that `--transport http` now tries HTTP first and falls back to SSE automatically on current versions, so you rarely need to choose by hand. When you write the server into a JSON file instead, `\"type\": \"streamable-http\"` is accepted as another way to say `http`. One trap: a JSON entry that has a `url` but no `type` is treated as a stdio server and skipped, so always set the type.",
      ],
    },
    {
      heading: "Add a local stdio server",
      paragraphs: [
        "A stdio server is a program Claude Code starts on the same computer and talks to through its input and output. The syntax is:",
        "```bash\nclaude mcp add [options] <name> -- <command> [args...]\n```",
        "The double dash matters. Everything after `--` is passed to the server untouched. Without it, Claude Code tries to read the server's own flags as its flags. Here is Anthropic's Airtable example, which also shows how to pass a secret through the server's environment:",
        "```bash\nclaude mcp add --env AIRTABLE_API_KEY=YOUR_KEY --transport stdio airtable \\\n  -- npx -y airtable-mcp-server\n```",
        "`--env` takes one or more `KEY=value` pairs. If you put another option after it, such as `--transport stdio`, put it before the server name so the name is not swallowed as a value. A database example from the same page, using a read-only database user on purpose:",
        "```bash\nclaude mcp add --transport stdio db -- npx -y @bytebase/dbhub \\\n  --dsn \"postgresql://readonly:pass@prod.db.com:5432/analytics\"\n```",
        "Claude Code also sets `CLAUDE_PROJECT_DIR` in a stdio server's environment, so a project server can find its own folder. In a project `.mcp.json` you write it as `${CLAUDE_PROJECT_DIR:-.}`.",
        "If you already have the server's configuration as JSON, `claude mcp add-json` takes it directly:",
        "```bash\nclaude mcp add-json local-weather '{\"type\":\"stdio\",\"command\":\"/path/to/weather-cli\",\"args\":[\"--api-key\",\"abc123\"],\"env\":{\"CACHE_DIR\":\"/tmp\"}}'\n```",
        "A note on names: server names added through `claude mcp` commands can contain only letters, numbers, hyphens and underscores.",
      ],
    },
    {
      heading: "Scopes: local, project and user",
      paragraphs: [
        "Every server you add lives in one of three scopes, which decide where the setting is stored and who gets it. Pick one with `--scope`:",
        [
          "| Scope | Flag | Stored in | Who gets it |",
          "|---|---|---|---|",
          "| Local (the default) | `--scope local` | `~/.claude.json` | You, in the current project only |",
          "| Project | `--scope project` | `.mcp.json` at the project root | Everyone who uses the repo, through version control |",
          "| User | `--scope user` | `~/.claude.json` | You, in every project |",
        ].join("\n"),
        "```bash\nclaude mcp add --transport http shared-server --scope project https://example.com/mcp\n```",
        "A simple rule: use local for something you are trying out, user for tools you want everywhere (a notes app, say), and project for servers the whole team should have. Because a project server is a file in the repository, a teammate gets it by pulling. They are asked to approve it the first time in an interactive session, and `claude mcp reset-project-choices` resets those choices.",
        "If the same server name appears in more than one place, Claude Code does not merge them. The order of precedence is local, then project, then user, then plugin-provided servers, then claude.ai connectors. A server delivered through managed settings by an administrator outranks all of them.",
      ],
    },
    {
      heading: "The .mcp.json file and environment variables",
      paragraphs: [
        "The project scope is just a JSON file named `.mcp.json` in your repository root. Anthropic's example shows the shape, including variables:",
        "```json\n{\n  \"mcpServers\": {\n    \"api-server\": {\n      \"type\": \"http\",\n      \"url\": \"${API_BASE_URL:-https://api.example.com}/mcp\",\n      \"headers\": { \"Authorization\": \"Bearer ${API_KEY}\" }\n    }\n  }\n}\n```",
        "Two variable forms work: `${VAR}` and `${VAR:-default}`, which uses the default when the variable is unset. Expansion works in `command`, `args`, `env`, `url` and `headers`. This is how you commit a server to git without committing the token: the file names the variable and each teammate sets it in their own environment.",
        "Two details from the docs save a debugging session. If a variable is unset and has no default, the server still loads, with the literal `${VAR}` text in place and a warning. And certain credential variables read as empty when used in a remote server's `url` or `headers`, on purpose, so that they are not sent to a remote server. The docs list `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `HTTPS_PROXY` and `NPM_TOKEN` as examples. If a header comes out empty, run `claude --debug-file /tmp/claude-debug.log` and search the file for `never expanded toward a remote server`.",
      ],
    },
    {
      heading: "Sign in to a server that uses OAuth",
      paragraphs: [
        "Many remote servers use OAuth rather than a pasted token. You add the server as usual, then sign in from inside Claude Code:",
        "```text\n/mcp\n```",
        "Choose the server and complete the flow in your browser. Anthropic's docs say tokens refresh automatically, and that \"Clear authentication\" in the same panel revokes access. If you would rather do it from the shell, `claude mcp login <name>` and `claude mcp logout <name>` do the same job, and `--no-browser` prints a URL prompt instead of opening a browser, which helps on a machine with no screen.",
        "Some providers only accept a fixed callback address. For those, set a port when you add the server, and the redirect address becomes `http://localhost:PORT/callback`:",
        "```bash\nclaude mcp add --transport http --callback-port 8080 my-server https://mcp.example.com/mcp\n```",
        "If a provider gave you a client ID and secret, pass `--client-id your-client-id` and `--client-secret`. The secret is prompted for with masked input, and `MCP_CLIENT_SECRET` in the environment skips the prompt for automated runs.",
        "One limit to know about: some Anthropic-hosted connectors, such as Microsoft 365, Gmail and Google Calendar, do not support OAuth from Claude Code, because the identity provider only accepts the address registered by claude.ai. For those, connect the service at claude.ai/customize/connectors and it appears in Claude Code automatically.",
      ],
    },
    {
      heading: "List, check, remove and debug servers",
      paragraphs: [
        "Four commands cover day-to-day management:",
        "```bash\nclaude mcp list         # every server, with its health status\nclaude mcp get notion   # details for one server\nclaude mcp remove notion\n```",
        "`remove` also deletes any stored OAuth tokens for a remote server. Inside a session, `/mcp` shows the same list with status, sign-in and the option to enable or disable each server. To switch a server off without deleting it, use that panel, which records the choice in `disabledMcpServers` in `~/.claude.json`.",
        "The status markers tell you what is wrong: `Connected`, `Needs authentication`, `Failed to connect`, `Pending approval` (run `claude` to approve a project server) and `Disabled for this project`. When a server fails, work down this list:",
        "- **Run `claude mcp get <name>`** and read the failure detail it prints.\n- **For a stdio server, run the command yourself** in a terminal. If `npx` cannot find the package or the program crashes, Claude Code will not do better.\n- **Check the double dash.** A missing `--` is the most common cause of a stdio server that never starts, because Claude Code reads the server's flags as its own.\n- **Check variables.** `claude mcp list` and `get` show variable references, not their values, so a `${VAR}` there is normal. Look instead for the missing-variable warning when Claude Code starts, or an empty header on a remote server, which points to an unset or deliberately blanked variable.\n- **Retry.** Remote servers that drop mid-session get five retries with a delay that doubles from one second, and `/mcp reconnect all` retries everything that failed or needs sign-in on current versions.\n- **Raise the startup timeout** if a slow server never finishes starting: `MCP_TIMEOUT=60000 claude` gives it sixty seconds. The value is in milliseconds, and Anthropic's docs give the default as 30 seconds, so only a number above 30000 makes the wait longer.",
        "You can also import servers you already set up in Claude Desktop with `claude mcp add-from-claude-desktop`. Anthropic says this works only on macOS and Windows Subsystem for Linux, and servers with a name that has spaces or other odd characters are skipped.",
      ],
    },
    {
      heading: "Output limits and the token warning",
      paragraphs: [
        "A tool that returns a huge result can fill your context. Claude Code warns you when an MCP tool's output goes above 10,000 tokens, and caps it at 25,000 tokens by default. If you have a good reason to allow more, raise the cap with an environment variable:",
        "```bash\nMAX_MCP_OUTPUT_TOKENS=50000 claude\n```",
        "Anthropic's docs add that successful text results of more than 50,000 characters are saved to a file instead of being pasted into the conversation, unless the server raises that limit itself. The better fix is usually to ask the server for less: a narrower query, fewer rows, one page at a time.",
      ],
    },
    {
      heading: "Servers worth adding first",
      paragraphs: [
        "There is no official ranking, but the servers Anthropic's own documentation uses as examples are a fair guide to what people connect first: GitHub (issues and pull requests), Notion and Asana (tasks and notes), Airtable, Sentry (errors), Stripe, HubSpot, and a PostgreSQL database through DBHub.",
        "Claude Code can also use connectors you set up in claude.ai. If you sign in to Claude Code with a claude.ai account, those connectors appear in `/mcp` automatically. Anthropic notes they are not loaded if you authenticate with an API key or a third-party provider such as Amazon Bedrock instead.",
      ],
    },
    {
      heading: "Security: only add servers you trust",
      paragraphs: [
        "Anthropic's documentation carries a plain warning: verify that you trust each MCP server before you connect it, because servers that fetch external content can expose you to prompt injection. Prompt injection means text inside a web page, ticket or document that is written to look like instructions, and that the model may follow. An MCP server that pulls in issue comments or web pages is a route for that text to reach Claude, and an agent that can also run commands or write files can be tricked into using them.",
        "A few habits keep the risk down:",
        "- **Prefer servers from the service's own maintainers.** A random package from a forum thread runs as a program on your computer if it is a stdio server.\n- **Give each server the least access that works.** Use a read-only database user, as Anthropic's own example does, and a token with narrow scopes.\n- **Keep secrets out of the repository.** Use `${VAR}` in `.mcp.json` instead of the token itself.\n- **Read the approval prompt** for a project server before you accept it. A `.mcp.json` pulled from someone else's repo can start a program on your machine.\n- **Be careful about combining powers.** A server that reads untrusted content plus a session that can run any command is the dangerous pairing. Our guide to [the permission-skipping flag](/blog/claude-code-dangerously-skip-permissions) covers why, and [leaving an agent running unattended](/blog/is-it-safe-to-leave-an-ai-agent-running-unattended) covers the wider risks.",
      ],
    },
    {
      heading: "Where your MCP servers run: laptop, VPS or a Hivra computer",
      paragraphs: [
        "A stdio MCP server is a process on whatever computer Claude Code runs on, and its sign-in lives there too. That makes the answer to \"where should Claude Code run\" matter more once you have servers. If it runs on your laptop, a database tool or a browser server stops when the lid closes, and the work Claude was doing with them stops too.",
        "Hivra runs Claude Code on a cloud computer of its own, with the official Anthropic CLI installed, and you open its terminal and files in a browser from any device. There the `claude mcp add` commands in this guide work as written, in the Terminal tab. The computer stays available when yours doesn't, and a Claude Code run you start inside tmux keeps going after you close your laptop. Work you send through the agent's Telegram tab also runs on the computer. It also keeps coding tools, credentials and experiments separate from your everyday laptop.",
        CLI_RUN_LIFETIME,
        "Here is the part that is not about Claude Code at all. Hivra is not tied to one agent. The same account launches agents including Hermes, OpenClaw, Claude Code, Codex and Agent Zero, each on a computer of its own, and you reach all of them from a browser on any device. MCP is an open standard, so if you try Codex next month, the servers you have learned to set up carry over, and you do not need a second account or a second server to find out. Hivra is not affiliated with Anthropic.",
        `Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. You sign in to Claude Code with your own Anthropic account on that computer, as you would on a desktop. Hivra does not say that it installs, manages or vets MCP servers for you: you add them yourself, with the commands above.`,
        "Two honest limits. A Hivra computer is managed, so you get less freedom than a VPS you root yourself, and Hivra administrators retain infrastructure access to managed hosts. And if you only use Claude Code at your desk, with servers that need your local files or a desktop session, running it on your own machine is simpler and costs nothing extra. Hivra earns its place when you want Claude Code to keep working while you are away.",
        "[Launch Claude Code on Hivra](/agents/claude-code) to try it, or read [Claude Code on Linux](/blog/claude-code-on-linux) if you would rather set up a server yourself.",
      ],
    },
    {
      heading: "A short setup you can copy",
      paragraphs: [
        "Putting it together, here is a reasonable first session. Add a remote server for your tracker, check it, sign in, then add a shared project server for the team:",
        "```bash\nclaude mcp add --transport http notion https://mcp.notion.com/mcp\nclaude mcp list\nclaude\n# inside Claude Code: run /mcp, pick notion, finish the browser sign-in,\n# then type /exit to return to your shell\nclaude mcp add --transport http --scope project sentry https://mcp.sentry.dev/mcp\nclaude\n# inside Claude Code: approve the project server, run /mcp, sign in to sentry,\n# check it shows as connected, then /exit\ngit add .mcp.json\n```",
        "The point is the order: add, list, sign in, and only then commit the shared file, so you know the server works before your teammates pull it.",
      ],
    },
  ],
  faqs: [
    {
      q: "What is MCP in Claude Code?",
      a: "MCP, the Model Context Protocol, is an open standard for connecting AI applications to outside tools and data. In Claude Code, an MCP server gives Claude extra tools, such as reading GitHub issues or querying a database. You add servers with claude mcp add and manage them with /mcp.",
    },
    {
      q: "How do I add an MCP server to Claude Code?",
      a: "For a remote server, run claude mcp add --transport http <name> <url>. For a local one, run claude mcp add <name> -- <command> [args...], with the double dash before the command. Then run /mcp inside Claude Code to check that it connected and to sign in if it needs OAuth.",
    },
    {
      q: "Where does Claude Code store MCP server settings?",
      a: "Local and user scope servers are stored in ~/.claude.json. Project scope servers are stored in a .mcp.json file at the project root, which you can commit to version control. Local is the default scope. If a name appears in several scopes, local beats project, and project beats user.",
    },
    {
      q: "How do I list or remove MCP servers in Claude Code?",
      a: "Run claude mcp list to see every server and its status, claude mcp get <name> for details, and claude mcp remove <name> to delete one. Removing a remote server also deletes its stored OAuth tokens. Inside a session, /mcp shows the same information and lets you disable a server without removing it.",
    },
    {
      q: "Why does my MCP server say it needs authentication?",
      a: "Remote servers that use OAuth need a sign-in after you add them. Run /mcp, choose the server and finish the browser flow, or run claude mcp login <name> from a shell. Tokens refresh automatically afterwards. Some Anthropic-hosted connectors, such as Gmail and Google Calendar, must be connected at claude.ai instead.",
    },
    {
      q: "Is it safe to use MCP servers with Claude Code?",
      a: "Only with servers you trust. Anthropic warns that servers which fetch external content can expose you to prompt injection. Prefer servers from the service's own maintainers, give them read-only or narrowly scoped access, keep tokens out of your repository, and read the approval prompt before accepting a project server.",
    },
    {
      q: "What does the MCP output token warning mean?",
      a: "Claude Code warns when one MCP tool returns more than 10,000 tokens, and caps output at 25,000 tokens by default. You can raise the cap by setting MAX_MCP_OUTPUT_TOKENS before starting claude, but asking the server for less data is usually the better fix.",
    },
    {
      q: "Can I keep MCP servers running when my laptop is closed?",
      a: "Only if Claude Code runs on a machine that stays on. A stdio server is a process on the same computer as Claude Code, so it stops when that computer sleeps. Run Claude Code on a VPS, or on a Hivra computer inside tmux, if you want the work to continue while you are away.",
    },
  ],
  relatedArticles: [
    { slug: "claude-code-dangerously-skip-permissions", title: "Claude Code's --dangerously-skip-permissions flag: what it skips and where to run it" },
    { slug: "keep-claude-code-running-24-7", title: "Will Claude keep running if you close your laptop or lock it? (And how to run Claude Code 24/7)" },
    { slug: "claude-code-remote-control", title: "Claude Code Remote Control: how it works and how to keep it online" },
    { slug: "claude-code-on-linux", title: "Claude Code on Linux: install, sign in, run it on a server and fix common errors" },
    { slug: "is-it-safe-to-leave-an-ai-agent-running-unattended", title: "Is it safe to leave an AI agent running unattended? The four risks that matter" },
  ],
  relatedComparisons: [{ slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" }],
};
