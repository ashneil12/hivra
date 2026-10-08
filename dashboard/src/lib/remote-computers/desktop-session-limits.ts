/**
 * Limits shared by the browser's desktop session lane and the session broker.
 * No imports, so both the client bundle and the server route can use it.
 */

/** How many earlier, unanswered session requests one browser issue may name. */
export const MAX_UNANSWERED_DESKTOP_ISSUES = 8;

/**
 * No desktop grant outlives five minutes, so neither does a lease that an
 * unanswered request left behind; the browser forgets such a request after it.
 */
export const UNANSWERED_DESKTOP_ISSUE_TTL_MS = 5 * 60_000;
