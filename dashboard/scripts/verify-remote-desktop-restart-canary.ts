import { config } from "dotenv";

config({ path: ".env.local" });

function requestedAgentId(): string {
  const values = process.argv.slice(2);
  const idAt = values.indexOf("--agent-id");
  return idAt >= 0 ? values[idAt + 1] : "";
}

async function main() {
  const values = process.argv.slice(2);
  const agentId = requestedAgentId();
  const apply = values.includes("--apply");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)) {
    throw new Error("Pass one explicit --agent-id UUID.");
  }
  if (!apply) {
    process.stdout.write(`${JSON.stringify({
      protocol: "hivra-remote-desktop-canary-restart-plan-v1",
      agentId,
      mutatesCanaryGuest: false,
    })}\n`);
    return;
  }
  if (process.env.NEXT_PUBLIC_APP_URL !== "https://canary.hermesos.cloud") {
    throw new Error("This command is fenced to the Canary environment.");
  }
  const cronSecret = process.env.CRON_SECRET ?? "";
  if (!cronSecret) throw new Error("Canary operator authority is unavailable.");
  const response = await fetch("https://canary.hermesos.cloud/api/ops/hivra/remote-desktop-guest", {
    method: "POST",
    headers: {
      authorization: `Bearer ${cronSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "restart", agentId }),
  });
  const payload = await response.json().catch(() => null) as {
    data?: Record<string, unknown>;
  } | null;
  const result = payload?.data;
  if (!result || result.agentId !== agentId || typeof result.ok !== "boolean") {
    throw new Error("Canary did not return a bound desktop restart receipt.");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

void main().catch(() => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    agentId: requestedAgentId(),
    error: "Remote desktop Canary restart command failed.",
  })}\n`);
  process.exitCode = 1;
});
