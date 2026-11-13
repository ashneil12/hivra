import "server-only";

// The HTTP edge shared by /api/hivra/ingress/wake-report and wake-request:
// read at most 4 KB of body, verify the host's signature over exactly those
// bytes, then parse them. These routes have no session of their own (proxy.ts
// leaves them out of Clerk); the signature is the only way in, and with
// HIVRA_INGRESS_HOST_CREDENTIAL off they answer 404 as if they did not exist.

import { NextResponse, type NextRequest } from "next/server";

import { log } from "@/lib/logger";
import { HOST_REQUEST_MAX_BODY_BYTES, verifyHostRequest, type HostRequestDeps } from "@/lib/hivra/ingress/host-credential";
import { claimHostRequestNonce, loadHostCredentialRow } from "@/lib/hivra/ingress/host-credential-store";

const LOG_SOURCE = "ingress-host-call";

export function hostCallJson(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

/** The raw body, or null when it is larger than the limit or cannot be read. */
async function readRawBody(req: NextRequest, limit: number): Promise<Buffer | null> {
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value?.byteLength ?? 0;
      if (seen > limit) return null;
      if (value) chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

export type VerifiedHostCall =
  | { ok: true; hostId: string; generation: number; body: unknown }
  | { ok: false; response: NextResponse };

export async function verifiedHostCall(
  req: NextRequest,
  path: string,
  deps: Partial<HostRequestDeps> = {},
): Promise<VerifiedHostCall> {
  const raw = await readRawBody(req, HOST_REQUEST_MAX_BODY_BYTES);
  if (raw === null) return { ok: false, response: hostCallJson(413, { ok: false, error: "too_large" }) };
  const verdict = await verifyHostRequest(
    { path, headers: req.headers, body: raw },
    { loadHost: loadHostCredentialRow, claimNonce: claimHostRequestNonce, ...deps },
  );
  if (!verdict.ok) {
    if (verdict.status !== 404) {
      log.warn("host call refused", {
        source: LOG_SOURCE,
        failureType: "ingress_host_call_refused",
        path,
        reason: verdict.reason,
      });
    }
    const error = verdict.status === 404 ? "not_found" : verdict.status === 401 ? "unauthorized" : verdict.reason;
    return {
      ok: false,
      response: hostCallJson(verdict.status, { ok: false, error }, verdict.status === 503 ? { "Retry-After": "5" } : {}),
    };
  }
  let body: unknown = null;
  try {
    body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : null;
  } catch {
    body = null;
  }
  return { ok: true, hostId: verdict.hostId, generation: verdict.generation, body };
}
