import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import {
  encryptStoredChatJson,
  encryptStoredChatText,
  isEncryptedChatJson,
  isEncryptedChatText,
} from "../src/lib/chat-crypto";

loadEnvConfig(process.cwd());

type ConversationRow = {
  id: string;
  title: string | null;
};

type MessageRow = {
  id: string;
  content: string | null;
  tool_calls: unknown;
  attachments: unknown;
  artifacts: unknown;
  metadata: unknown;
};

type Args = {
  dryRun: boolean;
  batchSize: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    batchSize: 200,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--batch-size") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("`--batch-size` must be a positive number");
      }
      args.batchSize = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function buildConversationUpdate(row: ConversationRow): Record<string, unknown> {
  const update: Record<string, unknown> = {};

  if (row.title != null && !isEncryptedChatText(row.title)) {
    update.title = encryptStoredChatText(row.title);
  }

  return update;
}

function buildMessageUpdate(row: MessageRow): Record<string, unknown> {
  const update: Record<string, unknown> = {};

  if (row.content != null && !isEncryptedChatText(row.content)) {
    update.content = encryptStoredChatText(row.content);
  }
  if (row.tool_calls != null && !isEncryptedChatJson(row.tool_calls)) {
    update.tool_calls = encryptStoredChatJson(row.tool_calls);
  }
  if (row.attachments != null && !isEncryptedChatJson(row.attachments)) {
    update.attachments = encryptStoredChatJson(row.attachments);
  }
  if (row.artifacts != null && !isEncryptedChatJson(row.artifacts)) {
    update.artifacts = encryptStoredChatJson(row.artifacts);
  }
  if (row.metadata != null && !isEncryptedChatJson(row.metadata)) {
    update.metadata = encryptStoredChatJson(row.metadata);
  }

  return update;
}

async function main() {
  const { dryRun, batchSize } = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  let conversationOffset = 0;
  let messageOffset = 0;
  let encryptedConversationCount = 0;
  let encryptedMessageCount = 0;

  console.log(
    `${dryRun ? "Dry run:" : "Starting:"} backfilling encrypted chat storage with batch size ${batchSize}`
  );

  while (true) {
    const { data, error } = await supabase
      .from("hermes_conversations")
      .select("id,title")
      .order("id", { ascending: true })
      .range(conversationOffset, conversationOffset + batchSize - 1);

    if (error) {
      throw error;
    }

    if (!data?.length) {
      break;
    }

    for (const conversation of data as ConversationRow[]) {
      const update = buildConversationUpdate(conversation);
      if (Object.keys(update).length === 0) continue;

      encryptedConversationCount += 1;
      if (!dryRun) {
        const { error: updateError } = await supabase
          .from("hermes_conversations")
          .update(update)
          .eq("id", conversation.id);
        if (updateError) {
          throw updateError;
        }
      }
    }

    conversationOffset += data.length;
  }

  while (true) {
    const { data, error } = await supabase
      .from("hermes_messages")
      .select("id,content,tool_calls,attachments,artifacts,metadata")
      .order("id", { ascending: true })
      .range(messageOffset, messageOffset + batchSize - 1);

    if (error) {
      throw error;
    }

    if (!data?.length) {
      break;
    }

    for (const message of data as MessageRow[]) {
      const update = buildMessageUpdate(message);
      if (Object.keys(update).length === 0) continue;

      encryptedMessageCount += 1;
      if (!dryRun) {
        const { error: updateError } = await supabase
          .from("hermes_messages")
          .update(update)
          .eq("id", message.id);
        if (updateError) {
          throw updateError;
        }
      }
    }

    messageOffset += data.length;
  }

  console.log(
    [
      `${dryRun ? "Would encrypt" : "Encrypted"} conversations: ${encryptedConversationCount}`,
      `${dryRun ? "Would encrypt" : "Encrypted"} messages: ${encryptedMessageCount}`,
    ].join("\n")
  );
}

main().catch((error) => {
  console.error("Chat encryption backfill failed:", error);
  process.exit(1);
});
