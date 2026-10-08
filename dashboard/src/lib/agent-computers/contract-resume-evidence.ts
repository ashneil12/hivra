// Whether a resumed chat reads the Computer Contract again (design 4.6, 5.4).
// Manage says "applies from its next message" only for a runtime and pinned
// version that spike S3 proved reloads the instructions file on every resumed
// turn; everything else says "applies to new chats". The flag is pinned here
// with its evidence, never taken from anything a computer reports. Client-safe.

export type ContractAppliesTo = "next-message" | "new-chats";

interface ResumeEvidence {
  runtime: "codex";
  version: string;
  /** Where the evidence holds: an attached agent resumes with `exec -C <starting folder> resume`. */
  surface: "attached";
  evidence: string;
}

/**
 * Spike S3, 2026-09-24, on disposable Hetzner VMs (Ubuntu 22.04 kernel 5.15 and
 * 24.04 kernel 6.8, real systemd), Codex 0.149.1 inside unit v2 with a stub
 * model endpoint: every resumed turn's request carried the current AGENTS.md of
 * the starting folder (a re-render between turns arrived on the next turn, the
 * earlier revision stayed in the replayed history), the working folder came
 * from `-C` before `resume`, and rewriting the session file's recorded folder
 * or planting ~/AGENTS.md changed neither.
 */
export const RESUME_RELOAD_EVIDENCE: readonly ResumeEvidence[] = Object.freeze([
  Object.freeze({ runtime: "codex", version: "0.149.1", surface: "attached",
    evidence: "docs/superpowers/specs/2026-09-24-agent-computer-contract-and-attach.md, spike S3 results" } as const),
]);

/** The pinned Codex every attached agent is installed with (stage-attached-codex.py). */
export const ATTACHED_CODEX_VERSION = "0.149.1";

export function contractAppliesTo(input: { runtime: string; version: string | null; surface: "attached" | "own-computer" }): ContractAppliesTo {
  return RESUME_RELOAD_EVIDENCE.some((row) => row.runtime === input.runtime && row.version === input.version && row.surface === input.surface)
    ? "next-message" : "new-chats";
}

export function contractAppliesToLabel(value: ContractAppliesTo): string {
  return value === "next-message" ? "applies from its next message" : "applies to new chats";
}
