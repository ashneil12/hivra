"use client";

import { z } from "zod";
import { AgentDeploymentDestinationSchema } from "./agent-placement";
import { ModelKeySelectionSchema } from "./model-key-selection";

const Uuid = z.string().uuid();
const Selection = z.discriminatedUnion("mode", [
  z.object({ provider: z.literal("venice"), mode: z.literal("byok"), model: z.string() }).strict(),
  z.object({ provider: z.literal("venice"), mode: z.literal("managed"), model: z.string(), walletType: z.enum(["card", "hermesos"]) }).strict(),
]);
const LaunchIntentSchema = z.object({
  type: z.literal("codex"), name: z.string().trim().min(1).max(100),
  cpu: z.number().positive(), ram: z.number().positive(), browser: z.boolean(),
  deployment: AgentDeploymentDestinationSchema, llm: Selection,
}).strict();
export type ModelLaunchIntent = z.infer<typeof LaunchIntentSchema>;
export const SavedModelLaunchSchema = z.object({ requestId: Uuid, intent: LaunchIntentSchema }).strict();
export type SavedModelLaunch = z.infer<typeof SavedModelLaunchSchema>;
// Only the fields needed to open the original computer cross this client
// boundary. Unknown response fields (including credentials) are discarded.
const Agent = z.object({ id: Uuid, type: z.literal("codex"), name: z.string(),
  status: z.enum(["provisioning", "running", "stopped", "error", "deleted"]),
  cpu: z.number().positive(), ram: z.number().positive() });
const Result = z.object({ launchRequestId: Uuid, agent: Agent });
export type ModelLaunchAgent = z.infer<typeof Agent>;
type Options = { signal?: AbortSignal };
const UNCONFIRMED = "Launch could not be confirmed. Check the saved request before retrying; an interrupted response does not mean the computer was not created.";

export class AgentLaunchError extends Error {}

async function request(requestId: string, body: unknown | undefined, options: Options = {}) {
  if (!Uuid.safeParse(requestId).success) throw new AgentLaunchError("The saved launch ID is invalid. No request was sent.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, body === undefined ? 20_000 : 190_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const response = await fetch(body === undefined ? `/api/hivra/agent-launches/${encodeURIComponent(requestId)}` : "/api/hivra/agents", {
      method: body === undefined ? "GET" : "POST", cache: "no-store", redirect: "error", credentials: "same-origin",
      signal: controller.signal,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (body === undefined && response.status === 404) return null;
    const json = await response.json().catch(() => null);
    // Never echo a server/transport error that might contain the submitted key.
    if (response.status === 401) throw new AgentLaunchError("Sign in to the same account to check your saved launch.");
    if (response.status === 409) throw new AgentLaunchError("This launch needs attention. Check the saved request to open the original computer before making another change.");
    if (!response.ok || json?.success !== true) throw new AgentLaunchError(UNCONFIRMED);
    const parsed = Result.safeParse(json.data);
    if (!parsed.success || parsed.data.launchRequestId !== requestId) throw new AgentLaunchError(UNCONFIRMED);
    return parsed.data.agent;
  } catch (error) {
    if (error instanceof AgentLaunchError) throw error;
    throw new AgentLaunchError(UNCONFIRMED);
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort); controller.abort();
  }
}

/** A null lookup means unconfirmed, NOT permission to discard the request ID.
 * An earlier POST may still be in flight and reserve its computer later. */
export const findAgentModelLaunch = (requestId: string, options?: Options) => request(requestId, undefined, options);

export async function createAgentModelLaunch(saved: SavedModelLaunch, apiKey: string, options?: Options): Promise<ModelLaunchAgent> {
  const parsed = SavedModelLaunchSchema.safeParse(saved);
  if (!parsed.success) throw new AgentLaunchError("Review your launch choices. No request was sent.");
  const intent = parsed.data.intent;
  const selection = ModelKeySelectionSchema.safeParse(intent.llm.mode === "byok" ? { ...intent.llm, apiKey } : intent.llm);
  if (!selection.success || !selection.data) throw new AgentLaunchError("Enter a valid Venice API key and model. No request was sent.");
  const agent = await request(saved.requestId, { ...intent, llm: selection.data, launchRequestId: saved.requestId }, options);
  if (!agent) throw new AgentLaunchError(UNCONFIRMED);
  return agent;
}
