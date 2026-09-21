/**
 * Send invite emails for queued reservations and flip status to "invited".
 *
 * Defaults to a dry run. Pass --execute to actually send and update.
 *
 * Examples:
 *   npm run reserve:invite -- --limit=5
 *   npm run reserve:invite -- --execute --limit=20
 *   npm run reserve:invite -- --execute --emails=a@x.com,b@y.com
 *   npm run reserve:invite -- --execute --ids=uuid1,uuid2
 *
 * Filters:
 *   --limit=N     Max rows to process (default 10). Ignored when --ids or --emails is set.
 *   --ids=...     Comma-separated reservation IDs to target.
 *   --emails=...  Comma-separated emails to target (case-insensitive).
 *
 * Behavior:
 *   - Only queued reservations are eligible. Rows in any other status are skipped.
 *   - For each row: send the invite email; on success update
 *     status='invited' and stamp notes.invited_at. On send failure the
 *     row is left untouched so the next run can retry.
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

import { sendReservationInvite } from "../src/lib/email/reservation-invite";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

type Options = {
  execute: boolean;
  limit: number;
  ids: string[] | null;
  emails: string[] | null;
};

type ReservationRow = {
  id: string;
  email: string;
  position: number;
  tier_intent: string;
  status: string;
  notes: Record<string, unknown> | null;
};

function parseList(value: string | undefined): string[] | null {
  if (!value) return null;
  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const idsArg = args.find((arg) => arg.startsWith("--ids="));
  const emailsArg = args.find((arg) => arg.startsWith("--emails="));

  const ids = parseList(idsArg?.slice("--ids=".length));
  const emails = parseList(emailsArg?.slice("--emails=".length))?.map((email) =>
    email.toLowerCase()
  ) ?? null;

  return {
    execute: args.includes("--execute"),
    limit: limitArg ? Number(limitArg.slice("--limit=".length)) : 10,
    ids,
    emails,
  };
}

function assertValidOptions(options: Options) {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function fetchEligible(options: Options): Promise<ReservationRow[]> {
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let query = supabase
    .from("reservations")
    .select("id, email, position, tier_intent, status, notes")
    .eq("status", "queued")
    .order("position", { ascending: true });

  if (options.ids && options.ids.length > 0) {
    query = query.in("id", options.ids);
  } else if (options.emails && options.emails.length > 0) {
    query = query.in("email", options.emails);
  } else {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  return (data ?? []) as ReservationRow[];
}

async function markInvited(row: ReservationRow): Promise<void> {
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const nextNotes = {
    ...(row.notes ?? {}),
    invited_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("reservations")
    .update({ status: "invited", notes: nextNotes })
    .eq("id", row.id)
    .eq("status", "queued");

  if (error) {
    throw new Error(`Failed to flip status for ${row.id}: ${error.message}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  assertValidOptions(options);

  const rows = await fetchEligible(options);

  console.log(
    `[reservation-invites] mode=${options.execute ? "execute" : "dry-run"} eligible=${rows.length}`
  );

  if (rows.length === 0) {
    console.log("[reservation-invites] nothing to do");
    return;
  }

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const summary = `#${row.position} ${row.email} (tier=${row.tier_intent})`;

    if (!options.execute) {
      console.log(`[dry-run] would invite ${summary}`);
      continue;
    }

    const result = await sendReservationInvite({ email: row.email });
    if (!result.sent) {
      failed += 1;
      console.error(
        `[reservation-invites] send failed for ${summary}: reason=${result.reason ?? "unknown"} message=${result.errorMessage ?? ""}`
      );
      continue;
    }

    try {
      await markInvited(row);
      sent += 1;
      console.log(`[reservation-invites] invited ${summary}`);
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[reservation-invites] email sent but status flip failed for ${summary}: ${msg}`
      );
    }
  }

  console.log(
    `[reservation-invites] done sent=${sent} failed=${failed} skipped=${rows.length - sent - failed}`
  );
}

main().catch((err) => {
  console.error("[reservation-invites] fatal:", err);
  process.exit(1);
});
