/**
 * What keeps running on a Hivra agent's computer after you close the browser.
 *
 * The blog, /agents and /tools target "run Claude Code / Codex 24/7" searches,
 * so they must only say what is true on EVERY customer computer. Evidence,
 * checked 2026-09-24:
 *
 * - Provisioner 2026.09.24.1 (PR #98) runs browser chat turns detached
 *   (provisioner/hivra-chat/chat-runs.cjs, POST /api/chat with `detach`) and
 *   runs the agent's own session tab inside tmux (provisioner/hivra-agent-shell).
 *   On a computer with that update, a chat or session-tab run outlives a closed
 *   tab. Computers provisioned earlier keep the old behaviour, where both end
 *   with the tab, until an owner-approved runtime rollout reaches them. So copy
 *   makes NEITHER claim about browser chat or session-tab runs.
 * - tmux has been installed on every Claude Code and Codex computer since the
 *   first release (provision-claude-code-box.sh), and the Terminal tab under
 *   Computer is a plain shell. A run started inside tmux there outlives the tab
 *   on old and updated computers alike.
 * - A Claude Code agent's Telegram tab (under Manage) connects the owner's bot
 *   to the computer's bux-tg service; those runs execute on the computer, not in
 *   the browser. Telegram is only verified for Claude Code, never promised for
 *   Codex.
 * - Paid plans are not paused for inactivity; files, repos, logins and CLI
 *   session history stay on the computer.
 * - Hermes, OpenClaw and Agent Zero run on the computer itself. Aeon's scheduled
 *   tasks run on the owner's own GitHub Actions; the computer hosts its
 *   dashboard. None of them needs an open browser.
 *
 * Tab names come from agentSurfaceLabel / agentSurfaceGroups
 * (lib/agent-computers/agent-surfaces.ts): Chat · Computer (Terminal, Files,
 * Browser, Git) · Manage (Manage, Skills, Tasks, Telegram).
 */

import { AGENT_SURFACE_IDS, agentSurfaceGroups, agentSurfaceLabel } from "@/lib/agent-computers/agent-surfaces";

/** The one true sentence set about Claude Code and Codex runs on Hivra. */
export const CLI_RUN_LIFETIME =
  "On a paid Hivra plan the computer stays on and keeps your files, sessions and login. A Claude Code or Codex run you start inside tmux in the computer's Terminal tab keeps going after you close the laptop. On Claude Code, work you send through Telegram, connected in the agent's Telegram tab, runs on the computer, not in your browser.";

/** Where the other agents' work runs on Hivra. */
export const SERVER_SIDE_AGENTS_KEEP_WORKING =
  "Hermes, OpenClaw and Agent Zero run on the computer itself, and Aeon's scheduled tasks run on your own GitHub Actions while the computer hosts its dashboard. None of them needs an open browser.";

/**
 * Keep-running claims no public copy may make. The blog, /agents and /tools
 * scanners all read this list, so the three surfaces cannot disagree.
 */
export const CLI_RUN_FALSE_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp; reason: string }> = [
  {
    label: "retired survives-anything claim",
    pattern: /no SIGHUP|no tmux (?:required|needed)|survives? (?:laptop|lid) (?:sleep|close)|close your laptop\. it keeps/i,
    reason: "Only a run inside tmux, or a Claude Code run sent through Telegram, is certain to keep going after the laptop closes.",
  },
  {
    label: "tab-close stop claim",
    pattern:
      /(?<!(?:n't|not|never) )\b(?:stops?|ends?|dies|die|killed)\b(?: (?:running|working|their run|its run|the run))? (?:when|once|as soon as|if) (?:you close (?:the|that|this|its|your|a) (?:browser )?tab|(?:the|that|this|its|your|a) (?:browser )?tab (?:closes|is closed|disconnects))\b|\bstops? with (?:its|the|that|your) tab\b|\bclosing (?:the|that|this|a) (?:browser )?tab (?:ends|stops|kills)\b|\blasts? only as long as (?:the|that|this|its) tab\b|\bclose (?:the|that) tab\b[^.!?]*\brun (?:stops|ends|dies)\b/i,
    reason: "Computers with the 2026.09.24.1 runtime keep a browser chat or session-tab run going after the tab closes, so saying it stops is false there.",
  },
  {
    label: "browser-run keeps-going claim",
    pattern:
      /\b(?:browser chat|chat tab|agent terminal|(?:Claude Code|Codex) (?:session tab|Terminal))\b[^.!?;]*\b(?:keeps?|kept) (?:going|working|running)\b|\b(?:keeps?|kept) (?:going|working|running)\b[^.!?;]*\b(?:browser chat|chat tab|agent terminal)\b/i,
    reason: "Computers provisioned before the 2026.09.24.1 runtime still end a browser chat or session-tab run when the tab closes, so promising it keeps going is false there.",
  },
];

/** Every false keep-running claim in a piece of copy, as "label: match". */
export function falseCliRunClaims(text: string): string[] {
  return CLI_RUN_FALSE_CLAIMS.flatMap(({ label, pattern }) => {
    const match = pattern.exec(text);
    return match ? [`${label}: ${match[0]}`] : [];
  });
}

/**
 * "<Name> tab" and "tab under <Group>" names in copy that a Claude Code or
 * Codex agent page does not show. Copy that tells people where to click must
 * use the dashboard's own labels, so a renamed tab fails the copy tests.
 */
export function unknownDashboardNames(text: string): string[] {
  const tabs = new Set(["Claude Code", "Codex"].flatMap((name) => AGENT_SURFACE_IDS.map((id) => agentSurfaceLabel(id, { name }))));
  const groups = new Set(agentSurfaceGroups(AGENT_SURFACE_IDS).map((group) => group.label));
  const unknown: string[] = [];
  for (const [, raw] of text.matchAll(/\b([A-Z]\w*(?: [A-Z]\w*)*(?: session)?) tab\b/g)) {
    const name = raw.replace(/^(?:A|An|The|On|In|Its) /, "");
    if (!tabs.has(name)) unknown.push(`${name} tab`);
  }
  for (const [, group] of text.matchAll(/\btabs?,? under ([A-Z]\w*)/g)) {
    if (!groups.has(group)) unknown.push(`under ${group}`);
  }
  return unknown;
}
