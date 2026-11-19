// The body of /setup.md: instructions an AI coding agent (Claude Code, Codex,
// Cursor, Gemini CLI...) follows when its person says "set me up on Hivra".
// Pure string output so it is unit-testable. `origin` is the site serving it,
// so Canary's copy points at Canary. `handshake` adds the link-and-code flow
// (HIVRA_AGENT_SETUP_HANDSHAKE); without it the plain Launch link is the flow.

import { HOSTED_COMPUTE_NEEDS_PLAN, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import {
  SETUP_AGENT_IDS,
  SETUP_AGENT_LINES,
  SETUP_LAUNCH_MINUTES,
  SETUP_OPEN_MINUTES,
  SETUP_POLL_SECONDS,
  SETUP_TOKEN_HEADER,
  setupAgentName,
  setupLaunchPath,
} from "./core";

/** The one line a person pastes into their coding agent. */
export function setupPrompt(origin: string): string {
  return `Set me up on Hivra so I have an AI agent running in the cloud. Read ${origin}/setup.md and follow it.`;
}

export function buildSetupMarkdown({ origin, handshake }: { origin: string; handshake: boolean }): string {
  const agentRows = SETUP_AGENT_IDS.map((id) => `| \`${id}\` | ${setupAgentName(id)} | ${SETUP_AGENT_LINES[id]} |`).join("\n");
  const exampleLink = `${origin}${setupLaunchPath("claude-code", "venice")}`;

  const linkFlow = `Build the Launch link for what your person chose and give it to them:

\`\`\`
${origin}/dashboard/launch?agent=<agent id>&inference=venice&ref=agent-setup
\`\`\`

For example, Claude Code on Hivra credits: ${exampleLink}

- \`inference=venice\` uses Hivra credits for the model, with nothing to set up. Use \`inference=venice-key\` if they want to paste their own Venice API key, or leave \`inference\` out to let them choose on the page (for example their own Anthropic or OpenAI key, or a Claude or ChatGPT sign-in).
- Open the link in their browser if you can (\`open <url>\` on macOS, \`xdg-open <url>\` on Linux, \`start <url>\` on Windows). Otherwise print it and ask them to open it.
- Tell them: sign in or create an account, check the choices, press Launch. Setup takes a few minutes and the agent's page shows progress. Their agent then appears under Agents at ${origin}/dashboard/agents.`;

  const handshakeFlow = `### 2a. Start a setup request

\`\`\`bash
curl -sS -X POST ${origin}/api/agent-setup \\
  -H 'Content-Type: application/json' \\
  -d '{"agent":"claude-code","inference":"venice","client":"Claude Code"}'
\`\`\`

All fields are optional. \`agent\` is an id from the table above, \`inference\` is \`venice\` (Hivra credits, nothing to set up) or \`venice-key\` (their own Venice key) and needs \`agent\`, and \`client\` is your own name as the person knows you. Leave \`inference\` out to let them choose on the page. The answer looks like:

\`\`\`json
{"success":true,"data":{"id":"…","code":"ABCD-EFGH","approveUrl":"${origin}/dashboard/agent-setup/ABCDEFGH","pollUrl":"${origin}/api/agent-setup/…","pollHeader":"${SETUP_TOKEN_HEADER}","pollSecret":"…","pollEverySeconds":${SETUP_POLL_SECONDS},"expiresAt":"…"}}
\`\`\`

Keep \`pollSecret\` to yourself: do not print it, write it to a file in their project or put it in a commit.

### 2b. Hand the link and code to your person

Open \`approveUrl\` in their browser if you can (\`open\`, \`xdg-open\` or \`start\`), and print it too. Show them the \`code\` and tell them: sign in or create an account, check the code on the page matches, press Continue to Launch, then press Launch. The link works for ${SETUP_OPEN_MINUTES} minutes.

### 2c. Wait for the agent

Poll every ${SETUP_POLL_SECONDS} seconds (not faster):

\`\`\`bash
curl -sS <pollUrl> -H '${SETUP_TOKEN_HEADER}: <pollSecret>'
\`\`\`

\`data.status\` is one of:

| status | what it means | what to do |
| --- | --- | --- |
| \`waiting_for_person\` | They haven't opened the link yet | Keep polling. After a few minutes, remind them once. |
| \`waiting_for_launch\` | They opened it and are choosing | Keep polling. They have ${SETUP_LAUNCH_MINUTES} minutes to press Launch. |
| \`starting\` | The agent is being set up on its computer | Keep polling. This usually takes a few minutes. |
| \`ready\` | The agent is running | Stop. Give them \`data.agent.url\` and go to step 3. |
| \`failed\` | The agent did not start | Stop. Give them \`data.agent.url\`; its page says why and has Try again. |
| \`expired\` | The link timed out or nothing was launched | Stop. Offer to start a new setup request. |

\`data.message\` is a one-line explanation you can pass on as it is. If a request fails (a 5xx, or no answer), wait and poll again. If starting a setup request fails, fall back to the plain Launch link below.

### Plain Launch link (fallback)

${linkFlow}`;

  return `# Set up Hivra from your coding agent

> Instructions for AI coding agents (Claude Code, Codex, Cursor, Gemini CLI and others). Your person asked you to set them up on Hivra. Follow these steps. Prompt they paste: "${setupPrompt(origin)}"

Hivra gives an AI agent a cloud computer of its own, so it keeps running when their laptop is closed. They chat with it in the browser, and it can browse, run code and run scheduled jobs.

## Ground rules

- A person signs in and presses Launch. You cannot do that for them: never create accounts, never ask for their password, never try to pay.
- ${HOSTED_COMPUTE_NEEDS_PLAN} There is a ${MONEY_BACK_GUARANTEE}. Say this before you send them to Launch, so it is not a surprise.
- API keys go into Hivra's own page, never into this chat, a file or a commit.
- Ask before you push code anywhere.

## 1. Pick the agent

If they already said which agent they want, use it. If they asked you to move yourself or your current work to the cloud, pick your own kind (Claude Code → \`claude-code\`, Codex → \`codex\`). Otherwise ask one short question, with \`hermes\` as the default.

| id | agent | good for |
| --- | --- | --- |
${agentRows}

More agents, and what each one suits: ${origin}/agents

## 2. Send them to Launch

${handshake ? handshakeFlow : linkFlow}

## 3. Carry your work over (only if they want it)

If they want the cloud agent to pick up what you are working on now:

1. Ask before pushing. Then commit and push your work to a branch on GitHub (or another git host they use).
2. Write a short handoff note: the repository URL and branch, what is done, what is next, how to run it and its tests, and anything they decided. Leave out every secret and key.
3. Tell them to paste the note as their first message in the new agent's chat. To let the agent push to GitHub, they can connect GitHub from the agent's page.

## 4. Finish

Tell them in two or three sentences what you set up, the link to open it, and that it keeps running in the cloud. Managing it (model, updates, sleep, deleting it) is on the agent's page under Manage.

## Help

- Agents: ${origin}/agents
- Pricing: ${origin}/pricing
- Everything else: ${origin}/llms.txt
`;
}
