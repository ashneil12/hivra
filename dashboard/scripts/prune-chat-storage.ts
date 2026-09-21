import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";
import { decryptStoredChatJson, encryptStoredChatJson } from "../src/lib/chat-crypto";
import { sanitizeAttachmentsForPersistence } from "../src/lib/chat-attachments";

// SCRIPTURE_ANCHOR: prune-fruit | John 15:2 | Verse: Every branch that bears fruit, he prunes, that it may bear more fruit.
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

type MessageRow = {
  id: string;
  attachments: unknown;
};

type StreamJobRow = {
  id: string;
  stream_request: unknown;
  fallback_request: unknown;
};

type SupabaseScriptClient = {
  // The ops script intentionally works across tables without generated DB types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
};

type Args = {
  apply: boolean;
  batchSize: number;
  limit: number;
  skipMessages: boolean;
  skipJobs: boolean;
};

const FINALIZED_REQUEST_PAYLOAD = { finalized: true };

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    batchSize: 250,
    limit: Number.POSITIVE_INFINITY,
    skipMessages: false,
    skipJobs: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    if (arg === "--skip-messages") args.skipMessages = true;
    if (arg === "--skip-jobs") args.skipJobs = true;
    if (arg === "--batch-size") {
      args.batchSize = Math.max(1, Number(argv[index + 1] || args.batchSize));
      index += 1;
    }
    if (arg === "--limit") {
      args.limit = Math.max(1, Number(argv[index + 1] || args.limit));
      index += 1;
    }
  }

  return args;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function changedJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

async function pruneMessages(
  db: SupabaseScriptClient,
  args: Args
): Promise<{ scanned: number; changed: number; beforeBytes: number; afterBytes: number; errors: number }> {
  let scanned = 0;
  let changed = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  let errors = 0;

  for (let offset = 0; scanned < args.limit; offset += args.batchSize) {
    const batchLimit = Math.min(args.batchSize, args.limit - scanned);
    const { data, error } = await db
      .from("hermes_messages")
      .select("id,attachments")
      .order("created_at", { ascending: true })
      .range(offset, offset + batchLimit - 1);

    if (error) {
      throw new Error(`Failed to fetch hermes_messages: ${error.message}`);
    }

    const rows = (data || []) as MessageRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;

      try {
        const current = decryptStoredChatJson<unknown>(row.attachments);
        const sanitized = sanitizeAttachmentsForPersistence(current);
        const currentBytes = jsonBytes(current);
        const sanitizedBytes = jsonBytes(sanitized);

        beforeBytes += currentBytes;
        afterBytes += sanitizedBytes;

        if (!changedJson(current, sanitized)) continue;
        changed += 1;

        if (args.apply) {
          const { error: updateError } = await db
            .from("hermes_messages")
            .update({ attachments: encryptStoredChatJson(sanitized) })
            .eq("id", row.id);

          if (updateError) {
            throw new Error(updateError.message);
          }
        }
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Skipping message ${row.id}: ${message}`);
      }
    }

    if (rows.length < batchLimit) break;
  }

  return { scanned, changed, beforeBytes, afterBytes, errors };
}

async function pruneFinalizedJobs(
  db: SupabaseScriptClient,
  args: Args
): Promise<{ scanned: number; changed: number; beforeBytes: number; afterBytes: number; errors: number }> {
  let scanned = 0;
  let changed = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  let errors = 0;

  for (let offset = 0; scanned < args.limit; offset += args.batchSize) {
    const batchLimit = Math.min(args.batchSize, args.limit - scanned);
    const { data, error } = await db
      .from("hermes_chat_stream_jobs")
      .select("id,stream_request,fallback_request")
      .in("status", ["completed", "failed", "stopped"])
      .order("created_at", { ascending: true })
      .range(offset, offset + batchLimit - 1);

    if (error) {
      throw new Error(`Failed to fetch hermes_chat_stream_jobs: ${error.message}`);
    }

    const rows = (data || []) as StreamJobRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;

      try {
        const currentStreamRequest = decryptStoredChatJson<unknown>(row.stream_request);
        const currentFallbackRequest = decryptStoredChatJson<unknown>(row.fallback_request);
        const currentBytes = jsonBytes(currentStreamRequest) + jsonBytes(currentFallbackRequest);
        const nextBytes = jsonBytes(FINALIZED_REQUEST_PAYLOAD) * 2;

        beforeBytes += currentBytes;
        afterBytes += nextBytes;

        if (
          !changedJson(currentStreamRequest, FINALIZED_REQUEST_PAYLOAD) &&
          !changedJson(currentFallbackRequest, FINALIZED_REQUEST_PAYLOAD)
        ) {
          continue;
        }

        changed += 1;

        if (args.apply) {
          const { error: updateError } = await db
            .from("hermes_chat_stream_jobs")
            .update({
              stream_request: encryptStoredChatJson(FINALIZED_REQUEST_PAYLOAD),
              fallback_request: encryptStoredChatJson(FINALIZED_REQUEST_PAYLOAD),
            })
            .eq("id", row.id);

          if (updateError) {
            throw new Error(updateError.message);
          }
        }
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Skipping stream job ${row.id}: ${message}`);
      }
    }

    if (rows.length < batchLimit) break;
  }

  return { scanned, changed, beforeBytes, afterBytes, errors };
}

function printSummary(label: string, result: Awaited<ReturnType<typeof pruneMessages>>) {
  const savedBytes = Math.max(0, result.beforeBytes - result.afterBytes);
  console.log(`${label}:`);
  console.log(`  scanned: ${result.scanned}`);
  console.log(`  changed: ${result.changed}`);
  console.log(`  errors: ${result.errors}`);
  console.log(`  before: ${formatBytes(result.beforeBytes)}`);
  console.log(`  after: ${formatBytes(result.afterBytes)}`);
  console.log(`  estimated logical savings: ${formatBytes(savedBytes)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  console.log(args.apply ? "Applying chat storage pruning." : "Dry run only. Re-run with --apply to update rows.");

  if (!args.skipMessages) {
    printSummary("hermes_messages attachments", await pruneMessages(db, args));
  }

  if (!args.skipJobs) {
    printSummary("finalized hermes_chat_stream_jobs requests", await pruneFinalizedJobs(db, args));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
