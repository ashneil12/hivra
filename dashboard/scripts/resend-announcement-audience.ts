import { Resend } from "resend";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const CLERK_API_BASE_URL = "https://api.clerk.com/v1";
const CLERK_PAGE_SIZE = 100;
const CONTACT_SYNC_DELAY_MS = 800;
const RATE_LIMIT_RETRY_MS = 1_500;
const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_SEGMENT_NAME = "Hermes OS customers";
const DEFAULT_TOPIC_NAME = "Product updates";
const DEFAULT_TOPIC_DESCRIPTION =
  "Product announcements, launch notes, customer updates, and other Hermes OS news.";
const CONTACT_PROPERTIES = [
  { key: "clerk_user_id", type: "string" as const },
  { key: "clerk_created_at", type: "string" as const },
  { key: "source", type: "string" as const },
];

type Options = {
  apply: boolean;
  limit: number | null;
  testRecipient: string | null;
  segmentName: string;
  topicName: string;
  topicDescription: string;
};

type ClerkEmailAddress = {
  id: string;
  email_address: string;
  verification?: {
    status?: string;
  } | null;
};

type ClerkUser = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  created_at?: number | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
};

type Recipient = {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
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

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const toArg = args.find((arg) => arg.startsWith("--to="));
  const segmentArg = args.find((arg) => arg.startsWith("--segment="));
  const topicArg = args.find((arg) => arg.startsWith("--topic="));
  const topicDescriptionArg = args.find((arg) => arg.startsWith("--topic-description="));

  return {
    apply: args.includes("--apply"),
    limit: limitArg ? Number(limitArg.split("=")[1]) : null,
    testRecipient: toArg ? toArg.slice("--to=".length).trim().toLowerCase() : null,
    segmentName:
      segmentArg?.slice("--segment=".length).trim() ||
      process.env.RESEND_ANNOUNCEMENT_SEGMENT?.trim() ||
      DEFAULT_SEGMENT_NAME,
    topicName:
      topicArg?.slice("--topic=".length).trim() ||
      process.env.RESEND_ANNOUNCEMENT_TOPIC?.trim() ||
      DEFAULT_TOPIC_NAME,
    topicDescription:
      topicDescriptionArg?.slice("--topic-description=".length).trim() ||
      process.env.RESEND_ANNOUNCEMENT_TOPIC_DESCRIPTION?.trim() ||
      DEFAULT_TOPIC_DESCRIPTION,
  };
}

function assertValidOptions(options: Options) {
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }

  if (options.testRecipient && !options.testRecipient.includes("@")) {
    throw new Error("--to must be an email address");
  }

  if (!options.segmentName) {
    throw new Error("--segment must not be empty");
  }

  if (!options.topicName) {
    throw new Error("--topic must not be empty");
  }
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "[invalid email]";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function chooseEmail(user: ClerkUser) {
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
    console.log(`${label} hit Resend rate limit. Waiting ${waitMs}ms before retrying.`);
    await sleep(waitMs);
  }

  return operation();
}

async function fetchClerkUsers(secretKey: string) {
  const users: ClerkUser[] = [];

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
      const responseText = await response.text();
      throw new Error(`Failed to fetch Clerk users: ${response.status} ${responseText}`);
    }

    const page = (await response.json()) as ClerkUser[];
    users.push(...page);

    if (page.length < CLERK_PAGE_SIZE) break;
  }

  return users;
}

function buildRecipients(users: ClerkUser[], options: Options) {
  const recipients: Recipient[] = [];
  const seenEmails = new Set<string>();

  for (const user of users) {
    const email = chooseEmail(user)?.trim().toLowerCase();
    if (!email || seenEmails.has(email)) continue;
    seenEmails.add(email);
    recipients.push({
      userId: user.id,
      email,
      firstName: user.first_name?.trim() || null,
      lastName: user.last_name?.trim() || null,
      clerkCreatedAt: formatClerkCreatedAt(user.created_at),
    });
  }

  const scoped = options.testRecipient
    ? recipients.filter((recipient) => recipient.email === options.testRecipient)
    : recipients;

  return options.limit === null ? scoped : scoped.slice(0, options.limit);
}

async function ensureSegment(resend: Resend, name: string, apply: boolean) {
  const existing = await withRateLimitRetry("List segments", () =>
    resend.segments.list({ limit: 100 }),
  );
  if (existing.error) {
    throw new Error(`Failed to list Resend segments: ${existing.error.message}`);
  }

  const segment = existing.data.data.find((item) => item.name === name);
  if (segment) return { id: segment.id, created: false };

  if (!apply) return { id: "[dry-run-segment-id]", created: true };

  const created = await withRateLimitRetry(`Create segment ${name}`, () =>
    resend.segments.create({ name }),
  );
  if (created.error) {
    throw new Error(`Failed to create Resend segment "${name}": ${created.error.message}`);
  }

  return { id: created.data.id, created: true };
}

async function ensureTopic(
  resend: Resend,
  name: string,
  description: string,
  apply: boolean,
) {
  const existing = await withRateLimitRetry("List topics", () => resend.topics.list());
  if (existing.error) {
    throw new Error(`Failed to list Resend topics: ${existing.error.message}`);
  }

  const topic = existing.data.data.find((item) => item.name === name);
  if (topic) {
    if (apply && topic.description !== description) {
      const updated = await withRateLimitRetry(`Update topic ${name}`, () =>
        resend.topics.update({ id: topic.id, name, description }),
      );
      if (updated.error) {
        throw new Error(`Failed to update Resend topic "${name}": ${updated.error.message}`);
      }
    }

    return {
      id: topic.id,
      created: false,
      defaultSubscription: topic.default_subscription,
    };
  }

  if (!apply) {
    return {
      id: "[dry-run-topic-id]",
      created: true,
      defaultSubscription: "opt_in",
    };
  }

  const created = await withRateLimitRetry(`Create topic ${name}`, () =>
    resend.topics.create({
      name,
      description,
      defaultSubscription: "opt_in",
    }),
  );
  if (created.error) {
    throw new Error(`Failed to create Resend topic "${name}": ${created.error.message}`);
  }

  return {
    id: created.data.id,
    created: true,
    defaultSubscription: "opt_in",
  };
}

