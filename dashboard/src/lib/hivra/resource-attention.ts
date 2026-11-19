/** Display only: retain no command text or credentials from approval prompts. */
export type ResourceAttention = "approval" | "clarify" | "error";

export function resourceAttention(status: string, pendingPrompt?: unknown): ResourceAttention | null {
  if (status === "error" || status === "failed") return "error";
  if (!pendingPrompt || typeof pendingPrompt !== "object") return null;
  const prompt = pendingPrompt as Record<string, unknown>;
  if (typeof prompt.promptId !== "string" || !prompt.promptId) return null;
  if (prompt.expiresAt != null) {
    const expiry = typeof prompt.expiresAt === "string" ? Date.parse(prompt.expiresAt) : NaN;
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
  }
  return prompt.kind === "approval" || prompt.kind === "clarify" ? prompt.kind : null;
}

export function attentionLabel(attention: ResourceAttention): string {
  return attention === "approval" ? "Needs approval" : attention === "clarify" ? "Needs your input" : "Needs attention";
}

/**
 * The one rule for "needs the owner": the sidebar badge, the phone More sheet
 * and the Needs your attention page all count rows through it, so the number
 * and the list cannot disagree. Error and failed statuses already read as
 * "error" in `attention`.
 */
export function needsOwnerAttention(row: { attention?: ResourceAttention | null }): boolean {
  return Boolean(row.attention);
}

/** Plain words for what is wrong when a row has no stored reason of its own. */
export function attentionFallbackReason(attention: ResourceAttention | null | undefined): string {
  if (attention === "approval") return "It is waiting for you to approve something.";
  if (attention === "clarify") return "It is waiting for your answer.";
  return "Something went wrong and it stopped working.";
}
