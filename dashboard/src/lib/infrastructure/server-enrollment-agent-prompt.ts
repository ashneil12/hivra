import type { ServerEnrollmentIssueResult } from "./server-enrollment-contracts";

type PromptInput = Pick<
  ServerEnrollmentIssueResult,
  "code" | "command" | "dryRunCommand" | "uninstallCommand" | "accountCode"
> & { expiresAt: string };

/** The panel's command, fed its code on stdin instead of at the prompt. The
 * prompt is a plain `read`, so a coding agent with no terminal can answer it
 * this way. The code is single use and short lived, so it reaching the agent's
 * command line is the trade the owner opts into by copying the prompt. */
function withCodeOnStdin(command: string, code: string): string {
  return `printf '%s\\n' '${code}' | ${command}`;
}

/** The real command, answered for a run with no terminal. The script asks its
 * questions on /dev/tty; with none it only goes ahead when `--yes` was passed,
 * so this variant exists only for an owner who tells the agent to run it. */
function unattended(command: string): string {
  return command.replace(/\| sudo bash$/, "| sudo bash -s -- --yes");
}

/** A prompt the owner pastes into their own coding agent (Claude Code, Codex
 * and the like) so it can connect a server with the panel's command. The agent
 * previews first, and the step that gives Hivra sudo stays the owner's call. */
export function serverEnrollmentAgentPrompt(issued: PromptInput): string {
  const expires = new Date(issued.expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    "Help me connect a Linux server I own to my Hivra account. Follow these steps exactly and don't improvise.",
    "",
    "Check first, and stop and tell me if any check fails:",
    "- Run everything below on the server itself. If you are on my laptop, run it over SSH on the server (ask me which one).",
    "- The server runs Ubuntu 22.04 or 24.04 on x86_64 (check with `lsb_release -ds; uname -m`). macOS, Windows, ARM and Proxmox VE are not supported by this command.",
    "- It has a public IPv4 address and accepts SSH from the internet.",
    "",
    "1. Preview. This changes nothing and needs no sudo:",
    `   ${withCodeOnStdin(issued.dryRunCommand, issued.code)}`,
    "   Show me what it reports.",
    "",
    "2. Connect. This creates a user named hivra that signs in only with Hivra's key and can use sudo, so Hivra gets administrator access to the server.",
    "   Show me the preview and ask me before going further. The best way is for me to run this in my own terminal on the server, so I answer its questions myself:",
    `   ${issued.command}`,
    `   It asks for the one-time code (${issued.code}) and shows an account code that must be ${issued.accountCode}.`,
    "   Only if I tell you to run it for me, run this instead. If sudo asks for a password, stop:",
    `   ${withCodeOnStdin(unattended(issued.command), issued.code)}`,
    `   Before you run it, check that the preview showed account code ${issued.accountCode}. If it didn't, stop.`,
    "",
    "3. Tell me the script's last lines. I then go back to Hivra, check the server's name and SSH key there, and choose Yes myself.",
    "",
    "Rules:",
    `- The one-time code works once and expires at ${expires}. If it is refused, expired or hits its download limit, stop and tell me to get a new command in Hivra. Don't retry in a loop.`,
    "- Never put the code or any key in another tool, chat, file, commit, issue or log.",
    "- Don't change SSH settings, firewalls or sudoers yourself; the script does what's needed.",
    `- To undo it later: ${issued.uninstallCommand}`,
  ].join("\n");
}
