import path from "node:path";
import { apiError } from "@/lib/api-response";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { type HermesInstanceRow } from "@/app/api/instances/[id]/route";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { getHermesGuestSshTarget } from "@/lib/services/proxmox-infrastructure";
import type { ProxmoxSshHostConfig } from "@/lib/hetzner/ssh";
import {
  sftpList,
  sftpRead,
  sftpReadBinary,
  sftpRealpath,
  sftpWrite,
  SftpPreviewLimitError,
} from "@/lib/hetzner/sftp";

const SftpSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    path: z.string().min(1)
  }),
  z.object({
    action: z.literal("read"),
    path: z.string().min(1)
  }),
  z.object({
    action: z.literal("write"),
    path: z.string().min(1),
    content: z.string()
  })
]);

const ALLOWED_SFTP_ROOTS = ["/root", "/opt", "/tmp"] as const;
const ALLOWED_SFTP_ROOTS_ERROR =
  "Access denied: Target path must be within /root, /opt, or /tmp";

function normalizeSftpPath(inputPath: string): string | null {
  const normalized = path.posix.normalize(inputPath.trim());
  if (!normalized.startsWith("/")) {
    return null;
  }

  return isWithinAllowedRoot(normalized) ? normalized : null;
}

function isWithinAllowedRoot(normalizedPath: string): boolean {
  return ALLOWED_SFTP_ROOTS.some(
    (root) => normalizedPath === root || normalizedPath.startsWith(`${root}/`)
  );
}

// Control-plane files that, if overwritten via the file editor, can brick the
// instance (its own .env / Caddyfile / compose). Writes to these are denied so
// an owner can't accidentally (or otherwise) clobber the runtime config. Reads
// are unaffected — this guard is write-only.
const PROTECTED_WRITE_BASENAMES = new Set([
  ".env",
  "caddyfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
]);
const PROTECTED_WRITE_ERROR =
  "Editing this file is disabled: it is part of your instance's control-plane configuration (.env / Caddyfile / compose). Overwriting it could break your agent.";

function isProtectedControlPlaneWrite(targetPath: string): boolean {
  const base = path.posix.basename(targetPath).toLowerCase();
  if (PROTECTED_WRITE_BASENAMES.has(base)) {
    return true;
  }
  // Any dotenv-style variant, e.g. `.env.local`, `.env.production`.
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  return false;
}

function isMissingPathError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const code = typeof (err as Error & { code?: unknown }).code === "string"
    ? String((err as Error & { code?: unknown }).code).toUpperCase()
    : "";
  const message = err.message.toLowerCase();

  return code === "ENOENT" || message.includes("no such file");
}

async function resolveAllowedRemotePath(
  ip: string,
  guestTarget: ProxmoxSshHostConfig | null,
  requestedPath: string,
  options?: { allowMissingLeaf?: boolean }
): Promise<string | null> {
  try {
    const resolvedPath = path.posix.normalize(await sftpRealpath(ip, requestedPath, guestTarget));
    return isWithinAllowedRoot(resolvedPath) ? resolvedPath : null;
  } catch (err) {
    if (!options?.allowMissingLeaf || !isMissingPathError(err)) {
      throw err;
    }

    const parentPath = path.posix.dirname(requestedPath);
    const resolvedParent = path.posix.normalize(await sftpRealpath(ip, parentPath, guestTarget));
    const resolvedLeafPath = path.posix.join(resolvedParent, path.posix.basename(requestedPath));
    return isWithinAllowedRoot(resolvedLeafPath) ? resolvedLeafPath : null;
  }
}

const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

function getPreviewContentType(targetPath: string): string | null {
  const ext = path.posix.extname(targetPath).toLowerCase();

  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    default:
      return null;
  }
}

