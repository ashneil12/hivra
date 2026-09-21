import { Resend } from "resend";
import { log } from "@/lib/logger";

import { isInternalNonReceivingRecipient } from "./welcome";

const LOG_SOURCE = "resend-announcement-sync";

const CLERK_API_BASE_URL = "https://api.clerk.com/v1";
const CLERK_PAGE_SIZE = 100;
const CONTACT_SYNC_DELAY_MS = 800;
const RATE_LIMIT_RETRY_MS = 1_500;
const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_SEGMENT_NAME = "Hivra customers";
const DEFAULT_TOPIC_NAME = "Product updates";
const DEFAULT_TOPIC_DESCRIPTION =
  "Product announcements, launch notes, customer updates, and other Hivra news.";

const CONTACT_PROPERTIES = [
  { key: "clerk_user_id", type: "string" as const },
  { key: "clerk_created_at", type: "string" as const },
  { key: "source", type: "string" as const },
];

type ClerkEmailAddress = {
  id: string;
  email_address: string;
  verification?: {
    status?: string;
  } | null;
};

export type ClerkAnnouncementUser = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  created_at?: number | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
};

type AnnouncementSource = "clerk" | "reservation";

export type AnnouncementRecipient = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  source: AnnouncementSource;
  // Clerk-only metadata; null for reservation-source contacts that
  // haven't created a Clerk account yet.
  userId: string | null;
  clerkCreatedAt: string | null;
};

type ResendContact = {
  id: string;
  email: string;
  unsubscribed: boolean;
};

type ResendResponseWithError = {
  error: {
    name: string;
    statusCode: number | null;
    message: string;
  } | null;
};

type SyncConfig = {
  segmentName: string;
  topicName: string;
  topicDescription: string;
};

export type AnnouncementAudienceSyncResult = {
  clerkUsersFound: number;
  recipients: number;
  created: number;
  updated: number;
  unsubscribed: number;
  skipped: number;
  pruned: number;
  segmentId: string;
  topicId: string;
  // True when the run stopped early because it hit its wall-clock budget.
  // The sync is idempotent (re-running converges), so the unprocessed tail is
  // picked up on the next daily run.
  timedOut: boolean;
  // How many recipients we got through before the budget (if any) tripped.
  recipientsProcessed: number;
};

export type SyncAnnouncementAudienceOptions = {
  // Wall-clock budget for the whole sync. When elapsed time crosses this, the
  // recipient loop and the orphan-prune loop stop cleanly between items and
  // return a partial result with timedOut=true. Default: no budget (legacy
  // unbounded behavior). The cron passes a value safely under maxDuration.
  timeBudgetMs?: number;
  // Injectable clock for tests.
  now?: () => number;
};

function getSyncConfig(): SyncConfig {
  return {
    segmentName: process.env.RESEND_ANNOUNCEMENT_SEGMENT?.trim() || DEFAULT_SEGMENT_NAME,
    topicName: process.env.RESEND_ANNOUNCEMENT_TOPIC?.trim() || DEFAULT_TOPIC_NAME,
    topicDescription:
      process.env.RESEND_ANNOUNCEMENT_TOPIC_DESCRIPTION?.trim() || DEFAULT_TOPIC_DESCRIPTION,
  };
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function chooseEmail(user: ClerkAnnouncementUser) {
  const addresses = user.email_addresses || [];
  const primary = addresses.find((address) => address.id === user.primary_email_address_id);
  const verified = addresses.find((address) => address.verification?.status === "verified");
  return primary?.email_address || verified?.email_address || addresses[0]?.email_address || null;
}

function formatClerkCreatedAt(value: number | null | undefined) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateLimitRetry<T extends ResendResponseWithError>(
  label: string,
  operation: () => Promise<T>,
) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const result = await operation();
    if (
      !result.error ||
      (result.error.name !== "rate_limit_exceeded" && result.error.statusCode !== 429)
    ) {
      return result;
    }

    if (attempt === MAX_RATE_LIMIT_RETRIES) return result;

    const waitMs = RATE_LIMIT_RETRY_MS * (attempt + 1);
    log.info("hit Resend rate limit, waiting before retrying", {
      source: LOG_SOURCE,
      label,
      waitMs,
      attempt,
    });
    await sleep(waitMs);
  }

  return operation();
}

function buildAnnouncementRecipient(user: ClerkAnnouncementUser): AnnouncementRecipient | null {
  const email = chooseEmail(user)?.trim().toLowerCase();
  if (!email) return null;

  return {
    email,
    firstName: user.first_name?.trim() || null,
    lastName: user.last_name?.trim() || null,
    source: "clerk",
    userId: user.id,
    clerkCreatedAt: formatClerkCreatedAt(user.created_at),
  };
}

