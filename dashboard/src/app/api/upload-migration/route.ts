import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import {
  RATE_LIMIT_PRESETS,
  enforceAuthenticatedRouteRateLimit,
} from "@/lib/authenticated-rate-limit";
import { randomBytes } from "crypto";

// SCRIPTURE_ANCHOR: migration-crossing | Joshua 3:4 | Verse: That you may know the way by which you must go; for you have not passed this way before.
/** Max accepted upload size: 50 MB */
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Allowed MIME types for migration archives */
const ALLOWED_MIME_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"]);

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Per-user rate limit — these are 50 MB uploads; match the transcription
    // route's uploadWrite preset so a single user can't repeatedly fill the
    // storage bucket.
    const rateLimitError = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "upload_migration_post",
      userId,
      ...RATE_LIMIT_PRESETS.uploadWrite,
    });
    if (rateLimitError) return rateLimitError;

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return apiError("No file provided", 400);

    // Validate file extension
    if (!file.name.endsWith(".zip")) {
      return apiError("Only .zip files are allowed", 400);
    }

    // Validate MIME type
    if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
      return apiError("Invalid file type — only zip archives are accepted", 400);
    }

    // Enforce size limit before reading the full buffer into memory
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return apiError(
        `File too large — maximum allowed size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB`,
        413
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Magic-byte sniff: every PKZip file starts with `50 4B 03 04`. The
    // filename and Content-Type can both be forged; this is the only
    // check that the bytes are actually a zip. Catches random binaries
    // and most polyglot abuse before we hand them to the migration
    // consumer downstream.
    if (
      buffer.length < 4 ||
      buffer[0] !== 0x50 ||
      buffer[1] !== 0x4b ||
      buffer[2] !== 0x03 ||
      buffer[3] !== 0x04
    ) {
      return apiError("File is not a valid zip archive", 400);
    }

    const path = `migrations/${userId}/${randomBytes(16).toString("hex")}.zip`;

    const { error } = await supabaseAdmin.storage
      .from("hermes-attachments")
      .upload(path, buffer, {
        contentType: "application/zip",
        upsert: false,
      });

    if (error) {
      return apiError("Failed to upload to storage", 500);
    }

    return apiSuccess({ path });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
