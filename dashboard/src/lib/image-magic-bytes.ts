/**
 * Magic-byte sniffer for the image MIME types the avatar surface accepts.
 *
 * Filename extension and Content-Type can both be forged (the browser picks
 * both); only the byte prefix is authoritative. Used by /api/upload-avatar
 * to verify uploads before storing them in Supabase storage (where the
 * stored Content-Type is pinned to the sniffed type so a forged
 * "image/gif" can't be served back as gif if the bytes are something else).
 *
 * We deliberately don't pull in `file-type` — the four signatures below are
 * stable, well-documented, and cover every entry in
 * ALLOWED_AVATAR_MIME_TYPES.
 */
export type DetectedImageType = { mimeType: string; extension: string };

export const ALLOWED_AVATAR_MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const ALLOWED_AVATAR_EXTENSIONS = new Set<string>([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
]);

export function detectImageType(buffer: Buffer): DetectedImageType | null {
  if (buffer.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e &&
    buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a &&
    buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: "png" };
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  // GIF: 47 49 46 38 (37|39) 61 → "GIF87a" or "GIF89a"
  if (
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 &&
    buffer[3] === 0x38 && (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { mimeType: "image/gif", extension: "gif" };
  }
  // WEBP: "RIFF" .... "WEBP" — bytes 0..3 are "RIFF", bytes 8..11 are "WEBP"
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 &&
    buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 &&
    buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}
