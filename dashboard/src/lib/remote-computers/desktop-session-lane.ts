/**
 * One browser tab's coordination of a computer's Linux desktop requests.
 *
 * Module scope is one tab. Within it:
 *
 * - Every caller that proves a computer's desktop runtime (the agent page's
 *   prefetch, the desktop's open, its reconnect and its while-connected
 *   refresh) shares one in-flight `refresh`. Two concurrent refreshes each run
 *   the full guest inspection and spend two of the computer's twelve refreshes
 *   per 15 minutes. On a Proxmox desktop the ledger also refuses a receipt
 *   whose observation is older than one already recorded, so whichever of the
 *   two observed first but recorded second fails as "could not be verified";
 *   when that was the open's own proof, the open treated a healthy desktop as
 *   broken and went on to repair it.
 * - Session issue requests for one computer run one at a time. An open that
 *   replaces an older open in this tab then never meets that older open's
 *   freshly issued lease as "another controller" (a 10 s wait, or a stop at
 *   Take over here).
 * - A session request whose answer this tab never read (the network dropped
 *   after the request left, the page reloaded while it was out, the answer
 *   was cut off) may still have left a lease on the server that nobody can
 *   use, because only that answer carried its one-time exchange code. The
 *   one-controller fence counts such a lease as another controller until it
 *   expires (four minutes), so the next open waited and then stopped at Take
 *   over here, blaming another person for this tab's own request. The tab
 *   remembers each such request's PKCE challenge (never its verifier) in
 *   memory and in sessionStorage, which survives a reload of this tab, and
 *   names them on its next requests. The broker then retires only this
 *   owner's never-exchanged leases carrying those challenges.
 */

import {
  MAX_UNANSWERED_DESKTOP_ISSUES,
  UNANSWERED_DESKTOP_ISSUE_TTL_MS,
} from "@/lib/remote-computers/desktop-session-limits";

export type DesktopProofPayload = {
  success?: boolean;
  code?: string;
  error?: string;
  data?: { prepared?: boolean };
};

export type DesktopProof = {
  ok: boolean;
  status: number;
  payload: DesktopProofPayload | null;
};

type ProofState = {
  inflight: Promise<DesktopProof> | null;
  /** Count of proofs that succeeded, so a caller can ask "any success since X?". */
  successes: number;
  lastSuccess: DesktopProof | null;
};

// An issue normally answers in well under two seconds. A lane never waits on a
// predecessor longer than this, so one hung request cannot stall the desktop.
export const DESKTOP_ISSUE_LANE_WAIT_MS = 15_000;

const UNANSWERED_STORAGE_PREFIX = "hivra.remote-desktop.unanswered-issues.v1:";
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

type UnansweredIssue = { challenge: string; sentAt: number };

let proofs = new Map<string, ProofState>();
let lanes = new Map<string, Promise<void>>();
let unanswered = new Map<string, UnansweredIssue[]>();

function proofState(computerId: string): ProofState {
  let state = proofs.get(computerId);
  if (!state) {
    state = { inflight: null, successes: 0, lastSuccess: null };
    proofs.set(computerId, state);
  }
  return state;
}

function provedReady(proof: DesktopProof): boolean {
  return proof.ok && proof.payload?.success === true && proof.payload.data?.prepared === true;
}

/** How many runtime proofs for this computer have succeeded in this tab. */
export function desktopProofSuccesses(computerId: string): number {
  return proofs.get(computerId)?.successes ?? 0;
}

/**
 * Prove this computer's desktop runtime (`{ action: "refresh" }`), joining a
 * proof already in flight in this tab instead of starting a second one.
 *
 * `reuseSuccessAfter`: when no proof is in flight, a proof that succeeded
 * after the caller read `desktopProofSuccesses` is returned as is. An open
 * whose session request raced the page's prefetch uses this, so the proof
 * that landed while its request was on the way is not run again.
 *
 * Rejects when the request itself fails, as `fetch` does.
 */
export function refreshDesktopCapability(
  computerId: string,
  options: { reuseSuccessAfter?: number } = {},
): Promise<DesktopProof> {
  const state = proofState(computerId);
  if (state.inflight) return state.inflight;
  if (
    options.reuseSuccessAfter !== undefined
    && state.lastSuccess
    && state.successes > options.reuseSuccessAfter
  ) {
    return Promise.resolve(state.lastSuccess);
  }
  const request = (async (): Promise<DesktopProof> => {
    const response = await fetch(`/api/hivra/agents/${encodeURIComponent(computerId)}/remote-desktop`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    });
    const payload = await response.json().catch(() => null) as DesktopProofPayload | null;
    return { ok: response.ok, status: response.status, payload };
  })();
  state.inflight = request;
  // Registered before any caller's continuation, so a caller that resumes on
  // this proof already sees it settled and counted.
  request.then(proof => {
    if (state.inflight === request) state.inflight = null;
    if (provedReady(proof)) {
      state.successes += 1;
      state.lastSuccess = proof;
    }
  }, () => {
    if (state.inflight === request) state.inflight = null;
  });
  return request;
}

