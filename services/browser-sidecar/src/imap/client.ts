import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Config } from "../config.js";
import { IMAP_MAX_POLL_MS } from "../config.js";
import type { Logger } from "../logger.js";

// SCRIPTURE_ANCHOR: mail-answer | Proverbs 15:23 | Verse: Joy comes to a man with the reply of his mouth. How good is a word at the right time!
// Verification-code regex. Six digits, separated by word boundaries.
// Tightening this further (e.g. exact 6-digit-only) is fine; loosening risks false matches.
const CODE_RE = /\b(\d{6})\b/;

export interface FetchCodeOptions {
  subjectPattern?: string;
  since?: number;
}

// Polls the inbox for a verification code message. Hard-clamped to IMAP_MAX_POLL_MS.
//
// Credential discipline:
//   - IMAP_USER / IMAP_PASS read from `config` (which read from env on init).
//   - Never logged. The pino redact list also covers them, but we don't even
//     pass them into a log object.
//   - On any error path we log only the *type* of failure, not the underlying
//     message (which IMAP libraries occasionally include the URI in).
export async function fetchVerificationCode(
  config: Config,
  logger: Logger,
  opts: FetchCodeOptions = {},
): Promise<string> {
  if (!config.IMAP_HOST || !config.IMAP_USER || !config.IMAP_PASS) {
    throw new Error("IMAP not configured (IMAP_HOST/USER/PASS)");
  }

  const subjectRegex = new RegExp(opts.subjectPattern ?? config.IMAP_CODE_SUBJECT_PATTERN, "i");
  const since = new Date(opts.since ?? Date.now() - 5 * 60_000);

  // Hard cap: regardless of caller intent, we do not poll longer than IMAP_MAX_POLL_MS.
  const deadline = Date.now() + IMAP_MAX_POLL_MS;
  const pollIntervalMs = 3_000;

  const client = new ImapFlow({
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    secure: config.IMAP_TLS,
    auth: { user: config.IMAP_USER, pass: config.IMAP_PASS },
    logger: false, // do not let imapflow write its own debug logs (could include creds in URIs)
  });

  try {
    await client.connect();
  } catch {
    // Deliberately do not log the underlying error message — imapflow has been
    // known to include the connection URI (with creds) in some error paths.
    throw new Error("IMAP_CONNECT_FAILED");
  }

  try {
    while (Date.now() < deadline) {
      const code = await scanOnce(client, config.IMAP_MAILBOX, subjectRegex, since);
      if (code) {
        logger.info({ source: "imap", subject_pattern: subjectRegex.source }, "verification code found");
        return code;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining));
    }
    throw new Error("IMAP_CODE_TIMEOUT");
  } finally {
    try {
      await client.logout();
    } catch {
      // swallow — we tried, the connection is going away anyway
    }
  }
}

async function scanOnce(
  client: ImapFlow,
  mailbox: string,
  subjectRegex: RegExp,
  since: Date,
): Promise<string | undefined> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    for await (const msg of client.fetch({ since }, { envelope: true, source: true, uid: true })) {
      const subject = msg.envelope?.subject ?? "";
      if (!subjectRegex.test(subject)) continue;

      // Try the subject first — many providers include the code in the subject line.
      const inSubject = subject.match(CODE_RE);
      if (inSubject) return inSubject[1];

      // Then parse the body. simpleParser handles MIME, HTML→text, etc.
      if (msg.source) {
        const parsed = await simpleParser(msg.source);
        const text = parsed.text ?? "";
        const inBody = text.match(CODE_RE);
        if (inBody) return inBody[1];
      }
    }
  } finally {
    lock.release();
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
