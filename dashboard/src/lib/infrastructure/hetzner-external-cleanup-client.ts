"use client";
import { z } from "zod";
import { HetznerExternalCleanupRequestSchema, HetznerExternalCleanupResultSchema,
  type HetznerExternalCleanupRequest } from "./hetzner-external-cleanup-contracts";

export async function verifyExternalCleanup(connectionId: string, request: HetznerExternalCleanupRequest) {
  const id = z.string().uuid().parse(connectionId), body = HetznerExternalCleanupRequestSchema.parse(request);
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const response = await fetch(`/api/infrastructure/connections/${id}/hetzner-cloud/capacity/external-cleanup`, {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || result?.success !== true) {
      if (result?.code === "resources_remain") throw new Error("Resources remain in this project. Remove the original server, its Primary IPs and generated SSH key in Hetzner first. This conservative check also requires no other servers or Primary IPs in the project; it deletes nothing.");
      if (result?.code === "not_eligible") throw new Error("This purchase cannot use automatic absence verification. Its original identity or activity requires manual review; the slot is still held.");
      throw new Error("Cleanup could not be confirmed. The slot remains held. Check the connection and retry this same verification; no server will be purchased.");
    }
    return HetznerExternalCleanupResultSchema.parse(result.data);
  } finally { clearTimeout(timeout); }
}
