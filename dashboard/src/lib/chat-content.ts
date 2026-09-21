// SCRIPTURE_ANCHOR: chat-words | Proverbs 16:24 | Verse: Pleasant words are a honeycomb, sweet to the soul, and health to the bones.
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringifyContent(value: unknown): string {
  if (value == null) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readContentPartText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const record = readRecord(value);
  if (!record) {
    return "";
  }

  if (typeof record.text === "string") {
    return record.text;
  }

  if (typeof record.value === "string") {
    return record.value;
  }

  if ("content" in record) {
    return readChatContentText(record.content);
  }

  return "";
}

export function readChatContentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const text = value.map(readContentPartText).filter(Boolean).join("");
    return text || stringifyContent(value);
  }

  const record = readRecord(value);
  if (record) {
    const text =
      readContentPartText(record.text) ||
      readContentPartText(record.content) ||
      readContentPartText(record.value);
    return text || stringifyContent(value);
  }

  return stringifyContent(value);
}
