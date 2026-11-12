/** Shared by the server and Needs you: one approval or question an agent is waiting on. */
export const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

/** What Needs you shows for one waiting prompt. Text is already redacted on the computer. */
export interface InboxPrompt {
  promptId: string;
  kind: "approval" | "clarify";
  summary: string | null;
  command: string | null;
  /** False when the command was too long to show in full: then it may only be refused here. */
  commandComplete: boolean;
  choices: ApprovalChoice[];
  createdAt: string;
  expiresAt: string;
  /** Whether Hivra can send the answer back (approvals); questions are answered in the chat. */
  answerable: boolean;
  /** Set once the owner answered and Hermes has not confirmed yet. */
  answeredChoice: ApprovalChoice | null;
}
