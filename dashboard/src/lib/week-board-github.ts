import {
  shippedThisWeek,
  stillMovingCount,
  stuckPulls,
  type ShippedPull,
  type StuckPull,
  type WeekPull,
} from "@/lib/week-board";

const MERGED_URL =
  "https://api.github.com/repos/ashneil12/hivra/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100";
const OPEN_URL =
  "https://api.github.com/repos/ashneil12/hivra/pulls?state=open&sort=updated&direction=asc&per_page=100";

const USER_AGENT = "Hivra (https://hivra.cloud/week)";
const TIMEOUT_MS = 8000;
const PAGE_CAP = 100;

export interface WeekBoardLoaded {
  ok: true;
  shipped: ShippedPull[];
  stuck: StuckPull[];
  moving: number;
  shippedMayBeCapped: boolean;
  openMayBeCapped: boolean;
}

export interface WeekBoardFailed {
  ok: false;
}

export type WeekBoardResult = WeekBoardLoaded | WeekBoardFailed;

function asPull(raw: unknown): WeekPull | null {
  if (!raw || typeof raw !== "object") return null;
  const pull = raw as Record<string, unknown>;
  if (typeof pull.number !== "number" || typeof pull.title !== "string") return null;
  return {
    number: pull.number,
    title: pull.title,
    state: typeof pull.state === "string" ? pull.state : undefined,
    draft: pull.draft === true,
    merged_at: typeof pull.merged_at === "string" ? pull.merged_at : null,
    updated_at: typeof pull.updated_at === "string" ? pull.updated_at : null,
    closed_at: typeof pull.closed_at === "string" ? pull.closed_at : null,
  };
}

async function fetchPulls(fetchImpl: typeof fetch, url: string): Promise<{ pulls: WeekPull[]; capped: boolean }> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    next: { revalidate: 300 },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("GitHub response was not a list");
  }
  return {
    pulls: body.flatMap((item) => {
      const pull = asPull(item);
      return pull ? [pull] : [];
    }),
    capped: body.length >= PAGE_CAP,
  };
}

/** Loads merged and open pulls. `fetchImpl` is injectable so tests never call GitHub. */
export async function loadWeekBoard(now: Date, fetchImpl: typeof fetch = fetch): Promise<WeekBoardResult> {
  try {
    const [merged, open] = await Promise.all([
      fetchPulls(fetchImpl, MERGED_URL),
      fetchPulls(fetchImpl, OPEN_URL),
    ]);
    return {
      ok: true,
      shipped: shippedThisWeek(merged.pulls, now),
      stuck: stuckPulls(open.pulls, now),
      moving: stillMovingCount(open.pulls, now),
      shippedMayBeCapped: merged.capped,
      openMayBeCapped: open.capped,
    };
  } catch {
    return { ok: false };
  }
}