/**
 * Run one session-issue step for this computer after every earlier one in
 * this tab has finished (bounded by DESKTOP_ISSUE_LANE_WAIT_MS).
 */
export function runDesktopIssue<T>(computerId: string, task: () => Promise<T>): Promise<T> {
  const owner = lanes;
  const previous = owner.get(computerId);
  const run = (async () => {
    if (previous) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        previous,
        new Promise<void>(resolve => { timer = setTimeout(resolve, DESKTOP_ISSUE_LANE_WAIT_MS); }),
      ]);
      clearTimeout(timer);
    }
    return task();
  })();
  const tail = run.then(() => undefined, () => undefined);
  owner.set(computerId, tail);
  void tail.then(() => {
    if (owner.get(computerId) === tail) owner.delete(computerId);
  });
  return run;
}

function readStoredUnanswered(computerId: string): UnansweredIssue[] {
  try {
    const raw = window.sessionStorage.getItem(UNANSWERED_STORAGE_PREFIX + computerId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is UnansweredIssue => !!entry && typeof entry === "object"
      && typeof (entry as UnansweredIssue).challenge === "string"
      && PKCE_CHALLENGE_RE.test((entry as UnansweredIssue).challenge)
      && typeof (entry as UnansweredIssue).sentAt === "number"
      && Number.isFinite((entry as UnansweredIssue).sentAt));
  } catch {
    // Storage can be blocked or full; memory still covers this page.
    return [];
  }
}

function unansweredEntries(computerId: string): UnansweredIssue[] {
  const now = Date.now();
  const entries = (unanswered.get(computerId) ?? readStoredUnanswered(computerId))
    .filter(entry => entry.sentAt <= now && now - entry.sentAt < UNANSWERED_DESKTOP_ISSUE_TTL_MS)
    .slice(-MAX_UNANSWERED_DESKTOP_ISSUES);
  unanswered.set(computerId, entries);
  return entries;
}

function storeUnanswered(computerId: string, entries: UnansweredIssue[]): void {
  unanswered.set(computerId, entries);
  try {
    if (entries.length) {
      window.sessionStorage.setItem(UNANSWERED_STORAGE_PREFIX + computerId, JSON.stringify(entries));
    } else {
      window.sessionStorage.removeItem(UNANSWERED_STORAGE_PREFIX + computerId);
    }
  } catch {
    // Memory still covers this page.
  }
}

/**
 * Challenges of this computer's session requests whose answers this tab never
 * read in the last five minutes, oldest first. `except` leaves out the
 * request about to be sent.
 */
export function unansweredDesktopIssues(computerId: string, except?: string): string[] {
  return unansweredEntries(computerId).map(entry => entry.challenge).filter(challenge => challenge !== except);
}

/** Call before a session request leaves; the answer, once read, calls `desktopIssueAnswered`. */
export function desktopIssueSent(computerId: string, challenge: string): void {
  if (!PKCE_CHALLENGE_RE.test(challenge)) return;
  const entries = unansweredEntries(computerId).filter(entry => entry.challenge !== challenge);
  entries.push({ challenge, sentAt: Date.now() });
  storeUnanswered(computerId, entries.slice(-MAX_UNANSWERED_DESKTOP_ISSUES));
}

/**
 * The server's answer to this request was read, so the request left no lease
 * this tab does not know about: a grant names its session, and a refusal
 * created none.
 */
export function desktopIssueAnswered(computerId: string, challenge: string): void {
  const entries = unansweredEntries(computerId);
  const remaining = entries.filter(entry => entry.challenge !== challenge);
  if (remaining.length !== entries.length) storeUnanswered(computerId, remaining);
}

/**
 * Tests only: forget every proof, lane and remembered request, as a new tab
 * would. `keepStorage` models a reload of the same tab instead, whose
 * sessionStorage survives.
 */
export function resetDesktopSessionLaneForTests(options: { keepStorage?: boolean } = {}): void {
  proofs = new Map();
  lanes = new Map();
  unanswered = new Map();
  if (options.keepStorage) return;
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(UNANSWERED_STORAGE_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // No storage in this environment.
  }
}