function buildContentDispositionFilename(filename: string, disposition: "inline" | "attachment") {
  const sanitized = filename.replace(/["\r\n]/g, "_");
  return `${disposition}; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isDownloadRequest(rawValue: string | null) {
  return rawValue === "1" || rawValue === "true";
}

function getSafeSftpRouteError(err: unknown): { status: number; message: string } | null {
  if (!(err instanceof Error)) {
    return null;
  }

  const message = err.message.toLowerCase();
  const code = typeof (err as Error & { code?: unknown }).code === "string"
    ? String((err as Error & { code?: unknown }).code).toUpperCase()
    : "";

  if (code === "ENOENT" || message.includes("no such file")) {
    return { status: 404, message: "No such file or directory" };
  }

  if (code === "EACCES" || message.includes("permission denied")) {
    return { status: 403, message: "Permission denied while accessing the remote filesystem" };
  }

  if (
    code === "ETIMEDOUT" ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("handshake")
  ) {
    return { status: 504, message: "SSH connection timed out" };
  }

  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    message.includes("connection reset") ||
    message.includes("connection lost") ||
    message.includes("connection refused") ||
    message.includes("host verification failed") ||
    message.includes("fingerprint mismatch") ||
    message.includes("authentication failed") ||
    message.includes("could not reach")
  ) {
    return { status: 502, message: "Remote filesystem is unavailable over SSH" };
  }

  return null;
}

function buildSftpErrorDetails(err: unknown, failureType: string) {
  return {
    failureType,
    errorName: err instanceof Error ? err.name : typeof err,
  };
}

async function resolveAuthorizedInstanceIpv4(instanceId: string, clerkId: string) {
  if (!supabaseAdmin) {
    return { error: NextResponse.json({ error: "DB not initialized" }, { status: 500 }) };
  }

  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("*")
    .eq("id", instanceId)
    .eq("user_id", clerkId)
    .single();

  if (error || !instance) {
    return {
      error: NextResponse.json({ error: "Instance not found or access denied" }, { status: 404 }),
    };
  }

  const ip = await resolveInstanceIpv4(instance as HermesInstanceRow);
  if (!ip) {
    return {
      error: NextResponse.json({ error: "Server has no public IPv4" }, { status: 502 }),
    };
  }

  return { ip, guestTarget: getHermesGuestSshTarget(instance as HermesInstanceRow) };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: instanceId } = await params;
    const { searchParams } = new URL(request.url);
    const requestedPath = searchParams.get("path")?.trim();
    const downloadRequested = isDownloadRequest(searchParams.get("download"));

    if (!requestedPath) {
      return NextResponse.json({ error: "Missing preview path" }, { status: 400 });
    }

    const normalizedPath = normalizeSftpPath(requestedPath);
    if (!normalizedPath) {
      return NextResponse.json({ error: ALLOWED_SFTP_ROOTS_ERROR }, { status: 403 });
    }

    const previewContentType = getPreviewContentType(normalizedPath);
    if (!downloadRequested && !previewContentType) {
      return apiError("Preview is only available for PDFs and raster images", 415);
    }
    const contentType: string = downloadRequested
      ? "application/octet-stream"
      : previewContentType ?? "application/octet-stream";

    const instance = await resolveAuthorizedInstanceIpv4(instanceId, clerkId);
    if (instance.error) {
      return instance.error;
    }

    const allowedRemotePath = await resolveAllowedRemotePath(instance.ip, instance.guestTarget, normalizedPath);
    if (!allowedRemotePath) {
      return NextResponse.json({ error: ALLOWED_SFTP_ROOTS_ERROR }, { status: 403 });
    }

    const buffer = downloadRequested
      ? await sftpReadBinary(instance.ip, allowedRemotePath, undefined, instance.guestTarget)
      : await sftpReadBinary(instance.ip, allowedRemotePath, PREVIEW_MAX_BYTES, instance.guestTarget);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const body = new Blob([arrayBuffer], { type: contentType });
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.byteLength),
        "Content-Disposition": buildContentDispositionFilename(
          path.posix.basename(allowedRemotePath),
          downloadRequested ? "attachment" : "inline"
        ),
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof SftpPreviewLimitError) {
      return apiError(err.message, err.status, buildSftpErrorDetails(err, "sftp_preview_limit"));
    }
    const safeError = getSafeSftpRouteError(err);
    if (safeError) {
      return apiError(safeError.message, safeError.status, buildSftpErrorDetails(err, "sftp_route_failed"));
    }
    return apiError("Internal Server Error", 500, buildSftpErrorDetails(err, "sftp_unexpected_error"));
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: instanceId } = await params;
    const raw = await request.json();
    const body = SftpSchema.parse(raw);
    
    const normalizedPath = normalizeSftpPath(body.path);
    if (!normalizedPath) {
      return NextResponse.json({ error: ALLOWED_SFTP_ROOTS_ERROR }, { status: 403 });
    }

    if (body.action === "write" && isProtectedControlPlaneWrite(normalizedPath)) {
      return NextResponse.json({ error: PROTECTED_WRITE_ERROR }, { status: 403 });
    }

    const instance = await resolveAuthorizedInstanceIpv4(instanceId, clerkId);
    if (instance.error) {
      return instance.error;
    }

    const allowedRemotePath = await resolveAllowedRemotePath(instance.ip, instance.guestTarget, normalizedPath, {
      allowMissingLeaf: body.action === "write",
    });
    if (!allowedRemotePath) {
      return NextResponse.json({ error: ALLOWED_SFTP_ROOTS_ERROR }, { status: 403 });
    }

    // Re-check after symlink resolution so a symlinked path can't slip a
    // protected basename past the pre-resolution guard.
    if (body.action === "write" && isProtectedControlPlaneWrite(allowedRemotePath)) {
      return NextResponse.json({ error: PROTECTED_WRITE_ERROR }, { status: 403 });
    }

    if (body.action === "list") {
      const files = await sftpList(instance.ip, allowedRemotePath, instance.guestTarget);
      return NextResponse.json({ ok: true, files });
    }

    if (body.action === "read") {
      const content = await sftpRead(instance.ip, allowedRemotePath, instance.guestTarget);
      return NextResponse.json({ ok: true, content });
    }

    if (body.action === "write") {
      await sftpWrite(instance.ip, allowedRemotePath, body.content, instance.guestTarget);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unhandled action" }, { status: 400 });

  } catch (err) {
    const safeError = getSafeSftpRouteError(err);
    if (safeError) {
      return apiError(safeError.message, safeError.status, buildSftpErrorDetails(err, "sftp_route_failed"));
    }
    return apiError("Internal Server Error", 500, buildSftpErrorDetails(err, "sftp_unexpected_error"));
  }
}
