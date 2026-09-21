"use client";
import { z } from "zod";
import { HetznerCleanupAbsenceSchema, HetznerCleanupRequestSchema, HetznerCleanupStateSchema, HetznerCleanupAbandonRequestSchema, type HetznerCleanupRequest, type HetznerCleanupAbandonRequest } from "./hetzner-cleanup-contracts";
import { HetznerCloudForceForgetResultSchema } from "./contracts";

const Id = z.string().regex(/^[1-9][0-9]*$/);
export const HetznerCleanupViewSchema = z.object({
  orderId:z.string().uuid(),connectionId:z.string().uuid(),serverName:z.string().regex(/^hivra-[0-9a-f]{20}$/),
  status:z.enum(["creating","created_off","ambiguous","provider_rejected","cleaning","deleted","cleanup_abandoned"]),
  eligible:z.boolean(),fingerprint:z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  resources:z.object({server:Id,ipv4:Id,ipv6:Id,sshKey:Id,firewall:Id.optional()}).strict().nullable(),
  cleanup:HetznerCleanupStateSchema.nullable(),
  busy:z.boolean().optional(),observedAbsence:HetznerCleanupAbsenceSchema.nullable().optional(),
}).strict().superRefine((v,ctx)=>{
  if ((v.eligible && (!v.resources || !v.fingerprint))
    || (v.status === "deleted" && (!v.cleanup?.finishedAt || !Object.values(v.cleanup.absence).every(Boolean)))
    || (v.cleanup && v.cleanup.fingerprint !== v.fingerprint)
    || (v.cleanup && Boolean(v.resources?.firewall) !== (v.cleanup.absence.firewall !== undefined))
    || (v.observedAbsence && Boolean(v.resources?.firewall) !== (v.observedAbsence.firewall !== undefined))) {
    ctx.addIssue({code:"custom",message:"Incoherent cleanup evidence"});
  }
});
export type HetznerCleanupView = z.infer<typeof HetznerCleanupViewSchema>;
class CleanupClientError extends Error {}

export function cleanupErrorMessage(code: unknown) {
  switch(code) {
    case "resource_changed": return "A resource was changed, protected, or assigned elsewhere. Nothing further will be removed. Inspect the original IDs in Hetzner before continuing.";
    case "resource_busy": return "Hetzner is still changing this server. Its claim is retained. Wait for that operation to finish, then resume.";
    case "connection_changed": return "The project connection changed or its cleanup lease expired. Check the connection and reopen this same cleanup.";
    case "not_eligible": return "This older or unresolved launch has no complete original-resource receipt. Use Hetzner Console to review it; Hivra will not guess which resources to delete.";
    case "target_in_use": return "This project has registered launch targets. Remove the computer through its target-aware lifecycle before using unused-capacity cleanup; Hivra will not delete a target from under an agent.";
    case "confirmation_changed": return "The saved cleanup differs from this confirmation. Reopen it and review the original resources.";
    default: return "The last step could not be confirmed. The saved cleanup remains available here; reopen it before retrying. Do not create a replacement server to recover this operation.";
  }
}
async function request<T>(url:string,schema:z.ZodType<T>,body?:unknown):Promise<T> {
  const controller = new AbortController();
  const deadline = setTimeout(()=>controller.abort(),65_000);
  try {
    const response = await fetch(url,{ method:body ? "POST":"GET", credentials:"same-origin",cache:"no-store",redirect:"error",
      signal:controller.signal, ...(body ? {headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}: {}) });
    const payload: unknown = await response.json();
    if (!response.ok || !payload || typeof payload !== "object" || !("success" in payload) || payload.success !== true) {
      const code = payload && typeof payload === "object" && "code" in payload ? payload.code : null;
      throw new CleanupClientError(cleanupErrorMessage(code));
    }
    return schema.parse("data" in payload ? payload.data : null);
  } catch(error) {
    if (error instanceof CleanupClientError) throw error;
    throw new CleanupClientError(cleanupErrorMessage(null));
  } finally { clearTimeout(deadline); }
}
const endpoint = (id:string) => `/api/infrastructure/connections/${z.string().uuid().parse(id)}/hetzner-cloud/capacity/cleanup`;
export const listCleanupOrders = (id:string) => request(endpoint(id),z.object({orders:z.array(HetznerCleanupViewSchema).max(20)}).strict());
export const previewCleanup = (id:string,orderId:string) => request(`${endpoint(id)}?orderId=${z.string().uuid().parse(orderId)}`,HetznerCleanupViewSchema);
export const advanceCleanup = (id:string,body:HetznerCleanupRequest) => request(endpoint(id),HetznerCleanupViewSchema,HetznerCleanupRequestSchema.parse(body));
export const forgetCleanupAccess = (id:string,body:HetznerCleanupAbandonRequest) => request(endpoint(id)+"/forget",HetznerCloudForceForgetResultSchema,HetznerCleanupAbandonRequestSchema.parse(body));