function buildReservationRecipient(email: string): AnnouncementRecipient | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  return {
    email: normalized,
    firstName: null,
    lastName: null,
    source: "reservation",
    userId: null,
    clerkCreatedAt: null,
  };
}

function buildAnnouncementRecipients(users: ClerkAnnouncementUser[]) {
  const recipients: AnnouncementRecipient[] = [];
  const seenEmails = new Set<string>();

  for (const user of users) {
    const recipient = buildAnnouncementRecipient(user);
    if (!recipient || seenEmails.has(recipient.email)) continue;
    seenEmails.add(recipient.email);
    recipients.push(recipient);
  }

  return recipients;
}

export async function fetchClerkAnnouncementUsers(secretKey = requireEnv("CLERK_SECRET_KEY")) {
  const users: ClerkAnnouncementUser[] = [];

  for (let offset = 0; ; offset += CLERK_PAGE_SIZE) {
    const url = new URL("/v1/users", CLERK_API_BASE_URL);
    url.searchParams.set("limit", String(CLERK_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Clerk users: ${response.status}`);
    }

    const page = (await response.json()) as ClerkAnnouncementUser[];
    users.push(...page);

    if (page.length < CLERK_PAGE_SIZE) break;
  }

  return users;
}

async function ensureSegment(resend: Resend, name: string) {
  const existing = await withRateLimitRetry("List segments", () =>
    resend.segments.list({ limit: 100 }),
  );
  if (existing.error) {
    throw new Error(`Failed to list Resend segments: ${existing.error.message}`);
  }

  const segment = existing.data.data.find((item) => item.name === name);
  if (segment) return segment.id;

  const created = await withRateLimitRetry(`Create segment ${name}`, () =>
    resend.segments.create({ name }),
  );
  if (created.error) {
    throw new Error(`Failed to create Resend segment "${name}": ${created.error.message}`);
  }

  return created.data.id;
}

async function ensureTopic(resend: Resend, config: SyncConfig) {
  const existing = await withRateLimitRetry("List topics", () => resend.topics.list());
  if (existing.error) {
    throw new Error(`Failed to list Resend topics: ${existing.error.message}`);
  }

  const topic = existing.data.data.find((item) => item.name === config.topicName);
  if (topic) {
    if (topic.description !== config.topicDescription) {
      const updated = await withRateLimitRetry(`Update topic ${config.topicName}`, () =>
        resend.topics.update({
          id: topic.id,
          name: config.topicName,
          description: config.topicDescription,
        }),
      );
      if (updated.error) {
        throw new Error(`Failed to update Resend topic "${config.topicName}": ${updated.error.message}`);
      }
    }

    return topic.id;
  }

  const created = await withRateLimitRetry(`Create topic ${config.topicName}`, () =>
    resend.topics.create({
      name: config.topicName,
      description: config.topicDescription,
      defaultSubscription: "opt_in",
    }),
  );
  if (created.error) {
    throw new Error(`Failed to create Resend topic "${config.topicName}": ${created.error.message}`);
  }

  return created.data.id;
}

async function ensureContactProperties(resend: Resend) {
  const existing = await withRateLimitRetry("List contact properties", () =>
    resend.contactProperties.list({ limit: 100 }),
  );
  if (existing.error) {
    throw new Error(`Failed to list Resend contact properties: ${existing.error.message}`);
  }

  const existingKeys = new Set(existing.data.data.map((property) => property.key));
  const missing = CONTACT_PROPERTIES.filter((property) => !existingKeys.has(property.key));

  for (const property of missing) {
    const response = await withRateLimitRetry(`Create contact property ${property.key}`, () =>
      resend.contactProperties.create({
        key: property.key,
        type: property.type,
        fallbackValue: null,
      }),
    );

    if (response.error) {
      throw new Error(
        `Failed to create Resend contact property "${property.key}": ${response.error.message}`,
      );
    }

    await sleep(CONTACT_SYNC_DELAY_MS);
  }
}

async function ensureAnnouncementSetup(resend: Resend) {
  const config = getSyncConfig();
  const segmentId = await ensureSegment(resend, config.segmentName);
  const topicId = await ensureTopic(resend, config);
  await ensureContactProperties(resend);

  return { segmentId, topicId };
}

async function getContactByEmail(resend: Resend, email: string) {
  const response = await withRateLimitRetry(`Get contact ${email}`, () =>
    resend.contacts.get({ email }),
  );
  if (response.error) {
    if (response.error.statusCode === 404 || response.error.name === "not_found") {
      return null;
    }

    throw new Error(`Failed to get Resend contact: ${response.error.message}`);
  }

  return response.data as ResendContact;
}

async function syncAnnouncementRecipient(
  resend: Resend,
  recipient: AnnouncementRecipient,
  segmentId: string,
) {
  const existing = await getContactByEmail(resend, recipient.email);
  const properties = {
    clerk_user_id: recipient.userId,
    clerk_created_at: recipient.clerkCreatedAt,
    source: recipient.source,
  };

  if (!existing) {
    const created = await withRateLimitRetry(`Create contact ${recipient.email}`, () =>
      resend.contacts.create({
        email: recipient.email,
        firstName: recipient.firstName || undefined,
        lastName: recipient.lastName || undefined,
        properties,
        segments: [{ id: segmentId }],
      }),
    );

    if (created.error) {
      throw new Error(`Failed to create Resend contact: ${created.error.message}`);
    }

    return { action: "created" as const, unsubscribed: false };
  }

  const updated = await withRateLimitRetry(`Update contact ${recipient.email}`, () =>
    resend.contacts.update({
      email: recipient.email,
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      properties,
    }),
  );

  if (updated.error) {
    throw new Error(`Failed to update Resend contact: ${updated.error.message}`);
  }

  const added = await withRateLimitRetry(`Add contact ${recipient.email} to segment`, () =>
    resend.contacts.segments.add({
      email: recipient.email,
      segmentId,
    }),
  );

  if (
    added.error &&
    added.error.statusCode !== 409 &&
    !added.error.message.toLowerCase().includes("already")
  ) {
    throw new Error(`Failed to add Resend contact to segment: ${added.error.message}`);
  }

  return { action: "updated" as const, unsubscribed: existing.unsubscribed };
}

export async function syncClerkUserToAnnouncementAudience(user: ClerkAnnouncementUser) {
  const recipient = buildAnnouncementRecipient(user);
  if (!recipient) {
    return {
      skipped: true,
      reason: "missing_email",
    } as const;
  }

  if (isInternalNonReceivingRecipient(recipient.email)) {
    // firstrun-audit synthetics and @hermesos.cloud / @hivra.cloud placeholders
    // can never receive mail. Adding them as audience contacts hard-bounces
    // every future broadcast and poisons sender reputation, so skip before we
    // ever hit the Resend API (mirrors the welcome-email suppression).
    return {
      skipped: true,
      reason: "internal_recipient",
    } as const;
  }

  const resend = new Resend(requireEnv("RESEND_API_KEY"));
  const { segmentId } = await ensureAnnouncementSetup(resend);
  const result = await syncAnnouncementRecipient(resend, recipient, segmentId);

  return {
    skipped: false,
    email: recipient.email,
    ...result,
  } as const;
}

export async function syncReservationToAnnouncementAudience(email: string) {
  const recipient = buildReservationRecipient(email);
  if (!recipient) {
    return { skipped: true, reason: "missing_email" } as const;
  }

  if (isInternalNonReceivingRecipient(recipient.email)) {
    return { skipped: true, reason: "internal_recipient" } as const;
  }

  const resend = new Resend(requireEnv("RESEND_API_KEY"));
  const { segmentId } = await ensureAnnouncementSetup(resend);
  const result = await syncAnnouncementRecipient(resend, recipient, segmentId);

  return {
    skipped: false,
    email: recipient.email,
    ...result,
  } as const;
}

async function pruneOrphanedClerkContacts(
  resend: Resend,
  segmentId: string,
  validClerkUserIds: Set<string>,
  // Absolute wall-clock deadline (epoch ms) or null for unbounded. When set,
  // the prune loop stops cleanly between contacts once crossed, returning what
  // it pruned so far. Pruning is idempotent — the next run resumes.
  deadline: number | null = null,
  now: () => number = Date.now,
) {
  let pruned = 0;
  let after: string | undefined;
  let timedOut = false;

  while (true) {
    if (deadline !== null && now() >= deadline) {
      timedOut = true;
      break;
    }
    const list = await withRateLimitRetry("List segment contacts", () =>
      resend.contacts.list({ segmentId, limit: 100, ...(after ? { after } : {}) }),
    );
    if (list.error) {
      throw new Error(`Failed to list segment contacts: ${list.error.message}`);
    }

    const contacts = list.data.data;
    if (contacts.length === 0) break;

    for (const summary of contacts) {
      if (deadline !== null && now() >= deadline) {
        timedOut = true;
        break;
      }

      // One-off cleanup of internal non-receiving contacts that predate the
      // sync-time filter. firstrun-audit synthetics keep live Clerk users, so
      // the orphan check below never catches them — remove on sight (by email,
      // no detail fetch needed) so they stop hard-bouncing broadcasts. Idempotent
      // across runs; the next daily sync converges any budget-truncated tail.
      if (isInternalNonReceivingRecipient(summary.email)) {
        const removed = await withRateLimitRetry(`Remove contact ${summary.email}`, () =>
          resend.contacts.remove({ email: summary.email }),
        );
        if (
          removed.error &&
          removed.error.statusCode !== 404 &&
          removed.error.name !== "not_found"
        ) {
          throw new Error(
            `Failed to remove internal Resend contact: ${removed.error.message}`,
          );
        }
        pruned += 1;
        await sleep(CONTACT_SYNC_DELAY_MS);
        continue;
      }

      const detail = await withRateLimitRetry(`Get contact ${summary.email}`, () =>
        resend.contacts.get({ email: summary.email }),
      );

      if (!detail.error && detail.data) {
        const properties = (detail.data as { properties?: Record<string, { value?: string }> })
          .properties;
        const source = properties?.source?.value;
        const clerkUserId = properties?.clerk_user_id?.value;

        if (source === "clerk" && clerkUserId && !validClerkUserIds.has(clerkUserId)) {
          const removed = await withRateLimitRetry(`Remove contact ${summary.email}`, () =>
            resend.contacts.remove({ email: summary.email }),
          );
          if (
            removed.error &&
            removed.error.statusCode !== 404 &&
            removed.error.name !== "not_found"
          ) {
            throw new Error(
              `Failed to remove orphaned Resend contact: ${removed.error.message}`,
            );
          }
          pruned += 1;
        }
      }

      await sleep(CONTACT_SYNC_DELAY_MS);
    }

    if (timedOut) break;
    if (!list.data.has_more) break;
    const last = contacts[contacts.length - 1];
    if (!last) break;
    after = last.id;
  }

  return { pruned, timedOut };
}

export async function syncClerkUsersToAnnouncementAudience(
  options: SyncAnnouncementAudienceOptions = {},
): Promise<AnnouncementAudienceSyncResult> {
  const now = options.now ?? Date.now;
  // The sync sleeps ~800ms per recipient and again per orphan-prune contact, so
  // total runtime is linear in audience size and silently 504s once the audience
  // grows past the function ceiling. A wall-clock budget stops both loops cleanly
  // a margin under maxDuration and returns a partial result; the daily cadence +
  // idempotent re-sync converge the tail over subsequent runs.
  const deadline =
    typeof options.timeBudgetMs === "number" && options.timeBudgetMs > 0
      ? now() + options.timeBudgetMs
      : null;

  const resend = new Resend(requireEnv("RESEND_API_KEY"));
  const users = await fetchClerkAnnouncementUsers();
  // Drop internal non-receiving recipients (firstrun-audit synthetics,
  // @hermesos.cloud / @hivra.cloud placeholders) before syncing — they
  // hard-bounce every broadcast. They fall into the `skipped` count below.
  const recipients = buildAnnouncementRecipients(users).filter(
    (recipient) => !isInternalNonReceivingRecipient(recipient.email),
  );
  const { segmentId, topicId } = await ensureAnnouncementSetup(resend);

  let created = 0;
  let updated = 0;
  let unsubscribed = 0;
  let recipientsProcessed = 0;
  let timedOut = false;

  await sleep(CONTACT_SYNC_DELAY_MS);

  for (const recipient of recipients) {
    if (deadline !== null && now() >= deadline) {
      timedOut = true;
      break;
    }
    const result = await syncAnnouncementRecipient(resend, recipient, segmentId);
    if (result.action === "created") created += 1;
    if (result.action === "updated") updated += 1;
    if (result.unsubscribed) unsubscribed += 1;
    recipientsProcessed += 1;
    await sleep(CONTACT_SYNC_DELAY_MS);
  }

  const validClerkUserIds = new Set(users.map((user) => user.id));
  // Only prune if we still have budget headroom after syncing recipients.
  // Pruning is a separate idempotent pass; if recipients ate the whole budget,
  // skip prune this run rather than risk a SIGKILL mid-remove.
  let pruned = 0;
  if (!timedOut) {
    const pruneResult = await pruneOrphanedClerkContacts(
      resend,
      segmentId,
      validClerkUserIds,
      deadline,
      now,
    );
    pruned = pruneResult.pruned;
    if (pruneResult.timedOut) timedOut = true;
  }

  return {
    clerkUsersFound: users.length,
    recipients: recipients.length,
    created,
    updated,
    unsubscribed,
    skipped: users.length - recipients.length,
    pruned,
    segmentId,
    topicId,
    timedOut,
    recipientsProcessed,
  };
}
