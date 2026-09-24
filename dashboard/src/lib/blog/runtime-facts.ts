/**
 * What keeps running on a Hivra agent's computer after you close the browser.
 *
 * The blog targets "run Claude Code / Codex 24/7" searches, so it must say
 * exactly which runs survive a closed laptop. Evidence, checked 2026-09-24:
 *
 * - The browser chat on a Claude Code or Codex box runs one CLI process per
 *   message and stops it when the browser disconnects
 *   (provisioner/hivra-chat/server.js, `res.on("close")` kills the child).
 * - The agent terminal tab runs claude or codex directly under ttyd
 *   (provisioner/hivra-agent-shell, no tmux), so closing the tab ends it.
 * - tmux is installed on the box, and the Box Terminal (bash) can start a tmux
 *   session that survives disconnects.
 * - The agent's Telegram tab connects the box's own bot; those runs execute on
 *   the box, not in the browser.
 * - Paid plans are not paused for inactivity; files, repos, logins and CLI
 *   session history stay on the computer.
 * - Hermes (cron, gateway), OpenClaw, Agent Zero and Aeon run their loops on
 *   the server and keep working without a browser.
 */

/** The one true sentence set about Claude Code and Codex runs on Hivra. */
export const CLI_RUN_LIFETIME =
  "On Hivra the computer stays on and keeps your files, sessions and login. A Claude Code or Codex run you start in the browser chat or the agent terminal stops when you close that tab. Runs you start inside tmux in the Box Terminal keep going after you close the laptop, and on a Claude Code box so do runs you send from its Telegram tab.";

/** Agents whose own loops run server-side on Hivra. */
export const SERVER_SIDE_AGENTS_KEEP_WORKING =
  "Hermes, OpenClaw, Agent Zero and Aeon run their loops on the server and keep working without a browser.";
