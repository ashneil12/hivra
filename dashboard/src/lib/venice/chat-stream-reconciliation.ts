// Reconciliation reason for a streamed chat completion whose client went away
// after Venice had answered 200 and whose in-request charge (Venice's usage,
// read after the client left, or the input estimate plus the output read,
// stream-settlement.ts) could not be written.
//
// Venice was already generating, and billing Hivra, for that request, so the
// hold is never released (that would make every interrupted stream free
// again, security review 2026-09). The item carries the observed output, and
// the hourly stale-hold sweep captures that amount (reservation-sweep.ts).
// The Responses route keeps its own reason for the same case
// (RESPONSES_RECONCILIATION_REASON).
export const CHAT_STREAM_CANCELLED_RECONCILIATION_REASON =
  "managed_venice_chat_stream_cancelled";
