import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import {
  CHAT_JSON_MARKER,
  CHAT_JSON_VERSION,
  CHAT_TEXT_PREFIX,
  isEncryptedChatJsonValue,
  isEncryptedChatTextValue,
  type EncryptedChatJsonMarkerEnvelope,
} from "@/lib/chat-encryption-markers";
import {
  getSecretDecryptKeyCandidates,
  getSecretPrimaryKey,
  type ConfiguredSecretKey,
} from "@/lib/crypto";

const CHAT_ALG = "aes-256-gcm";

export type EncryptedChatJsonEnvelope = EncryptedChatJsonMarkerEnvelope;
export type ChatKeySource =
  | "chat-primary"
  | "chat-legacy"
  | "secret-primary"
  | "secret-legacy"
  | "plaintext";

type ConversationLike = {
  title?: string | null;
};

type MessageLike = {
  content?: string | null;
  tool_calls?: unknown;
  attachments?: unknown;
  artifacts?: unknown;
  metadata?: unknown;
};

type ConfiguredChatKey = {
  key: Buffer;
  keyHex: string;
  source: Exclude<ChatKeySource, "plaintext">;
};

type ResolvedChatCiphertext = {
  plaintext: string;
  keySource: Exclude<ChatKeySource, "plaintext">;
  keyHex: string;
};

