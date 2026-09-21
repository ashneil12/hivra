import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  inspectManagedProvisionerBundle,
  isSafeManagedProvisionerTargetId,
  syncManagedProvisionerBundle,
} from "@/lib/hivra/managed-provisioner-bundle-sync";
import { managedHivraProvisionerChannelForServerEnvironment } from "@/lib/hivra/managed-provisioner-channel";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const SOURCE = "ops:hivra:provisioner-bundle";

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing provisioner bundle operation", new Error("CRON_SECRET missing"), {
      source: SOURCE,
    });
    return apiError("CRON_SECRET is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);

  let body: { target?: unknown; apply?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return apiError("Invalid JSON body", 400);
  }
  const target = typeof body.target === "string" ? body.target.trim().toLowerCase() : "";
  if (!isSafeManagedProvisionerTargetId(target)) {
    return apiError("target must be an explicit configured Proxmox host id", 400);
  }

  try {
    const apply = body.apply === true;
    const channel = managedHivraProvisionerChannelForServerEnvironment(process.env);
    const result = apply
      ? await syncManagedProvisionerBundle(channel, target)
      : await inspectManagedProvisionerBundle(channel, target);
    log.info("managed provisioner bundle operation complete", {
      source: SOURCE,
      target,
      channel,
      apply,
      ok: result.ok,
      changed: result.changed,
      observedVersion: result.observedVersion,
      requestedVersion: result.requestedVersion,
    });
    if (!result.ok) return apiError(result.error ?? "Provisioner bundle operation failed", 503, result);
    return apiSuccess({ ...result, apply });
  } catch (error) {
    log.error("managed provisioner bundle operation failed", error, { source: SOURCE, target });
    return apiError("Provisioner bundle operation failed", 500);
  }
}
