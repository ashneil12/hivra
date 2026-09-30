// What Manage may say about an agent's Computer Contract. Client-safe.
//
// The UI shows observed state only: a revision reads as delivered only when a
// receipt for its exact bytes exists, a DigitalOcean note only as "sent in
// chat", and an edited copy as changed. Resumed chats are not proven to reload
// the instructions file (spike S3), so every delivered note applies to new
// chats only.

import type { ComputerContractChannel } from "./computer-contract-input";

export type ComputerContractState = "pending" | "delivered" | "sent" | "conflict";

export type ComputerContractStatus =
  /** A computer without an agent, or a runtime with its own instructions. */
  | { kind: "not_applicable"; reason: "computer" | "own_instructions" }
  /** The contract store could not be read. Nothing is claimed. */
  | { kind: "unavailable" }
  /** No revision exists yet: the agent is not running, or a DigitalOcean
   * session never received its setup note. */
  | { kind: "not_started"; channel: ComputerContractChannel }
  | {
      kind: "tracked";
      channel: ComputerContractChannel;
      revision: number;
      content: string;
      state: ComputerContractState;
      deliveredAt: string | null;
      checkedAt: string | null;
      lastAttemptAt: string | null;
      lastError: string | null;
      /** The newest revision that has a delivery receipt, if not the latest. */
      lastDelivered: { revision: number; deliveredAt: string } | null;
      appliesTo: "new-chats";
    };

export interface ComputerContractRowView {
  revision: number;
  channel: ComputerContractChannel;
  content: string;
  delivery_state: ComputerContractState;
  delivered_at: string | null;
  checked_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
}

/** Newest-first rows to the one status Manage renders. */
export function computerContractStatusFromRows(
  channel: ComputerContractChannel,
  rows: readonly ComputerContractRowView[] | null,
): ComputerContractStatus {
  if (!rows) return { kind: "unavailable" };
  const latest = rows[0];
  if (!latest) return { kind: "not_started", channel };
  const previous = rows.slice(1).find((row) => row.delivered_at && (row.delivery_state === "delivered" || row.delivery_state === "sent" || row.delivery_state === "conflict"));
  return {
    kind: "tracked",
    channel: latest.channel,
    revision: latest.revision,
    content: latest.content,
    state: latest.delivery_state,
    deliveredAt: latest.delivered_at,
    checkedAt: latest.checked_at,
    lastAttemptAt: latest.last_attempt_at,
    lastError: latest.last_error,
    lastDelivered: previous?.delivered_at ? { revision: previous.revision, deliveredAt: previous.delivered_at } : null,
    appliesTo: "new-chats",
  };
}
