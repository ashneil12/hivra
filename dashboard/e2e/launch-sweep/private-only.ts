/**
 * "Private models only" on a real agent (Manage › Inference).
 *
 * After an agent has answered, its owner turns the setting on through the
 * dashboard's own route, reads it back, and asks the agent a second question.
 * The agent's saved model must be one Venice marks private, so with the
 * setting on the gateway still lets it through and the answer still arrives.
 * That proves the setting holds on a live agent without breaking it.
 *
 * Refusing a model that is not private happens in the gateway before anything
 * is sent; the unit tests cover it, because the sweep can only talk to the
 * agent through its own interface, which uses the saved model.
 *
 * Not offered (and not a failure): the switch is off on this deployment (the
 * route answers 404), or the agent doesn't use the managed gateway (409).
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { proveChat, type SweepQuestion } from './chat';
import type { SweepTarget } from './targets';

export const PRIVATE_ONLY_QUESTION: SweepQuestion = {
  prompt: 'What is 512 + 329? Reply with only the number.',
  answer: '841',
};

export type PrivateOnlyCheck =
  | { state: 'not_offered'; reason: string }
  | { state: 'passed'; savedModel: string; replySeconds: number }
  | { state: 'failed'; reason: string; savedModel?: string };

interface PrivateOnlyView {
  enabled?: boolean;
  savedModel?: string;
  savedModelIsPrivate?: boolean;
}

async function readView(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<PrivateOnlyView | null> {
  const body = await response.json().catch(() => null) as { data?: PrivateOnlyView } | null;
  return body?.data ?? null;
}

async function errorText(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  const detail = [body?.code, body?.error].filter((part) => typeof part === 'string' && part).join(': ');
  return `HTTP ${response.status()}${detail ? ` (${detail})` : ''}`;
}

export function privateOnlyCheckEnabled(): boolean {
  return process.env.LAUNCH_SWEEP_PRIVATE_ONLY !== '0';
}

export async function checkPrivateOnly(
  page: Page,
  request: APIRequestContext,
  baseUrl: string,
  agentId: string,
  target: SweepTarget,
  options: { composerTimeoutMs: number; replyTimeoutMs: number },
): Promise<PrivateOnlyCheck> {
  const url = `${baseUrl}/api/hivra/agents/${encodeURIComponent(agentId)}/private-models`;

  const first = await request.get(url, { headers: { Accept: 'application/json' } });
  if (first.status() === 404) return { state: 'not_offered', reason: 'the setting is switched off on this deployment' };
  if (first.status() === 409) return { state: 'not_offered', reason: 'this agent does not use the managed gateway' };
  if (!first.ok()) return { state: 'failed', reason: `reading the setting answered ${await errorText(first)}` };

  // The route only takes a change from the dashboard itself: same origin, JSON.
  const put = await request.put(url, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: baseUrl,
      'Sec-Fetch-Site': 'same-origin',
    },
    data: { enabled: true },
  });
  if (!put.ok()) return { state: 'failed', reason: `turning the setting on answered ${await errorText(put)}` };

  const after = await request.get(url, { headers: { Accept: 'application/json' } });
  const view = after.ok() ? await readView(after) : null;
  if (!view) return { state: 'failed', reason: `reading the setting back answered ${await errorText(after)}` };
  const savedModel = view.savedModel ?? 'unknown';
  if (view.enabled !== true) return { state: 'failed', reason: 'the setting did not stay on after it was saved', savedModel };
  if (view.savedModelIsPrivate !== true) {
    return {
      state: 'failed',
      reason: `the agent's saved model (${savedModel}) is not one Venice marks private, so the setting would stop this agent working`,
      savedModel,
    };
  }

  try {
    const proof = await proveChat(page, target, { ...options, question: PRIVATE_ONLY_QUESTION });
    return { state: 'passed', savedModel, replySeconds: proof.replySeconds };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { state: 'failed', reason: `with the setting on, the agent did not answer: ${why}`, savedModel };
  }
}
