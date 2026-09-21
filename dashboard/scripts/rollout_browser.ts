import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function run() {
    const { supabaseAdmin } = await import("@/lib/supabase");
    const { buildAgentDeployScript, resolveGatewayConfiguration } = await import("@/lib/services/hetzner-instance-service");
    const { sshExec } = await import("@/lib/hetzner/ssh");
    const { getServer } = await import("@/lib/hetzner/client");
    const { decryptApiKey } = await import("@/lib/crypto");
    const { getRuntimeAgentSettings } = await import("@/lib/instance-settings");

    console.log("Fetching running instances...");
    const { data: instances } = await supabaseAdmin!
        .from("hermes_instances")
        .select("*")
        .eq("status", "running");
    
    if (!instances || instances.length === 0) {
        console.log("No running instances found.");
        return;
    }

    console.log(`Found ${instances.length} running instances!`);

    let successCount = 0;
    
    for (const sys of instances) {
        console.log(`Updating ${sys.id} (${sys.name})...`);
        try {
            let serverId = sys.hetzner_server_id;
            if (sys.host_id) {
               const { data: host } = await supabaseAdmin!.from("hermes_hosts").select("*").eq("id", sys.host_id).single();
               if (host?.hetzner_server_id) serverId = host.hetzner_server_id;
            }

            if (!serverId) {
                console.log(`❌ No server attached for ${sys.name}`);
                continue;
            }

            const { server } = await getServer(serverId);
            const ipv4 = server?.public_net?.ipv4?.ip ?? "";
            
            if (!ipv4) {
               console.log(`❌ No IPv4 for ${sys.name}`);
               continue;
            }
            
            const apiKey = decryptApiKey(sys.api_key_encrypted);
            const apiServerKey = sys.api_server_key_encrypted
              ? decryptApiKey(sys.api_server_key_encrypted)
              : "";
            const model = typeof sys.config?.model === "string" ? sys.config.model : "";
            const runtimeAgentSettings = getRuntimeAgentSettings(sys.config);

            const { fqdn } = resolveGatewayConfiguration({
              subdomain: sys.subdomain ?? null,
              ipv4,
            });

            // Need honcho settings wrapper
            const honchoConfig = (sys.config?.honcho || {}) as Record<string, unknown>;
            let honchoApiKey = "";
            if (sys.honcho_api_key_encrypted) {
              honchoApiKey = decryptApiKey(sys.honcho_api_key_encrypted) || "";
            }

            const honchoSettings = {
              enabled: Boolean(honchoConfig.enabled ?? false),
              apiKey: honchoApiKey,
              baseUrl: typeof honchoConfig.baseUrl === "string" ? honchoConfig.baseUrl : "",
              peerName: typeof honchoConfig.peerName === "string" ? honchoConfig.peerName : sys.name,
              aiPeer: typeof honchoConfig.aiPeer === "string" ? honchoConfig.aiPeer : sys.name + "_AI",
              memoryMode: (typeof honchoConfig.memoryMode === "string" ? honchoConfig.memoryMode : "hybrid") as "hybrid" | "honcho",
              recallMode: (typeof honchoConfig.recallMode === "string" ? honchoConfig.recallMode : "hybrid") as "hybrid" | "context" | "tools",
            };

            const agentScript = buildAgentDeployScript({
              instanceId: sys.id,
              containerName: `agent-${sys.id}`,
              apiServerKey,
              provider: sys.provider,
              apiKey,
              model,
              fqdn,
              cpuLimit: sys.cpu_limit ?? 1,
              ramLimit: sys.ram_limit ?? 2048,
              honchoSettings,
              agentSettings: runtimeAgentSettings,
            });

            const result = await sshExec(ipv4, agentScript, { timeoutMs: 300_000 });

            if (!result.ok) {
              console.log(`❌ Update failed for ${sys.name}: ${result.stderr || result.error}`);
            } else {
              console.log(`✅ Success for ${sys.name}`);
              successCount++;
            }
        } catch (e) {
            console.error(`💥 Exception updating ${sys.name}:`, e);
        }
    }
    
    console.log(`Rollout complete! Successfully updated ${successCount}/${instances.length} instances.`);
}

run().catch(console.error);
