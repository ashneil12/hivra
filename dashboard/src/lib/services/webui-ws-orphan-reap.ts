/**
 * How long a web-chat session keeps running after its browser tab goes away.
 *
 * When the last WebSocket client of a web-chat session disconnects (tab closed,
 * page refreshed, network lost), the agent parks the session and starts a timer,
 * `dashboard.ws_orphan_reap_grace_s` in config.yaml. The prod agent fork
 * (vanilla-hermes-agent) at its stock 20 s then INTERRUPTS a turn that is still
 * running and auto-denies its pending approvals; with no client back by then, a
 * long task dies 20 s after the tab closes. The canary fork and current upstream
 * exempt running turns, and the canary fork reads only the
 * HERMES_TUI_WS_ORPHAN_REAP_GRACE_S env override, so this key is inert there.
 *
 * Hivra pins the key to WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS. The grace is also
 * how long an IDLE parked session (its agent plus a persistent slash-worker
 * Python subprocess) stays in memory when nobody reattaches, so it cannot be
 * unbounded on small boxes:
 *   - lower bound: above approvals.gateway_timeout (3600 s,
 *     WEBUI_APPROVAL_GATEWAY_TIMEOUT_SECONDS), so a turn parked on an approval
 *     can wait the full hour the approval relay gives the owner, then keep
 *     working, instead of being interrupted and auto-denied by the reap;
 *   - upper bound: below the agent's own 6 h idle-session TTL
 *     (HERMES_TUI_SESSION_TTL_S) and the 6 h turn-marker window
 *     (TURN_MARKER_FRESH_SECONDS), so parked idle sessions are freed hours
 *     sooner than the TTL backstop would free them.
 * Four hours covers the approval hour plus three hours of unattended work after
 * a tab closes, and frees an abandoned idle session within four hours.
 *
 * Fresh provisions get the key from buildWebUIConfigYaml. Update mode preserves
 * the box's config.yaml, so buildWebUIWsOrphanReapRepairCommand repairs it on
 * every update: it sets the key when it is missing (the agent then uses the stock
 * 20 s) or still holds a value Hivra itself shipped or superseded
 * (WEBUI_WS_ORPHAN_REAP_REPLACEABLE_SECONDS), backs up the pre-repair file once,
 * and keeps any other value. The agent's save_config writes a key to config.yaml
 * only when someone set it explicitly, so a different value there is an owner
 * choice and wins.
 */

export const WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS = 4 * 60 * 60;

/**
 * Values the update repair may move to the current pin: the agent's stock
 * default (what an unset key means) and any grace an earlier Hivra release
 * pinned. When the pin changes, add the previous pin here so boxes that still
 * carry it follow; owner-chosen values are never in this list.
 */
export const WEBUI_WS_ORPHAN_REAP_REPLACEABLE_SECONDS: readonly number[] = [20];

/** Suffix of the one-time backup of /state/config.yaml taken before the first repair. */
export const WEBUI_WS_ORPHAN_REAP_BACKUP_SUFFIX = ".pre-ws-orphan-reap-grace";

/** The block buildWebUIConfigYaml emits for fresh provisions. */
export function buildWebUIWsOrphanReapConfigYaml(): string {
  return `dashboard:
  # Keep a running web-chat turn alive for 4 h after its tab closes (the prod
  # agent interrupts it after 20 s by default); bounds parked idle sessions too.
  ws_orphan_reap_grace_s: ${WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS}
`;
}

