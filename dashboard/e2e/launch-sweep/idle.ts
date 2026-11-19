/**
 * IDLE COST: what an agent uses when nobody is talking to it.
 *
 * After an agent has answered (or a computer has opened), the sweep closes the
 * agent's tab, the way a customer walks away, and reads the agent's own usage
 * every 30 s for a few minutes from the same place its owner sees it: Manage ›
 * Overview (GET /api/hivra/agents/:id/usage). The read is made from a Hivra
 * page that stays open (the dashboard home), because Clerk's session token
 * lives about a minute and only a live page keeps refreshing it; a detached
 * request gets 401 once the agent's tab is gone. That is the number Free vs Pro
 * decisions are made on: how much RAM, CPU and disk one idle agent holds.
 *
 * Memory comes from the host's balloon driver and includes the guest's file
 * cache, so it is an upper bound; compare agents with the Linux computer row,
 * which is the bare computer every agent runs on. Never fails a launch: a
 * missing reading is recorded with the reason.
 */
import type { Page } from '@playwright/test';

import { sleep } from '../first-run-audit/instances';

export interface IdleUsage {
  minutes: number;
  samples: number;
  /** Median and peak CPU over the idle window, percent of the computer's vCPUs. */
  cpuPercentMedian: number | null;
  cpuPercentMax: number | null;
  vcpus: number | null;
  /** Median and peak memory in MB (includes the guest's file cache when memoryIncludesCache). */
  memoryMbMedian: number | null;
  memoryMbMax: number | null;
  memoryMbSize: number | null;
  memoryIncludesCache: boolean;
  /** Disk used inside the computer at the end, from its guest agent. */
  diskUsedGb: number | null;
  diskAllocatedGb: number | null;
  note?: string;
}

interface UsageView {
  supported?: boolean;
  reason?: string;
  cpu?: { percent: number; vcpus: number } | null;
  memory?: { usedBytes: number; maximumBytes: number; includesCache: boolean } | null;
  disk?: { usedBytes: number | null; allocatedBytes: number | null } | null;
  notes?: string[];
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (value: number | null, places = 0): number | null =>
  value === null ? null : Math.round(value * 10 ** places) / 10 ** places;

async function readUsage(page: Page, agentId: string): Promise<UsageView | string> {
  try {
    const result = await page.evaluate(async (id) => {
      const res = await fetch(`/api/hivra/agents/${encodeURIComponent(id)}/usage`, { credentials: 'same-origin', cache: 'no-store' });
      return { status: res.status, body: res.ok ? await res.json() : null };
    }, agentId);
    if (result.status !== 200) return `usage answered HTTP ${result.status}`;
    const body = result.body as { data?: UsageView } | null;
    return body?.data ?? 'usage answered without data';
  } catch (err) {
    return `usage unreadable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
  }
}

export async function measureIdle(
  page: Page,
  agentId: string,
  minutes: number,
): Promise<IdleUsage> {
  const cpu: number[] = [];
  const memory: number[] = [];
  let last: UsageView | null = null;
  let problem = '';
  const end = Date.now() + minutes * 60_000;
  // Let whatever the chat started settle before the first reading counts.
  await sleep(Math.min(60_000, minutes * 60_000 / 4));
  while (Date.now() < end) {
    const view = await readUsage(page, agentId);
    if (typeof view === 'string') {
      problem = view;
    } else if (view.supported === false) {
      problem = view.reason ?? 'live usage not supported for this computer';
      last = view;
      break;
    } else {
      last = view;
      if (view.cpu) cpu.push(view.cpu.percent);
      if (view.memory) memory.push(view.memory.usedBytes / MB);
    }
    // The server reads the host at most every 20 s per computer.
    await sleep(30_000);
  }
  const notes = [problem, ...(last?.notes ?? [])].filter(Boolean);
  return {
    minutes,
    samples: Math.max(cpu.length, memory.length),
    cpuPercentMedian: round(median(cpu), 1),
    cpuPercentMax: round(cpu.length ? Math.max(...cpu) : null, 1),
    vcpus: last?.cpu?.vcpus ?? null,
    memoryMbMedian: round(median(memory)),
    memoryMbMax: round(memory.length ? Math.max(...memory) : null),
    memoryMbSize: round(last?.memory ? last.memory.maximumBytes / MB : null),
    memoryIncludesCache: last?.memory?.includesCache ?? true,
    diskUsedGb: round(last?.disk?.usedBytes != null ? last.disk.usedBytes / GB : null, 1),
    diskAllocatedGb: round(last?.disk?.allocatedBytes != null ? last.disk.allocatedBytes / GB : null, 1),
    ...(notes.length ? { note: [...new Set(notes)].join('; ').slice(0, 300) } : {}),
  };
}
