import {
  CHAT_JSON_MARKER,
  CHAT_JSON_VERSION,
  CHAT_TEXT_PREFIX,
  isEncryptedChatJsonValue,
  isEncryptedChatTextValue,
} from "@/lib/chat-encryption-markers";

describe("chat-encryption-markers", () => {
  it("detects encrypted chat text prefixes", () => {
    expect(isEncryptedChatTextValue(`${CHAT_TEXT_PREFIX}ciphertext`)).toBe(true);
    expect(isEncryptedChatTextValue("plain text")).toBe(false);
  });

  it("detects encrypted chat json envelopes", () => {
    expect(
      isEncryptedChatJsonValue({
        [CHAT_JSON_MARKER]: CHAT_JSON_VERSION,
        blob: "ciphertext",
      })
    ).toBe(true);
    expect(isEncryptedChatJsonValue({ blob: "ciphertext" })).toBe(false);
  });
});