// Runs with the agent image's Python/PyYAML (like WEBUI_TERMINAL_CONFIG_SYNC_PYTHON).
// Edits the one key in place, keeping the owner's comments, ordering and every
// other setting; a parsed before/after comparison refuses any edit that would
// change anything else (aliases, duplicate keys, unexpected shapes).
// argv: <desired seconds> <comma-separated replaceable seconds> <backup suffix>
//       <state config.yaml> <seed config.yaml>
export const WEBUI_WS_ORPHAN_REAP_CONFIG_SYNC_PYTHON = String.raw`
import os
from pathlib import Path
import stat
import sys
import tempfile
import yaml

SECTION = "dashboard"
KEY = "ws_orphan_reap_grace_s"
LABEL = "[webui-ws-orphan-reap]"


def as_seconds(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def decide(config, desired, replaceable):
    section = config.get(SECTION)
    if section is None:
        return "missing"
    if not isinstance(section, dict):
        raise ValueError("dashboard config must be a YAML mapping")
    if section.get(KEY) is None:
        return "missing"
    current = as_seconds(section[KEY])
    if current is not None and current == desired:
        return "pinned"
    if current is not None and current in replaceable:
        return "replaceable"
    return "owner"


def patch(source, config, desired_text, desired_value):
    document = yaml.compose(source)
    if document is not None and not isinstance(document, yaml.MappingNode):
        raise ValueError("runtime config must be a YAML mapping")
    section = config.get(SECTION)
    expected = dict(config)
    expected[SECTION] = dict(section or {}, **{KEY: desired_value})
    newline = "\r\n" if "\r\n" in source else "\n"
    entries = [] if document is None else document.value
    sections = [(key, node) for key, node in entries if key.value == SECTION]
    if len(sections) > 1:
        raise ValueError("duplicate dashboard sections require manual repair")
    if not sections:
        if document is not None and document.flow_style:
            offset = document.end_mark.index - 1
            addition = SECTION + ": {" + KEY + ": " + desired_text + "}"
            patched = source[:offset] + (", " if entries else "") + addition + source[offset:]
        else:
            offset = len(source) if document is None else document.end_mark.index
            addition = SECTION + ":" + newline + "  " + KEY + ": " + desired_text + newline
            prefix = newline if source[:offset] and not source[:offset].endswith(("\n", "\r")) else ""
            patched = source[:offset] + prefix + addition + source[offset:]
    else:
        section_key, section_node = sections[0]
        # An alias points its node marks at the anchor, which could belong to a
        # different setting. Never edit the anchor as a side effect.
        if section_node.start_mark.index < section_key.end_mark.index:
            raise ValueError("aliased dashboard config requires an explicit dashboard mapping")
        if isinstance(section_node, yaml.MappingNode):
            keys = [(key, node) for key, node in section_node.value if key.value == KEY]
            if len(keys) > 1:
                raise ValueError("duplicate ws_orphan_reap_grace_s keys require manual repair")
            if keys:
                value_key, value_node = keys[0]
                if not isinstance(value_node, yaml.ScalarNode) or value_node.start_mark.index < value_key.end_mark.index:
                    raise ValueError("ws_orphan_reap_grace_s must be an explicit scalar")
                start = value_node.start_mark.index
                prefix = " " if source[:start].endswith(":") else ""
                patched = source[:start] + prefix + desired_text + source[value_node.end_mark.index:]
            elif section_node.flow_style:
                offset = section_node.end_mark.index - 1
                patched = source[:offset] + (", " if section_node.value else "") + KEY + ": " + desired_text + source[offset:]
            else:
                first_key = section_node.value[0][0]
                offset = first_key.start_mark.index
                patched = source[:offset] + KEY + ": " + desired_text + newline + (" " * first_key.start_mark.column) + source[offset:]
        elif isinstance(section_node, yaml.ScalarNode) and section_node.tag == "tag:yaml.org,2002:null":
            offset = section_node.start_mark.index
            prefix = " " if source[:offset].endswith(":") else ""
            patched = source[:offset] + prefix + "{" + KEY + ": " + desired_text + "}" + source[section_node.end_mark.index:]
        else:
            raise ValueError("dashboard config must be a YAML mapping")
    if yaml.safe_load(patched) != expected:
        raise ValueError("reap-grace repair would change unrelated configuration")
    return patched


def write_backup_once(path, original, metadata, suffix):
    backup = path.with_name(path.name + suffix)
    if backup.exists() or backup.is_symlink():
        return None
    fd = os.open(str(backup), os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IMODE(metadata.st_mode))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(original)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        backup.unlink()
        raise
    os.chown(str(backup), metadata.st_uid, metadata.st_gid)
    return backup


def publish(path, payload, original, metadata):
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".reap-grace-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        if path.read_bytes() != original:
            raise RuntimeError("runtime config changed during reap-grace repair; retry the update")
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def repair(path, desired, replaceable, suffix, take_backup):
    if path.is_symlink():
        raise ValueError("reap-grace repair will not replace a symlinked runtime config")
    if not path.exists():
        return "absent"
    original = path.read_bytes()
    source = original.decode("utf-8")
    config = yaml.safe_load(source)
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("runtime config must be a YAML mapping")
    decision = decide(config, desired, replaceable)
    if decision in ("pinned", "owner"):
        return decision
    desired_text = str(int(desired)) if float(desired).is_integer() else repr(desired)
    desired_value = int(desired) if float(desired).is_integer() else desired
    payload = patch(source, config, desired_text, desired_value).encode("utf-8")
    metadata = path.stat()
    if take_backup:
        write_backup_once(path, original, metadata, suffix)
    publish(path, payload, original, metadata)
    return "set_from_" + decision


def main():
    desired = float(sys.argv[1])
    replaceable = {float(value) for value in sys.argv[2].split(",") if value.strip()}
    suffix = sys.argv[3]
    state, seed = Path(sys.argv[4]), Path(sys.argv[5])
    for path, take_backup in ((state, True), (seed, False)):
        outcome = repair(path, desired, replaceable, suffix, take_backup)
        print(LABEL + " " + str(path) + ": dashboard." + KEY + " " + outcome + " (pin " + sys.argv[1] + ")")


if __name__ == "__main__":
    try:
        main()
    except (yaml.YAMLError, UnicodeDecodeError):
        # Parser errors include source lines, which may contain API keys.
        print(LABEL + " cannot parse saved YAML; no config changes applied", file=sys.stderr)
        sys.exit(1)
    except (ValueError, RuntimeError, OSError) as error:
        print(LABEL + " " + str(error) + "; no further config changes applied", file=sys.stderr)
        sys.exit(1)
`;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Update-mode step for buildWebUIBootstrapScript: pin the reap grace in the
 * persisted /state/config.yaml (and the instance-dir copy) with the agent image's
 * Python. Never fails the update: a config it cannot safely edit is left as is.
 */
