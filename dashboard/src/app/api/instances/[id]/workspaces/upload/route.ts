import path from "node:path";

import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { sshExec } from "@/lib/hetzner/ssh";
import { buildResolveAgentContainerScript } from "@/lib/services/agent-container";
import { InstanceAccessError, ProfileService, sanitizeDockerName } from "@/lib/services/profile-service";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const WORKSPACE_ROOT = "/workspace";

function normalizeWorkspacePath(input: string): string | null {
  const normalized = path.posix.normalize(input.trim());
  if (normalized === WORKSPACE_ROOT || normalized.startsWith(`${WORKSPACE_ROOT}/`)) {
    return normalized;
  }
  return null;
}

function sanitizeFilename(filename: string): string {
  const sanitized = path.posix.basename(filename).replace(/[\0\r\n]/g, "_").trim();
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "upload";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id: instanceId } = await params;
    const formData = await request.formData();
    const targetPath = normalizeWorkspacePath(String(formData.get("path") || ""));
    if (!targetPath) {
      return apiError("Upload folder must be inside /workspace", 400, {
        failureType: "workspace_upload_invalid_path",
      });
    }

    const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) {
      return apiError("No files selected", 400, {
        failureType: "workspace_upload_empty",
      });
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_UPLOAD_BYTES) {
      return apiError("Upload is too large for this workspace action", 413, {
        failureType: "workspace_upload_too_large",
        maxBytes: MAX_UPLOAD_BYTES,
      });
    }

    const hostIp = await ProfileService.getHostIpForInstance(instanceId, userId);
    const baseContainerName = `agent-${sanitizeDockerName(instanceId)}`;
    const uploaded: Array<{ name: string; path: string; size: number }> = [];

    for (const file of files) {
      const filename = sanitizeFilename(file.name);
      const encoded = Buffer.from(await file.arrayBuffer()).toString("base64");
      const result = await sshExec(
        hostIp,
        [
          "set -e",
          // Resolve the live agent container (webfree runs -gateway/-official-dashboard,
          // not a bare agent-<id>; both mount the workspace volume).
          buildResolveAgentContainerScript(baseContainerName, { varName: "CONTAINER_NAME" }),
          `if [ -z "$CONTAINER_NAME" ]; then echo "no running agent container" >&2; exit 1; fi`,
          `FILE_B64=${shellQuote(encoded)}`,
          `TARGET_DIR=${shellQuote(targetPath)}`,
          `FILENAME=${shellQuote(filename)}`,
          // F109: chown ONLY the file we just wrote (and the dir if we had to
          // create it), not `chown -R` the whole target dir — recursively
          // re-owning every pre-existing file on each upload was a side effect
          // that could clobber ownership the agent had intentionally set.
          `printf "%s" "$FILE_B64" | base64 -d | docker exec -u root -i "$CONTAINER_NAME" sh -c 'target_dir="$1"; filename="$2"; mkdir -p "$target_dir"; chown 1024:1024 "$target_dir" 2>/dev/null || true; cat > "$target_dir/$filename"; chown 1024:1024 "$target_dir/$filename" 2>/dev/null || true' sh "$TARGET_DIR" "$FILENAME"`,
        ].join("\n")
      );

      if (!result.ok) {
        // F109: the upload loop is non-atomic — files before this one are
        // already written. Surface WHICH files made it (and which one failed)
        // so the client isn't left guessing about partial state.
        return apiError("File upload failed", 502, {
          failureType: "workspace_upload_remote_failed",
          failedFile: filename,
          uploaded,
        });
      }

      uploaded.push({
        name: filename,
        path: `${targetPath}/${filename}`,
        size: file.size,
      });
    }

    return apiSuccess({ uploaded });
  } catch (err) {
    if (err instanceof InstanceAccessError) {
      return apiError("Instance not found", 404, {
        failureType: "workspace_upload_instance_not_found",
      });
    }
    return handleApiError(err);
  }
}
