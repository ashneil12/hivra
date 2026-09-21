import { supabaseAdmin } from "@/lib/supabase";
import { getHetznerInstanceStatus } from "@/lib/services/hetzner-instance-service";
import { type HermesInstanceRow } from "@/app/api/instances/[id]/route";
import { isIpv4Literal } from "@/lib/network-address";

interface HermesHostRow {
  id: string;
  hetzner_server_id: number | null;
  ipv4_address?: string | null;
  name: string;
  total_cpu: number;
  total_ram: number;
  status: string;
}

export async function resolveInstanceIpv4(instance: HermesInstanceRow): Promise<string> {
  if (isIpv4Literal(instance.ipv4_address)) {
    return instance.ipv4_address;
  }

  if (instance.host_id) {
    const { data: host } = await supabaseAdmin!
      .from("hermes_hosts")
      .select("hetzner_server_id, ipv4_address")
      .eq("id", instance.host_id)
      .single<Pick<HermesHostRow, "hetzner_server_id" | "ipv4_address">>();

    if (isIpv4Literal(host?.ipv4_address)) {
      return host.ipv4_address;
    }

    if (host?.hetzner_server_id) {
      const hs = await getHetznerInstanceStatus(host.hetzner_server_id);
      if (hs.ipv4) {
        await supabaseAdmin!.from("hermes_hosts").update({ ipv4_address: hs.ipv4 }).eq("id", instance.host_id);
        return hs.ipv4;
      }
    }
  }
  if (instance.hetzner_server_id) {
    const hs = await getHetznerInstanceStatus(instance.hetzner_server_id);
    if (hs.ipv4) {
      await supabaseAdmin!.from("hermes_instances").update({ ipv4_address: hs.ipv4 }).eq("id", instance.id);
      return hs.ipv4;
    }
  }
  if (instance.gateway_url) {
    try {
      const url = new URL(instance.gateway_url);
      if (isIpv4Literal(url.hostname)) return url.hostname;
    } catch {}
  }
  return "";
}
