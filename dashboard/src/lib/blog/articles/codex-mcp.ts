import { BlogArticle } from "../types";
import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "../plan-facts";
import { CLI_RUN_LIFETIME } from "../runtime-facts";

// Written 2026-11-26 for "codex mcp" (US 1,600 searches a month, KD 5). Hub page for adding MCP servers to the Codex CLI,
// plus the question of running Codex itself as an MCP server. Keeping a run alive stays in run-codex-24-7-in-the-cloud,
// installing in how-to-install-codex-cli, resuming in codex-resume-session. The Claude Code equivalent is claude-code-mcp.
// Primary sources, all fetched 2026-11-26 (OpenAI's docs now live on learn.chatgpt.com; developers.openai.com/codex/mcp
// redirects there):
// https://learn.chatgpt.com/docs/extend/mcp?surface=cli and https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli
//   (codex mcp add <name> --env ... -- <command>, the Context7 example, codex mcp list, codex mcp --help, codex mcp login
//   and --no-browser, --scopes, --oauth-client-id, --oauth-client-secret, --oauth-client-registration, /mcp in the TUI,
//   ~/.codex/config.toml and trusted-project .codex/config.toml, [mcp_servers.<name>] fields command/args/env/env_vars/cwd,
//   url/auth/bearer_token_env_var/http_headers/env_http_headers/http_headers_helper, startup_timeout_sec default 10,
//   tool_timeout_sec default 60, enabled, required, enabled_tools/disabled_tools, default_tools_approval_mode and its four
//   values, per-tool approval_mode and output_token_limit, the Figma and chrome_devtools TOML examples, desktop app steps,
//   shared configuration across the desktop app, CLI and IDE extension, OAuth secret saved in config.toml, callback
//   behaviour, plugin note)
// https://learn.chatgpt.com/docs/mcp-server.md (the codex mcp-server command and the standalone codex-mcp-server binary
//   have been removed; integrations must migrate; the Codex app server is the replacement, uses JSON-RPC not MCP, and is
//   experimental and not supported for production workloads; Codex still supports external MCP servers via codex mcp)
// https://learn.chatgpt.com/docs/developer-commands.md (/mcp "List configured MCP tools", add verbose for server details;
//   /exit and /quit exit the CLI; codex mcp "Manage MCP server entries stored in ~/.codex/config.toml")
// https://modelcontextprotocol.io/docs/getting-started/intro (what MCP is)
// https://github.com/openai/codex (README and docs/config.md only point to OpenAI's docs for configuration; the repo's own
//   docs pages for MCP no longer exist, so nothing is taken from there)
// Top-result research: the current ranking pages (OpenAI's MCP page, Context7 and mcp.so setup guides, Mintlify mirrors of
// the repo) were reviewed through search results only. Older third-party guides still describe codex mcp-server and
// experimental flags: we followed only OpenAI's current pages.
// Hivra facts: app/agents/content/codex.ts (official OpenAI Codex CLI on a cloud VM, Terminal tab, tmux advice),
//   lib/blog/runtime-facts.ts (CLI_RUN_LIFETIME), lib/blog/plan-facts.ts (price and size).
// Not claimed: codex mcp get / remove subcommands (OpenAI's pages do not list them, so we point to codex mcp --help),
//   exact IDE menu paths, the app-server protocol details, Telegram for Codex, that Hivra preinstalls, manages or vets MCP
//   servers, affiliation with OpenAI.

