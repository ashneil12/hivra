export const CHAT_TEXT_PREFIX = "enc:v1:";
export const CHAT_JSON_MARKER = "__hermes_chat_enc";
export const CHAT_JSON_VERSION = "v1";

export type EncryptedChatJsonMarkerEnvelope = {
  __hermes_chat_enc: typeof CHAT_JSON_VERSION;
  blob: string;
};

export function isEncryptedChatTextValue(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(CHAT_TEXT_PREFIX);
}

export function isEncryptedChatJsonValue(value: unknown): value is EncryptedChatJsonMarkerEnvelope {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>)[CHAT_JSON_MARKER] === CHAT_JSON_VERSION &&
      typeof (value as Record<string, unknown>).blob === "string"
  );
}
