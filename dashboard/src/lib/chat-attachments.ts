type PersistedAttachment = {
  id?: string;
  name?: string;
  type?: string;
  url?: string;
  size?: number;
  contentType?: string;
  storagePath?: string;
  storageBucket?: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readSize(value: unknown): number | undefined {
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeAttachmentsForPersistence(value: unknown): PersistedAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((attachment) => {
      const persisted: PersistedAttachment = {};
      const id = readString(attachment.id);
      const name = readString(attachment.name);
      const type = readString(attachment.type);
      const url = readString(attachment.url);
      const size = readSize(attachment.size);
      const contentType = readString(attachment.contentType);
      const storagePath = readString(attachment.storagePath);
      const storageBucket = readString(attachment.storageBucket);

      if (id) persisted.id = id;
      if (name) persisted.name = name;
      if (type) persisted.type = type;
      if (url && !url.startsWith("data:")) persisted.url = url;
      if (size !== undefined) persisted.size = size;
      if (contentType) persisted.contentType = contentType;
      if (storagePath) persisted.storagePath = storagePath;
      if (storageBucket) persisted.storageBucket = storageBucket;

      return persisted;
    });
}