async function ensureContactProperties(resend: Resend, apply: boolean) {
  const existing = await withRateLimitRetry("List contact properties", () =>
    resend.contactProperties.list({ limit: 100 }),
  );
  if (existing.error) {
    throw new Error(`Failed to list Resend contact properties: ${existing.error.message}`);
  }

  const existingKeys = new Set(existing.data.data.map((property) => property.key));
  const missing = CONTACT_PROPERTIES.filter((property) => !existingKeys.has(property.key));

  if (!apply || missing.length === 0) {
    return { created: apply ? 0 : missing.length, missing };
  }

  let created = 0;
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

    created += 1;
    await sleep(CONTACT_SYNC_DELAY_MS);
  }

  return { created, missing };
}

async function getContactByEmail(resend: Resend, email: string) {
  const response = await withRateLimitRetry(`Get contact ${maskEmail(email)}`, () =>
    resend.contacts.get({ email }),
  );
  if (response.error) {
    if (response.error.statusCode === 404 || response.error.name === "not_found") {
      return null;
    }

    throw new Error(`Failed to get Resend contact ${maskEmail(email)}: ${response.error.message}`);
  }

  return response.data as ResendContact;
}

async function syncContact(resend: Resend, recipient: Recipient, segmentId: string) {
  const existing = await getContactByEmail(resend, recipient.email);
  const properties = {
    clerk_user_id: recipient.userId,
    clerk_created_at: recipient.clerkCreatedAt,
    source: "clerk",
  };

  if (!existing) {
    const created = await withRateLimitRetry(`Create contact ${maskEmail(recipient.email)}`, () =>
      resend.contacts.create({
        email: recipient.email,
        firstName: recipient.firstName || undefined,
        lastName: recipient.lastName || undefined,
        properties,
        segments: [{ id: segmentId }],
      }),
    );

    if (created.error) {
      throw new Error(
        `Failed to create Resend contact ${maskEmail(recipient.email)}: ${created.error.message}`,
      );
    }

    return { action: "created", unsubscribed: false };
  }

  const updated = await withRateLimitRetry(`Update contact ${maskEmail(recipient.email)}`, () =>
    resend.contacts.update({
      email: recipient.email,
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      properties,
    }),
  );

  if (updated.error) {
    throw new Error(
      `Failed to update Resend contact ${maskEmail(recipient.email)}: ${updated.error.message}`,
    );
  }

  const added = await withRateLimitRetry(
    `Add contact ${maskEmail(recipient.email)} to segment`,
    () =>
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
    throw new Error(
      `Failed to add Resend contact ${maskEmail(recipient.email)} to segment: ${added.error.message}`,
    );
  }

  return { action: "updated", unsubscribed: existing.unsubscribed };
}

async function main() {
  const options = parseOptions();
  assertValidOptions(options);

  const clerkSecretKey = requireEnv("CLERK_SECRET_KEY");
  const resendApiKey = requireEnv("RESEND_API_KEY");
  const resend = new Resend(resendApiKey);

  const users = await fetchClerkUsers(clerkSecretKey);
  const recipients = buildRecipients(users, options);

  console.log(`${options.apply ? "Applying" : "Dry run"} Resend announcement audience setup.`);
  console.log(`Clerk users found: ${users.length}`);
  console.log(`Recipients after email dedupe/filtering: ${recipients.length}`);
  console.log(`Segment: ${options.segmentName}`);
  console.log(`Topic: ${options.topicName}`);

  const segment = await ensureSegment(resend, options.segmentName, options.apply);
  const topic = await ensureTopic(
    resend,
    options.topicName,
    options.topicDescription,
    options.apply,
  );
  const contactProperties = await ensureContactProperties(resend, options.apply);

  console.log(
    `${segment.created ? "Created" : "Found"} segment: ${options.segmentName} (${segment.id})`,
  );
  console.log(
    `${topic.created ? "Created" : "Found"} topic: ${options.topicName} (${topic.id}, ${topic.defaultSubscription})`,
  );
  console.log(
    `${options.apply ? "Created" : "Would create"} contact properties: ${contactProperties.created}`,
  );

  if (!options.apply) {
    console.log("Preview recipients:");
    for (const recipient of recipients.slice(0, 10)) {
      console.log(`- ${maskEmail(recipient.email)} (${recipient.userId})`);
    }
    console.log("No Resend contacts were changed. Re-run with --apply to sync contacts.");
    return;
  }

  let created = 0;
  let updated = 0;
  let unsubscribed = 0;

  await sleep(CONTACT_SYNC_DELAY_MS);

  for (const recipient of recipients) {
    const result = await syncContact(resend, recipient, segment.id);
    if (result.action === "created") created += 1;
    if (result.action === "updated") updated += 1;
    if (result.unsubscribed) unsubscribed += 1;
    await sleep(CONTACT_SYNC_DELAY_MS);
  }

  console.log(`Done. Created: ${created}. Updated: ${updated}. Already globally unsubscribed: ${unsubscribed}.`);
  console.log("Future announcement Broadcasts should use this segment and topic so Resend handles opt-outs.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