export const codexMcp: BlogArticle = {
  slug: "codex-mcp",
  title: "Codex MCP: how to add MCP servers to the Codex CLI",
  metaTitle: "Codex MCP: add MCP servers to the Codex CLI",
  metaDescription:
    "How to add MCP servers to OpenAI's Codex CLI with codex mcp add or config.toml, set timeouts and tool limits, and why codex mcp-server is gone.",
  publishedDate: "2026-11-26",
  lastModified: "2026-11-26",
  readingTimeMin: 10,
  author: "Hivra team",
  tagline: "One command or one TOML table per server, a few settings worth knowing, and a removed feature that older guides still mention.",
  intro:
    "Searches for Codex MCP mean one of two things: connecting MCP servers to the Codex CLI so it can use outside tools, or running Codex itself as an MCP server for other agents. This guide covers both, using only what OpenAI documents as of November 2026: the commands, the config file, sign-in, tool controls, its security notes, and what happened to codex mcp-server.",
  shortAnswer:
    "To add an MCP server to the Codex CLI, run `codex mcp add <name> -- <command>` for a local server, or add a `[mcp_servers.<name>]` table with a `url` to ~/.codex/config.toml for a remote one. Check it with `/mcp` inside Codex. As of November 2026, OpenAI has removed `codex mcp-server`.",
  sections: [
    {
      heading: "What MCP does in Codex",
      paragraphs: [
        "MCP, the Model Context Protocol, is an open standard for connecting AI applications to outside systems. The [MCP site](https://modelcontextprotocol.io/docs/getting-started/intro) compares it to a USB-C port: one standard way to plug an assistant into data, tools and workflows. A server defines the tools and handles requests, and a client such as Codex connects to it. OpenAI's [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describes the point in one line: it lets ChatGPT and Codex use tools and information from other systems, such as looking up a ticket or retrieving documentation.",
        "In practice that means Codex can read the library docs for the version you actually use, open a page in a browser it controls, or look at a design file, instead of guessing from memory. If you have not installed the CLI yet, start with our guide to [installing the Codex CLI](/blog/how-to-install-codex-cli). If you also use Anthropic's agent, the same ideas apply there, and we cover its commands in [Claude Code MCP](/blog/claude-code-mcp).",
        "Everything below works the same wherever Codex runs: your laptop, a VPS, or a [Codex computer on Hivra](/agents/codex) that stays on when your laptop is shut.",
      ],
    },
    {
      heading: "The two ways to add a server, at a glance",
      paragraphs: [
        "OpenAI's docs describe two kinds of server for the CLI. Both end up as an entry in the same file, so you can mix commands and hand-editing freely.",
        [
          "| Type | Where the server runs | How you add it | Use it when |",
          "|---|---|---|---|",
          "| STDIO | As a process on the same computer as Codex | `codex mcp add <name> -- <command>` or a `command` key in config.toml | The server is an npm package or a program you run locally |",
          "| Streamable HTTP | On the vendor's servers, reached by URL | `codex mcp add <name> --url <url>` or a `url` key in config.toml | The service offers a hosted MCP server |",
        ].join("\n"),
        "The settings live in `~/.codex/config.toml`. OpenAI's docs also say you can scope servers to a single project with a `.codex/config.toml` file in that project, but only for trusted projects. Each server is a table named `[mcp_servers.<server-name>]`. The ChatGPT desktop app, the Codex CLI and the IDE extension share this configuration for the same Codex host, so a server you set up once shows up in all of them.",
      ],
    },
    {
      heading: "Add a local STDIO server with codex mcp add",
      paragraphs: [
        "A STDIO server is a program Codex starts and talks to through its input and output. OpenAI gives the syntax as:",
        "```bash\ncodex mcp add <server-name> --env VAR1=VALUE1 --env VAR2=VALUE2 -- <stdio server-command>\n```",
        "The double dash separates Codex's own options from the command that starts the server, so everything after it is passed to the server untouched. Repeat `--env` for each variable the server needs. OpenAI's worked example adds Context7, a documentation server:",
        "```bash\ncodex mcp add context7 -- npx -y @upstash/context7-mcp\n```",
        "That one command writes a `[mcp_servers.context7]` table into `~/.codex/config.toml`. You can then open the file and see exactly what was stored, which is the quickest way to learn the format.",
        "To see what you have, run:",
        "```bash\ncodex mcp list\ncodex mcp --help\n```",
        "`codex mcp list` shows the servers Codex knows about, and `codex mcp --help` lists every subcommand your installed version supports, which is the reliable place to look for removing or inspecting a server because the docs page does not list those rows. OpenAI describes `codex mcp` as the command that manages the server entries stored in `~/.codex/config.toml`, so deleting a server by removing its table from that file is also a valid way to take it out.",
      ],
    },
    {
      heading: "Add a remote server over HTTP",
      paragraphs: [
        "For a hosted server there is nothing to install. Give it a name and a URL. OpenAI's docs show the form with an OAuth client ID:",
        "```bash\ncodex mcp add example --url https://mcp.example.com --oauth-client-id my-client\n```",
        "The `--oauth-client-id` option is for a pre-registered OAuth client. If you do not have one, you can leave it out and let Codex register itself, which is covered in the sign-in section below. The same server written directly in config.toml looks like this:",
        "```toml\n[mcp_servers.example]\nurl = \"https://mcp.example.com\"\n```",
        "If the server wants a token rather than a browser sign-in, point Codex at an environment variable that holds it, so the token is never written into the file. This is OpenAI's own Figma example:",
        "```toml\n[mcp_servers.figma]\nurl = \"https://mcp.figma.com/mcp\"\nbearer_token_env_var = \"FIGMA_OAUTH_TOKEN\"\nhttp_headers = { \"X-Figma-Region\" = \"us-east-1\" }\n```",
        "Codex sends the variable's value as a bearer token in the `Authorization` header. Set the variable in your shell before you start Codex, for example with `export FIGMA_OAUTH_TOKEN=...` in your shell profile. There are two other header options: `http_headers` for fixed values, and `env_http_headers`, which maps a header name to the name of an environment variable. A third, `http_headers_helper`, names a local command that prints a JSON object of headers, which suits tokens that expire.",
      ],
    },
    {
      heading: "Write servers in config.toml by hand",
      paragraphs: [
        "Everything the command does can be written in the file, and some settings can only be set there. The STDIO fields from OpenAI's docs are `command` (required), `args`, `env`, `env_vars` and `cwd`. This is the Context7 example from the docs:",
        "```toml\n[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\", \"@upstash/context7-mcp\"]\nenv_vars = [\"LOCAL_TOKEN\"]\n```",
        "Two fields look alike and differ. `env` sets variables with fixed values for the server process. `env_vars` lists variables to allow and forward from your own environment, so a secret stays in your shell instead of in the file. Entries in `env_vars` can be plain names, or objects with a `source` of `local` or `remote`.",
        "The Streamable HTTP fields are `url` (required), `auth`, `bearer_token_env_var`, `http_headers`, `env_http_headers` and `http_headers_helper`. The `auth` field defaults to `oauth`, which uses stored MCP OAuth credentials. The other value, `chatgpt`, uses your current ChatGPT session for the trusted first-party ChatGPT origin, and you will rarely need it for third-party servers.",
        "Here is a reference for the settings you will touch most:",
        [
          "| Setting | What it does | Default |",
          "|---|---|---|",
          "| `startup_timeout_sec` | How long Codex waits for the server to start | 10 seconds |",
          "| `tool_timeout_sec` | How long a single tool call may run | 60 seconds |",
          "| `enabled` | Set to `false` to switch a server off without deleting it | on |",
          "| `required` | Set to `true` to fail startup if the server is not ready | not stated in the docs |",
          "| `enabled_tools`, `disabled_tools` | Allow list and deny list of tools | all tools |",
          "| `default_tools_approval_mode` | When Codex asks before using a tool: `auto`, `prompt`, `writes` or `approve` | not stated in the docs |",
        ].join("\n"),
        "The docs list the four approval values but this guide does not claim which one applies when you set nothing, so set it explicitly for any server that can change things.",
      ],
    },
    {
      heading: "Timeouts, and what to do when a server is slow",
      paragraphs: [
        "Two timeouts matter. `startup_timeout_sec` defaults to 10 seconds, which is short for a server that downloads a package the first time it runs through `npx`. `tool_timeout_sec` defaults to 60 seconds, which a long query or a slow browser action can exceed. Raise either one per server, only where it is needed:",
        "```toml\n[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\", \"@upstash/context7-mcp\"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n```",
        "If a server that works when you run its command by hand fails inside Codex, a slow first start is the first thing to rule out, so raise `startup_timeout_sec` and try again. If you would rather Codex refuse to run without a server, set `required = true`, and it will fail at startup instead of carrying on without it. There is also a `startup_readiness` setting: `connection` (the default) requires a live connection at startup, while `catalog` lets a valid cached tool list satisfy startup, though tool calls still need a live connection.",
      ],
    },
    {
      heading: "Control which tools Codex can use",
      paragraphs: [
        "A server can expose many tools, including ones you never want an agent to call. OpenAI's docs give you three controls: an allow list, a deny list, and an approval mode. The deny list is applied after the allow list. This example from the docs shows the shape:",
        "```toml\n[mcp_servers.chrome_devtools]\nurl = \"http://localhost:3000/mcp\"\nenabled_tools = [\"open\", \"screenshot\"]\ndisabled_tools = [\"screenshot\"] # applied after enabled_tools\ndefault_tools_approval_mode = \"prompt\"\n```",
        "Here the server could use `open` and `screenshot`, but `screenshot` is then removed, leaving only `open`, and Codex prompts before using it by default. A subtable overrides one tool, here letting `open` run without a prompt:",
        "```toml\n[mcp_servers.chrome_devtools.tools.open]\napproval_mode = \"approve\"\noutput_token_limit = 30000\n```",
        "The approval modes, as OpenAI documents them, are `auto`, `prompt`, `writes` and `approve`. The `writes` mode prompts for tools that are not marked read-only. `output_token_limit` caps how much one tool can return, which helps when a server dumps a whole page or table into your context. A sensible starting point is the shortest allow list that does the job, with `writes` or `prompt` for anything that can change data.",
      ],
    },
    {
      heading: "Sign in to a server that uses OAuth",
      paragraphs: [
        "Many hosted servers use OAuth. After you add one, sign in from the shell:",
        "```bash\ncodex mcp login <server-name>\n```",
        "On a machine with no browser, such as a remote server, add `--no-browser`. Codex prints a URL, you open it on any device, and then paste the full redirect URL back into the terminal:",
        "```bash\ncodex mcp login <server-name> --no-browser\n```",
        "A few options from OpenAI's docs handle awkward providers. `--scopes read,write` overrides the scopes for that one login. If you set no scopes in either place, Codex uses the server's own `WWW-Authenticate` challenge. `--oauth-client-registration` takes `auto` (the default), `cimd` or `dcr` and applies only to that login, for example:",
        "```bash\ncodex mcp login <server-name> --oauth-client-registration cimd\n```",
        "CIMD and DCR are two ways a client can register with a server. If a provider gave you a client ID, set it and registration is skipped. For a confidential client, `--oauth-client-secret` reads the secret, ideally from an environment variable. The docs warn that Codex saves that secret in config.toml, so keep the file private and out of version control.",
        "`codex mcp logout <server-name>` signs out of an OAuth server, and inside Codex `/mcp login <server-name>` signs in.",
        "Callbacks default to `http://127.0.0.1/callback`. If a provider needs a fixed address, `mcp_oauth_callback_url` and `mcp_oauth_callback_port` set it.",
      ],
    },
    {
      heading: "Check your servers inside Codex with /mcp",
      paragraphs: [
        "Once Codex is running, type this in its prompt:",
        "```text\n/mcp\n```",
        "OpenAI's command reference describes it as listing the MCP tools Codex can call during the session, and adding `verbose` shows server details. If a server you added is missing, check the config file and start a fresh Codex session. To get back to your shell afterwards, type `/exit` or `/quit`, which both leave the CLI.",
        "The Codex desktop app has the same thing under Settings, MCP servers, Add server; select Restart after saving, and Authenticate for OAuth servers.",
      ],
    },
    {
      heading: "Can you run Codex as an MCP server?",
      paragraphs: [
        "For a while the answer was yes. Older guides, blog posts and cookbook examples show a `codex mcp-server` command, which exposed Codex as a set of MCP tools so that another agent or the Agents SDK could drive it. That is the second thing people mean by \"codex mcp\".",
        "As of November 2026, OpenAI's documentation says that command and the standalone `codex-mcp-server` binary have been removed. It says the earlier tool reference and the Agents SDK examples are no longer supported, and that any integration which launches either one has to migrate before upgrading Codex. The removal only affects hosting Codex as a server: Codex still connects to external MCP servers and you still manage them with `codex mcp`.",
        "The replacement OpenAI points to is the Codex app server. It supports sign-in, conversation history, approvals and streamed agent events, but it speaks its own JSON-RPC protocol and is not an MCP server, so it is not a drop-in swap for an MCP client. OpenAI also says the app-server command is experimental and not supported for production workloads. If you maintain something that calls `codex mcp-server`, read OpenAI's [notice on the removal](https://learn.chatgpt.com/docs/mcp-server.md) and plan the migration. If you are following an older tutorial that uses it, expect it to fail on a current version of Codex.",
      ],
    },
    {
      heading: "Security: only add servers you trust",
      paragraphs: [
        "The prompt-injection point below is general MCP guidance, not from OpenAI's page. An MCP server is code that runs with your permissions, or a service that can feed text into your session. A STDIO server is a program on your computer, started by Codex, so installing an unknown package is the same as running it. A server that fetches external content, such as web pages, issues or documents, can also carry prompt injection: text written to look like instructions that the model might follow. An agent that can run commands as well as read untrusted text is the risky pairing.",
        "- **Prefer servers from the service's own maintainers.** Check the package name, because look-alike names are an old trick.\n- **Give each server the least access that works.** Use a narrowly scoped or read-only token, and a read-only database user.\n- **Keep secrets out of config files you commit.** Use `bearer_token_env_var` or `env_vars` instead of pasting a token. The OAuth client secret is the exception: Codex stores it in config.toml, so keep that file private.\n- **Trim the tool list.** Use `enabled_tools` and `disabled_tools`, and set an approval mode for anything that writes.\n- **Be careful with project config.** A project `.codex/config.toml` only applies to trusted projects. Do not mark a repository as trusted just because someone sent it to you, because a project config can define servers that start programs on your computer.\n- **Know what you grant.** OpenAI notes that access to records depends on the server's API connection, so what you grant when you connect the server is what the agent can reach.",
        "Our guide on [leaving an agent running unattended](/blog/is-it-safe-to-leave-an-ai-agent-running-unattended) covers the wider risks of long autonomous runs.",
      ],
    },
    {
      heading: "Where your MCP servers run: laptop, VPS or a Hivra computer",
      paragraphs: [
        "A STDIO MCP server is a process on whatever computer Codex runs on, and its sign-ins and config file live there too. If Codex runs on your laptop, a browser server or database tool stops when the lid closes, and so does the work Codex was doing with it.",
        "Hivra runs the official OpenAI Codex CLI on a cloud computer, and you open its terminal and files in a browser from any device. The Terminal tab is a plain shell, so you add servers there with the same commands. A local server started with `npx` needs Node.js on that computer. The computer stays available when yours does not, and experiments and commands run there instead of on the machine where you keep personal files, so a server you add can reach the computer's files rather than your laptop's. The computer still holds whatever code and credentials you put on it.",
        CLI_RUN_LIFETIME,
        "The bigger point is that you are not locked into one agent. The same Hivra account launches agents including Hermes, OpenClaw, Claude Code, Codex and Agent Zero, and you reach them from a browser on any device. MCP is an open standard, so the server habits you build with Codex carry over if you want to compare it with Claude Code. [Run Codex on Hivra](/agents/codex) to try it. Hivra is not affiliated with OpenAI.",
        `Plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. You sign in to Codex with your own ChatGPT account or an OpenAI API key, subject to OpenAI's terms. You add and manage MCP servers yourself, with the commands above.`,
        "Two honest limits. A Hivra computer is managed, so you get less freedom than a VPS you root yourself, and Hivra administrators retain infrastructure access to managed hosts. And if you only use Codex at your desk, with servers that need your local files or a desktop session, running it on your own machine is simpler. Hivra earns its place when you want Codex to keep working while you are away. For the choice between OpenAI's own cloud and a computer that stays on, see [Codex cloud or Codex on a computer that stays on](/blog/run-codex-24-7-in-the-cloud).",
      ],
    },
  ],
  faqs: [
    {
      q: "How do I add an MCP server to the Codex CLI?",
      a: "For a local server, run codex mcp add <name> -- <command>, for example codex mcp add context7 -- npx -y @upstash/context7-mcp. For a hosted one, run codex mcp add <name> --url <url>. Then type /mcp in Codex to check it is listed, and run codex mcp login <name> if it needs OAuth.",
    },
    {
      q: "Does codex mcp-server still work?",
      a: "No. As of November 2026, OpenAI's docs say the codex mcp-server command and the standalone codex-mcp-server binary have been removed, along with the old tool reference and Agents SDK examples. OpenAI points to the Codex app server instead, which uses its own JSON-RPC protocol and is experimental.",
    },
    {
      q: "How do I change the MCP timeout in Codex?",
      a: "Set startup_timeout_sec and tool_timeout_sec in the server's table in config.toml. OpenAI documents defaults of 10 seconds to start and 60 seconds per tool call. Raise them only for the server that needs it, for example a slow npx start or a long-running tool.",
    },
    {
      q: "How do I stop Codex using certain MCP tools?",
      a: "Use enabled_tools as an allow list and disabled_tools as a deny list, which is applied after the allow list. You can also set default_tools_approval_mode to auto, prompt, writes or approve, and override it for a single tool under tools.<tool>.approval_mode.",
    },
    {
      q: "How do I log in to an MCP server that needs OAuth?",
      a: "Run codex mcp login <server-name>. On a machine without a browser, add --no-browser, open the printed URL on another device and paste the full redirect URL back into the terminal. The --scopes option overrides scopes for one login, and a configured client ID skips registration.",
    },
    {
      q: "Is it safe to use MCP servers with Codex?",
      a: "Only with servers you trust. A local server runs on your computer, and servers that fetch outside content can carry prompt injection. Prefer the service's own servers, use narrow tokens, trim the tool list, set approval modes for writes, and keep config.toml private because it can hold an OAuth client secret.",
    },
    {
      q: "Can Codex keep using MCP servers when my laptop is closed?",
      a: "Only if Codex runs on a machine that stays on. A STDIO server is a process on the same computer as Codex, so it stops when that computer sleeps. Run Codex on a VPS, or on a Hivra computer inside tmux, if you want the work to continue while you are away.",
    },
  ],
  relatedArticles: [
    { slug: "how-to-install-codex-cli", title: "How to install the Codex CLI on Mac, Linux and Windows" },
    { slug: "run-codex-24-7-in-the-cloud", title: "Codex cloud, or Codex on a computer that stays on? Where to run it 24/7" },
    { slug: "codex-resume-session", title: "How to resume a Codex session (and Claude Code too)" },
    { slug: "claude-code-vs-codex-24-7", title: "Claude Code vs Codex for 24/7 autonomous work: which should you host?" },
    { slug: "is-it-safe-to-leave-an-ai-agent-running-unattended", title: "Is it safe to leave an AI agent running unattended? The four risks that matter" },
  ],
  relatedComparisons: [{ slug: "vs-self-hosted", title: "Hivra vs self-hosted VPS" }],
};
