// The 13 posts production served from the retired private repo that the public
// repo did not have. They were ported for the cutover; losing any of them turns
// an indexed URL into a 404.
export const CUTOVER_BLOG_SLUGS = [
  "agent-zero-vs-openclaw-hosting",
  "ai-agent-dies-terminal-closes-fixes",
  "ai-agent-hosting-guide",
  "ai-agent-vps",
  "claude-code-vs-codex-24-7",
  "control-claude-code-from-telegram",
  "do-you-need-a-gpu-to-run-an-ai-agent",
  "is-it-safe-to-leave-an-ai-agent-running-unattended",
  "keep-claude-code-running-24-7",
  "managed-vs-self-hosted-ai-agents",
  "openclaw-broken-after-update",
  "run-ai-agents-24-7",
  "run-codex-24-7-in-the-cloud",
] as const;
