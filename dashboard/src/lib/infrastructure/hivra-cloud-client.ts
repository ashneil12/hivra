"use client";

import { z } from "zod";

const ManagedComputerSchema = z
  .object({
    source: z.enum(["hermes", "hivra"]),
    id: z.string().trim().min(1),
    name: z.string(),
    status: z.string(),
    cpu: z.number().nonnegative(),
    ram: z.number().nonnegative(),
    disk_size_gb: z.number().nonnegative(),
    disk_upgraded: z.boolean(),
    backups_enabled: z.boolean(),
    type: z.string().nullable().optional(),
  })
  .passthrough();

const HivraCloudCapacityResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        subscribed: z.boolean(),
        plan: z
          .object({
            key: z.string().trim().min(1),
            name: z.string().trim().min(1),
            price: z.number().nonnegative(),
            maxAgents: z.number().int().nonnegative(),
            maxCpuPerAgent: z.number().nonnegative(),
            maxRamPerAgent: z.number().nonnegative(),
            totalCpu: z.number().nonnegative(),
            totalRam: z.number().nonnegative(),
            status: z.string().trim().min(1),
            currentPeriodEnd: z.string().nullable(),
            source: z.string().trim().min(1),
            canChangePlanInPlace: z.boolean(),
          })
          .passthrough()
          .nullable(),
        usage: z
          .object({
            agentCount: z.number().int().nonnegative(),
            maxAgents: z.number().int().nonnegative(),
            usedCpu: z.number().nonnegative(),
            totalCpu: z.number().nonnegative(),
            usedRam: z.number().nonnegative(),
            totalRam: z.number().nonnegative(),
            instances: z.array(ManagedComputerSchema),
          })
          .passthrough()
          .nullable(),
      })
      .passthrough(),
  })
  .passthrough();

export type HivraCloudCapacityDto = {
  subscribed: boolean;
  paid: boolean;
  plan: z.infer<typeof HivraCloudCapacityResponseSchema>["data"]["plan"];
  usage: z.infer<typeof HivraCloudCapacityResponseSchema>["data"]["usage"];
};

export class HivraCloudCapacityError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "HivraCloudCapacityError";
  }
}

export async function getHivraCloudCapacity(
  signal?: AbortSignal,
): Promise<HivraCloudCapacityDto> {
  let response: Response;
  try {
    response = await fetch("/api/billing/usage", {
      method: "GET",
      cache: "no-store",
      signal,
    });
  } catch {
    throw new HivraCloudCapacityError(
      "Hivra could not load your managed cloud capacity.",
      0,
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // The stable error below deliberately avoids exposing an upstream body.
  }

  if (!response.ok) {
    const message = z
      .object({ error: z.string().trim().min(1) })
      .safeParse(payload);
    throw new HivraCloudCapacityError(
      message.success
        ? message.data.error
        : "Hivra could not load your managed cloud capacity.",
      response.status,
    );
  }

  const parsed = HivraCloudCapacityResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new HivraCloudCapacityError(
      "Hivra returned an unexpected managed capacity response. Refresh and try again.",
      response.status,
    );
  }

  const { subscribed, plan, usage } = parsed.data.data;
  return {
    subscribed,
    paid: subscribed && plan !== null && plan.key !== "free",
    plan,
    usage,
  };
}
