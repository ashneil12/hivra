import "server-only";

import { firstBootCallbackUrl } from "./first-boot-cloud-init";

/** Check the public machine-auth boundary before a new guided purchase. No
 * browser cookies, enrollment token, provider secret or protection-bypass key
 * may enter this request. A redirect to a deployment login is not readiness.
 * This observation is not proof that a future guest will enroll successfully. */
export async function isFirstBootCallbackReachable(origin: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(firstBootCallbackUrl(origin), {
      method: "POST", redirect: "manual", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 401 || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      void response.body?.cancel().catch(() => undefined);
      return false;
    }
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 256) {
          void reader.cancel().catch(() => undefined);
          return false;
        }
        chunks.push(value);
      }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return payload !== null && typeof payload === "object" && !Array.isArray(payload)
        && Object.keys(payload).length === 1 && "accepted" in payload && payload.accepted === false;
    } finally { reader.releaseLock(); }
  } catch { return false; }
}
