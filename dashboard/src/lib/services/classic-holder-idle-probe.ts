import { buildAgentActivityProbeShell, GATEWAY_PROBE_PYTHON, WEBFREE_HERMES_HOME } from "./agent-activity-probe";
import { DEFAULT_NAP_AFTER_SECONDS } from "@/lib/hivra/agent-sleep-policy";
import { isHermesInstanceId } from "@/lib/proxmox/hermes-guest-ssh";

// Executed through the VMID's guest agent. Only a single affirmative result
// may authorize a pause. Nothing from messages or turn markers leaves the VM.
export function buildClassicHolderIdleProbe(id: string): string {
  if (!isHermesInstanceId(id)) throw new Error("Invalid Classic instance id");
  return `set -uo pipefail
${buildAgentActivityProbeShell()}
gateway="agent-${id}-gateway"
dashboard="agent-${id}-official-dashboard"
hivra_agent_activity "$gateway" "$dashboard"
[[ "$HIVRA_GATEWAY_STATE" = "true "* && "$HIVRA_DASHBOARD_STATE" = "true "* && "$HIVRA_ACTIVITY_VERDICT" = idle ]] || exit 1
# A dashboard connection, terminal, SSH session or active outbound request
# may have exchanged no messages yet. Inspect guest and container networks.
sockets="$(ss -Htn state established)" || exit 1
[ -z "$sockets" ] || exit 1
containers="$(docker ps -q)" || exit 1
[ -n "$containers" ] || exit 1
for container in $containers; do
  pid="$(docker inspect -f '{{.State.Pid}}' "$container")" || exit 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || exit 1
  sockets="$(nsenter -t "$pid" -n ss -Htn state established)" || exit 1
  [ -z "$sockets" ] || exit 1
done
docker exec -i "$gateway" ${GATEWAY_PROBE_PYTHON} - ${WEBFREE_HERMES_HOME} <<'CLASSIC_IDLE'
import json, math, pathlib, sqlite3, sys, time
root = pathlib.Path(sys.argv[1])
state = json.loads((root / "gateway_state.json").read_text())
if state.get("gateway_state") != "running" or state.get("active_agents") != 0:
    raise SystemExit(1)
platforms = state["platforms"]
if not isinstance(platforms, dict) or any(
    key.split(":")[-1] not in ("api_server", "local") and value.get("state") != "disabled"
    for key, value in platforms.items()
):
    raise SystemExit(1)
profiles = root / "profiles"
homes = [root, *profiles.iterdir()] if profiles.is_dir() else [root]
for home in homes:
    if not home.is_dir():
        continue
    jobs = home / "cron/jobs.json"
    if jobs.exists():
        record = json.loads(jobs.read_text())
        entries = record["jobs"] if isinstance(record, dict) else record
        if not isinstance(entries, list) or any(job.get("enabled", True) for job in entries):
            raise SystemExit(1)
    db = home / "state.db"
    if home != root and not db.exists():
        continue
    with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=2) as connection:
        latest, = connection.execute("select max(timestamp) from messages").fetchone()
        if latest is not None and (not math.isfinite(float(latest)) or time.time() - float(latest) < ${DEFAULT_NAP_AFTER_SECONDS}):
            raise SystemExit(1)
print("CLASSIC_IDLE")
CLASSIC_IDLE`;
}
