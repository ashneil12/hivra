// Browser client for /api/hivra/agents/[id]/computer-contract. Every response
// is parsed against the status union; anything else is an error, never a
// guessed state.

import { z } from "zod";

import type { ComputerContractStatus } from "@/lib/agent-computers/computer-contract-status";
import { COMPUTER_CONTRACT_CHANNELS } from "@/lib/agent-computers/computer-contract-input";

const Channel = z.enum(COMPUTER_CONTRACT_CHANNELS);
const Timestamp = z.string().nullable();

const StatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_applicable"), reason: z.enum(["computer", "own_instructions"]) }),
  z.object({ kind: z.literal("unavailable") }),
  z.object({ kind: z.literal("not_started"), channel: Channel }),
  z.object({
    kind: z.literal("tracked"),
    channel: Channel,
    revision: z.number().int().positive(),
    content: z.string(),
    state: z.enum(["pending", "delivered", "sent", "conflict"]),
    deliveredAt: Timestamp,
    checkedAt: Timestamp,
    lastAttemptAt: Timestamp,
    lastError: z.string().nullable(),
    lastDelivered: z.object({ revision: z.number().int().positive(), deliveredAt: z.string() }).nullable(),
    appliesTo: z.literal("new-chats"),
  }),
]) satisfies z.ZodType<ComputerContractStatus>;

export type ComputerContractAction = "deliver" | "check" | "restore" | "send";

async function parse(response: Response): Promise<ComputerContractStatus> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Fall through to the error below.
  }
  if (!response.ok) {
    const message = (body as { error?: unknown } | null)?.error;
    throw new Error(typeof message === "string" && message ? message : "Couldn't reach Hivra. Nothing changed.");
  }
  const parsed = StatusSchema.safeParse((body as { data?: { contract?: unknown } } | null)?.data?.contract);
  if (!parsed.success) throw new Error("Hivra sent an answer this page doesn't understand. Nothing changed.");
  return parsed.data;
}

export async function fetchComputerContract(agentId: string, signal?: AbortSignal): Promise<ComputerContractStatus> {
  return parse(await fetch(`/api/hivra/agents/${encodeURIComponent(agentId)}/computer-contract`, {
    cache: "no-store", credentials: "same-origin", signal,
  }));
}

export async function runComputerContractAction(agentId: string, action: ComputerContractAction): Promise<ComputerContractStatus> {
  return parse(await fetch(`/api/hivra/agents/${encodeURIComponent(agentId)}/computer-contract`, {
    method: "POST", cache: "no-store", credentials: "same-origin",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
  }));
}