function parseChatKey(
  raw: string | undefined,
  envName: string,
  source: Exclude<ChatKeySource, "plaintext">
): ConfiguredChatKey {
  if (!raw) {
    throw new Error(`${envName} env var not set`);
  }

  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${envName} must be 32 bytes (64 hex chars)`);
  }
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error(`${envName} must be 32 bytes (64 hex chars)`);
  }

  return {
    key: buf,
    keyHex: raw,
    source,
  };
}

function asChatSecretKey(secretKey: ConfiguredSecretKey): ConfiguredChatKey {
  return {
    key: secretKey.key,
    keyHex: secretKey.keyHex,
    source: secretKey.source === "primary" ? "secret-primary" : "secret-legacy",
  };
}

function dedupeChatKeys(keys: ConfiguredChatKey[]): ConfiguredChatKey[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    if (seen.has(key.keyHex)) {
      return false;
    }
    seen.add(key.keyHex);
    return true;
  });
}

function getChatWriteKey(): ConfiguredChatKey {
  const raw = process.env.CHAT_ENCRYPTION_KEY;
  if (raw) {
    return parseChatKey(raw, "CHAT_ENCRYPTION_KEY", "chat-primary");
  }

  return asChatSecretKey(getSecretPrimaryKey());
}

function getChatDecryptKeyCandidates(): ConfiguredChatKey[] {
  const candidates: ConfiguredChatKey[] = [];

  if (process.env.CHAT_ENCRYPTION_KEY) {
    candidates.push(parseChatKey(process.env.CHAT_ENCRYPTION_KEY, "CHAT_ENCRYPTION_KEY", "chat-primary"));
  }

  if (process.env.CHAT_ENCRYPTION_KEY_LEGACY) {
    candidates.push(
      parseChatKey(process.env.CHAT_ENCRYPTION_KEY_LEGACY, "CHAT_ENCRYPTION_KEY_LEGACY", "chat-legacy")
    );
  }

  candidates.push(...getSecretDecryptKeyCandidates().map(asChatSecretKey));

  return dedupeChatKeys(candidates);
}

function encryptRawWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CHAT_ALG, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptRawWithSource(ciphertext: string): ResolvedChatCiphertext {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  let lastError: unknown;

  for (const candidate of getChatDecryptKeyCandidates()) {
    try {
      const decipher = createDecipheriv(CHAT_ALG, candidate.key, iv);
      decipher.setAuthTag(tag);
      return {
        plaintext: Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
        keySource: candidate.source,
        keyHex: candidate.keyHex,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to decrypt chat payload");
}

export function isEncryptedChatText(value: unknown): value is string {
  return isEncryptedChatTextValue(value);
}

export function encryptStoredChatText(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (isEncryptedChatText(value)) return value;
  return `${CHAT_TEXT_PREFIX}${encryptRawWithKey(value, getChatWriteKey().key)}`;
}

export function decryptStoredChatText(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!isEncryptedChatText(value)) return value;
  return decryptRawWithSource(value.slice(CHAT_TEXT_PREFIX.length)).plaintext;
}

export function isEncryptedChatJson(value: unknown): value is EncryptedChatJsonEnvelope {
  return isEncryptedChatJsonValue(value);
}

export function encryptStoredChatJson<T>(value: T): T | EncryptedChatJsonEnvelope {
  if (value == null) return value;
  if (isEncryptedChatJson(value)) return value;
  return {
    [CHAT_JSON_MARKER]: CHAT_JSON_VERSION,
    blob: encryptRawWithKey(JSON.stringify(value), getChatWriteKey().key),
  };
}

export function decryptStoredChatJson<T>(value: unknown): T {
  if (!isEncryptedChatJson(value)) return value as T;
  return JSON.parse(decryptRawWithSource(value.blob).plaintext) as T;
}

export function reencryptStoredChatText(value: string | null | undefined): {
  value: string | null;
  changed: boolean;
  keySource: ChatKeySource;
} {
  if (value == null) {
    return { value: null, changed: false, keySource: "plaintext" };
  }

  if (!isEncryptedChatText(value)) {
    return {
      value: encryptStoredChatText(value),
      changed: true,
      keySource: "plaintext",
    };
  }

  const decrypted = decryptRawWithSource(value.slice(CHAT_TEXT_PREFIX.length));
  const writeKey = getChatWriteKey();

  if (decrypted.keyHex === writeKey.keyHex) {
    return {
      value,
      changed: false,
      keySource: decrypted.keySource,
    };
  }

  return {
    value: `${CHAT_TEXT_PREFIX}${encryptRawWithKey(decrypted.plaintext, writeKey.key)}`,
    changed: true,
    keySource: decrypted.keySource,
  };
}

export function reencryptStoredChatJson<T>(value: T): {
  value: T | EncryptedChatJsonEnvelope;
  changed: boolean;
  keySource: ChatKeySource;
} {
  if (value == null) {
    return { value, changed: false, keySource: "plaintext" };
  }

  if (!isEncryptedChatJson(value)) {
    return {
      value: encryptStoredChatJson(value),
      changed: true,
      keySource: "plaintext",
    };
  }

  const decrypted = decryptRawWithSource(value.blob);
  const writeKey = getChatWriteKey();

  if (decrypted.keyHex === writeKey.keyHex) {
    return {
      value,
      changed: false,
      keySource: decrypted.keySource,
    };
  }

  return {
    value: {
      [CHAT_JSON_MARKER]: CHAT_JSON_VERSION,
      blob: encryptRawWithKey(decrypted.plaintext, writeKey.key),
    },
    changed: true,
    keySource: decrypted.keySource,
  };
}

export function decryptStoredConversation<T extends ConversationLike>(conversation: T): T {
  return {
    ...conversation,
    ...(conversation.title !== undefined
      ? { title: decryptStoredChatText(conversation.title) }
      : {}),
  };
}

export function decryptStoredMessage<T extends MessageLike>(message: T): T {
  return {
    ...message,
    ...(message.content !== undefined
      ? { content: decryptStoredChatText(message.content) }
      : {}),
    ...(message.tool_calls !== undefined
      ? { tool_calls: decryptStoredChatJson(message.tool_calls) }
      : {}),
    ...(message.attachments !== undefined
      ? { attachments: decryptStoredChatJson(message.attachments) }
      : {}),
    ...(message.artifacts !== undefined
      ? { artifacts: decryptStoredChatJson(message.artifacts) }
      : {}),
    ...(message.metadata !== undefined
      ? { metadata: decryptStoredChatJson(message.metadata) }
      : {}),
  };
}
