import { Resend } from "resend";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const CLERK_API_BASE_URL = "https://api.clerk.com/v1";
const CLERK_PAGE_SIZE = 100;
const SEND_DELAY_MS = 250;

const SUBJECT = "Trial extension";

const TEXT_BODY = `Hey,

I’ve extended all Hermes OS trials by an additional 14 days.

If you’re currently on a trial, you now have more time to test the platform, build your setup, and run it in a real workflow.

For existing paid users, the next billing date has also been moved back by 14 days.

If you signed up but haven’t subscribed yet, the same extension can be applied once you start. Just reply and I’ll add it manually.

The platform is evolving quickly, so this gives more room to work with the latest changes without being constrained by billing timing.

Ash
HermesOS`;

type Options = {
  dryRun: boolean;
  limit: number | null;
  testRecipient: string | null;
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
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
};

type Recipient = {
  userId: string;
  email: string;
};

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const toArg = args.find((arg) => arg.startsWith("--to="));

  return {
    dryRun: !args.includes("--send"),
    limit: limitArg ? Number(limitArg.split("=")[1]) : null,
    testRecipient: toArg ? toArg.slice("--to=".length).trim().toLowerCase() : null,
  };
}

function assertValidOptions(options: Options) {
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }

  if (options.testRecipient && !options.testRecipient.includes("@")) {
    throw new Error("--to must be an email address");
  }
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderHtml(body: string) {
  const paragraphs = body
    .split("\n\n")
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("\n");

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;">
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      ${paragraphs}
    </div>
  </body>
</html>`;
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
    recipients.push({ userId: user.id, email });
  }

  const scoped = options.testRecipient
    ? recipients.filter((recipient) => recipient.email === options.testRecipient)
    : recipients;

  return options.limit === null ? scoped : scoped.slice(0, options.limit);
}

function buildIdempotencyKey(recipient: Recipient) {
  return `trial-extension-2026-04-25/${recipient.userId}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseOptions();
  assertValidOptions(options);

  const clerkSecretKey = requireEnv("CLERK_SECRET_KEY");
  const resendApiKey = requireEnv("RESEND_API_KEY");
  const from = requireEnv("RESEND_FROM_EMAIL");
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL?.trim() || "info@hermesos.cloud";

  const users = await fetchClerkUsers(clerkSecretKey);
  const recipients = buildRecipients(users, options);
  const html = renderHtml(TEXT_BODY);

  console.log(`${options.dryRun ? "Dry run" : "Sending"} trial extension email.`);
  console.log(`Clerk users found: ${users.length}`);
  console.log(`Recipients after email dedupe/filtering: ${recipients.length}`);
  console.log(`From: ${from}`);
  console.log(`Reply-to: ${replyTo}`);
  console.log(`Subject: ${SUBJECT}`);
  console.log("Preview recipients:");
  for (const recipient of recipients.slice(0, 10)) {
    console.log(`- ${maskEmail(recipient.email)} (${recipient.userId})`);
  }

  if (options.dryRun) {
    console.log("No emails were sent. Re-run with --send to send this campaign.");
    return;
  }

  const resend = new Resend(resendApiKey);
  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    const { data, error } = await resend.emails.send({
      from,
      to: [recipient.email],
      subject: SUBJECT,
      text: TEXT_BODY,
      html,
      replyTo,
    }, {
      idempotencyKey: buildIdempotencyKey(recipient),
    });

    if (error) {
      failed += 1;
      console.error(`Failed ${maskEmail(recipient.email)}: ${error.name} ${error.message}`);
    } else {
      sent += 1;
      console.log(`Sent ${maskEmail(recipient.email)}: ${data?.id || "unknown_id"}`);
    }

    await sleep(SEND_DELAY_MS);
  }

  console.log(`Done. Sent: ${sent}. Failed: ${failed}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
