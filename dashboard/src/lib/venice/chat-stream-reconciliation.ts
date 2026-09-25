// Reconciliation reason for a streamed chat completion whose client went away
// after Venice had answered 200 but before a usage frame arrived.
//
// Venice was already generating, and billing Hivra, for that request, so the
// wallet hold stays in place and this item is left for an operator. It is
// deliberately NOT one of SWEEPABLE_RECONCILIATION_REASONS in
// reservation-sweep.ts: that sweep releases holds, and releasing this one would
// make every interrupted stream free again, only six hours later (security
// review 2026-09). The Responses route keeps its own non-sweepable reason for
// the same case (RESPONSES_RECONCILIATION_REASON).
export const CHAT_STREAM_CANCELLED_RECONCILIATION_REASON =
  "managed_venice_chat_stream_cancelled";
