"use client";

import { z } from "zod";
import type { AgentLlmInput } from "./agent-api";

const Summary = z.object({ provider: z.literal("venice"), mode: z.enum(["byok", "managed"]),
  model: z.string().nullable(), keyPrefix: z.string().nullable(), walletType: z.enum(["card", "hermesos"]).nullable(),
  enabledAt: z.string() }).strict().nullable();
const Launch = z.object({ requestId: z.string().uuid(), operationId: z.string().uuid(), createdAt: z.string(),
  state: z.enum(["waiting_for_computer", "ready_to_apply", "setup_requested", "needs_attention"]),
  requested: z.discriminatedUnion("mode", [
    z.object({ provider: z.literal("venice"), mode: z.literal("byok"), model: z.string() }).strict(),
    z.object({ provider: z.literal("venice"), mode: z.literal("managed"), model: z.string(), walletType: z.enum(["card", "hermesos"]) }).strict(),
  ]),
}).strict();
const Settings = z.object({ llm: Summary, pending: z.object({ operationId: z.string().uuid(), requested: Summary,
  createdAt: z.string(), applying: z.boolean() }).strict().nullable(), launch: Launch.nullable().optional() }).strict();
const Outcome = z.object({ operationId: z.string().uuid(), status: z.enum(["applied", "pending"]), reason: z.string().optional() }).strict();
const LaunchOutcome = z.object({ requestId: z.string().uuid(), operationId: z.string().uuid(),
  status: z.enum(["waiting", "pending", "applied"]), reason: z.string().optional() }).strict();
const CancelOutcome = z.object({ requestId: z.string().uuid(), status: z.literal("cancelled") }).strict();
export type AgentModelSettings = z.infer<typeof Settings>;
export type AgentModelOutcome = z.infer<typeof Outcome>;
export class AgentModelSettingsError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
type Options = { signal?: AbortSignal };

async function request(agentId: string, body: unknown | undefined, options: Options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 45_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const response = await fetch(`/api/hivra/agents/${encodeURIComponent(agentId)}/llm`, {
      method: body === undefined ? "GET" : "POST", cache: "no-store", redirect: "error", credentials: "same-origin",
      signal: controller.signal,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || json?.success !== true) {
      throw new AgentModelSettingsError(typeof json?.error === "string" ? json.error
        : "Model settings could not be confirmed. Refresh before trying again.", typeof json?.code === "string" ? json.code : undefined);
    }
    return json.data as unknown;
  } catch (error) {
    if (error instanceof AgentModelSettingsError) throw error;
    // An interrupted POST may already have reached the server. Never infer
    // that it was cancelled, replay it automatically, or retain the API key.
    throw new AgentModelSettingsError("Connection interrupted. Refresh model settings to check whether your change was saved.");
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort); controller.abort();
  }
}

export async function getAgentModelSettings(agentId: string, options?: Options): Promise<AgentModelSettings> {
  const result = Settings.safeParse(await request(agentId, undefined, options));
  if (!result.success) throw new AgentModelSettingsError("The saved model settings could not be read. Refresh before making a change.");
  return result.data;
}
async function mutate(agentId: string, operationId: string, body: unknown, options?: Options): Promise<AgentModelOutcome> {
  const result = Outcome.safeParse(await request(agentId, body, options));
  if (!result.success || result.data.operationId !== operationId) {
    throw new AgentModelSettingsError("The result did not match your change. Refresh the saved model settings.");
  }
  return result.data;
}
export const setAgentModelSettings = (agentId: string, operationId: string, llm: AgentLlmInput | null, options?: Options) =>
  mutate(agentId, operationId, { action: "apply", operationId, llm }, options);
export const resumeAgentModelSettings = (agentId: string, operationId: string, options?: Options) =>
  mutate(agentId, operationId, { action: "resume", operationId }, options);

export async function continueAgentLaunchModel(agentId: string, requestId: string, operationId: string, automatic: boolean, options?: Options) {
  const result = LaunchOutcome.safeParse(await request(agentId, { action: "continue_launch", requestId, automatic }, options));
  if (!result.success || result.data.requestId !== requestId || result.data.operationId !== operationId) {
    throw new AgentModelSettingsError("The result did not match this launch. Refresh the saved model settings.");
  }
  return result.data;
}
export async function cancelAgentLaunchModel(agentId: string, requestId: string, options?: Options) {
  const result = CancelOutcome.safeParse(await request(agentId, { action: "cancel_launch", requestId }, options));
  if (!result.success || result.data.requestId !== requestId) {
    throw new AgentModelSettingsError("The result did not match this launch. Refresh the saved model settings.");
  }
  return result.data;
}
