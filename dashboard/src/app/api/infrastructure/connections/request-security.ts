import type { NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/self-host/request-origin";

export const MAX_CAPACITY_REQUEST_BODY_BYTES = 4_096;
export const MAX_CONNECTION_REQUEST_BODY_BYTES = 96 * 1_024;

export function isSameOriginMutationRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || fetchSite !== "same-origin") return false;
  return isSameOriginRequest(request);
}

export function hasStrictJsonContentType(request: NextRequest): boolean {
  return request.headers.get("content-type")?.trim().toLowerCase()
    === "application/json";
}

export async function readBoundedJson(
  request: NextRequest,
  maxBytes: number,
  timeoutMs?: number,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: "invalid" | "too_large" | "timeout" }> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength)
      || parsedLength < 0
      || parsedLength > maxBytes
    ) {
      return { ok: false, reason: "too_large" };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: "invalid" };
  let timedOut = false;
  const deadline = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, timeoutMs);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (timedOut) return { ok: false, reason: "timeout" };
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    reader.releaseLock();
  }
}
