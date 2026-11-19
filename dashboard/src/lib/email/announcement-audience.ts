// One place for the Resend segment and topic that product updates and the
// newsletter go to. The daily sync (resend-announcement-sync.ts), the manual
// setup script and the broadcast script all read these, so they can't drift.
// No imports here on purpose: the scripts load this file with plain ts-node,
// which doesn't resolve the "@/" path alias.
export const DEFAULT_SEGMENT_NAME = "Hivra customers";
export const DEFAULT_TOPIC_NAME = "Product updates";
export const DEFAULT_TOPIC_DESCRIPTION =
  "Product announcements, launch notes, customer updates, and other Hivra news.";
