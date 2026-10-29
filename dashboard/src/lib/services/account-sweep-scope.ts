/**
 * The in-app account sweep (DELETE /api/mobile/account) deletes every agent of
 * one user by calling the instance DELETE handler once per agent. Agents that
 * share a Hetzner server are removed together by that sweep, so the handler
 * needs to know the sweep exists. This marker carries that knowledge.
 *
 * The marker is held in a WeakMap keyed by the request object the sweep builds
 * in-process. An HTTP request never reaches the map, so a client cannot grant
 * itself a sweep by sending a header or body field. The web DELETE keeps its
 * refusal for shared servers.
 */

export interface AccountSweep {
  /** The authenticated user the sweep deletes for. */
  readonly userId: string;
  /** Every agent row the sweep is deleting, read before the first delete. */
  readonly instanceIds: readonly string[];
  /**
   * Hetzner server ids the sweep has already destroyed. A later agent on the
   * same server skips the provider call, so the server is removed once.
   */
  readonly removedHetznerServerIds: Set<number>;
}

const sweepByRequest = new WeakMap<object, AccountSweep>();

export function createAccountSweep(userId: string, instanceIds: readonly string[]): AccountSweep {
  return { userId, instanceIds: [...instanceIds], removedHetznerServerIds: new Set<number>() };
}

export function attachAccountSweep(request: object, sweep: AccountSweep): void {
  sweepByRequest.set(request, sweep);
}

export function accountSweepFor(request: object): AccountSweep | null {
  return sweepByRequest.get(request) ?? null;
}
