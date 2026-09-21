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