export function buildWebUIWsOrphanReapRepairCommand(params: {
  containerName: string;
  agentImage: string;
}): string {
  const replaceable = WEBUI_WS_ORPHAN_REAP_REPLACEABLE_SECONDS.join(",");
  return `# Pin dashboard.ws_orphan_reap_grace_s in the persisted config.yaml so a web-chat
# turn keeps running after its tab closes (see webui-ws-orphan-reap.ts). Sets it
# only when missing or still a Hivra-shipped value; an owner's value is kept.
# One backup of the pre-repair file. A failure leaves config.yaml untouched and
# does not fail the update.
docker run --rm -i --network none --user 0:0 \\
  -v ${params.containerName}_webui-state:/state \\
  -v "$INSTANCE_DIR":/seed \\
  --entrypoint /opt/hermes/.venv/bin/python \\
  ${params.agentImage} - ${WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS} ${shellSingleQuote(replaceable)} ${shellSingleQuote(WEBUI_WS_ORPHAN_REAP_BACKUP_SUFFIX)} /state/config.yaml /seed/config.yaml <<'HERMES_WS_ORPHAN_REAP_PY' || echo "[webui-update] WARN: could not pin dashboard.ws_orphan_reap_grace_s; config.yaml left as it was" >&2
${WEBUI_WS_ORPHAN_REAP_CONFIG_SYNC_PYTHON}
HERMES_WS_ORPHAN_REAP_PY
`;
}
