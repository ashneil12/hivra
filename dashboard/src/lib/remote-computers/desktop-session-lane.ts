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
 */

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

let proofs = new Map<string, ProofState>();
let lanes = new Map<string, Promise<void>>();

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

/** Tests only: forget every proof and lane, as a new tab would. */
export function resetDesktopSessionLaneForTests(): void {
  proofs = new Map();
  lanes = new Map();
}
