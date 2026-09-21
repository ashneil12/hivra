"use client";

import { HivraRemoteDesktop } from "@/components/hivra/HivraRemoteDesktop";

export function HivraOmarchyDesktop({ computerId, name, active = true, autoPrepare = false, handoffWarmOrigin = null }: {
  computerId: string;
  name: string;
  active?: boolean;
  autoPrepare?: boolean;
  handoffWarmOrigin?: string | null;
}) {
  // Omarchy's normal Desktop surface is the embedded Selkies browser stream.
  // Console/native recovery remains separate; connection failures never
  // silently substitute a different transport here.
  return <HivraRemoteDesktop computerId={computerId} name={name} active={active} autoPrepare={autoPrepare} handoffWarmOrigin={handoffWarmOrigin} />;
}
