/**
 * How long a web-chat session keeps running after its browser tab goes away,
 * and how many such sessions stay in memory.
 *
 * Two agent settings in config.yaml, both read by the dashboard's web-chat
 * backend (tui_gateway/server.py) in the prod agent fork (vanilla-hermes-agent)
 * and the canary fork:
 *
 * 1. `dashboard.ws_orphan_reap_grace_s` (WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS).
 *    When the last WebSocket client of a web-chat session disconnects (tab
 *    closed, page refreshed, network lost), the agent parks the session and
 *    starts this timer. The prod fork at its stock 20 s then INTERRUPTS a turn
 *    that is still running and auto-denies its pending approvals; with no client
 *    back by then, a long task dies 20 s after the tab closes. The canary fork
 *    and current upstream exempt running turns, and the canary fork reads only
 *    the HERMES_TUI_WS_ORPHAN_REAP_GRACE_S env override, so this key is inert
 *    there. Hivra pins it to four hours:
 *      - lower bound: above approvals.gateway_timeout (3600 s,
 *        WEBUI_APPROVAL_GATEWAY_TIMEOUT_SECONDS), so a turn parked on an approval
 *        can wait the full hour the approval relay gives the owner, then keep
 *        working, instead of being interrupted and auto-denied by the reap;
 *      - upper bound: below the agent's own 6 h idle-session TTL
 *        (HERMES_TUI_SESSION_TTL_S) and the 6 h turn-marker window
 *        (TURN_MARKER_FRESH_SECONDS).
 *
 * 2. Top-level `max_live_sessions` (webuiMaxLiveSessionsForRamMb). The grace is
 *    also how long an IDLE parked session (its agent plus a persistent
 *    slash-worker Python subprocess) stays in memory when nobody reattaches, so
 *    four hours of parked sessions could pile up on a small computer. The fork's
 *    soft LRU cap bounds that: `_max_live_sessions()` reads top-level
 *    `max_live_sessions` (falling back to `gateway.max_live_sessions`) from the
 *    raw config.yaml WITHOUT the agent's defaults, so an unset key means 0, cap
 *    off, although DEFAULT_CONFIG lists 16. `_enforce_session_cap()` runs on
 *    every idle-reaper scan and on every session create/resume, and evicts only
 *    sessions `_session_is_lru_evictable()` allows: never one that is running a
 *    turn, has a pending approval/clarify/input prompt, owns active delegated
 *    work, is still building its agent, or has a live client transport. Reopening
 *    an evicted session reloads it from disk. Hivra sets the cap from the
 *    computer's memory tier: WEBUI_MAX_LIVE_SESSIONS_SMALL up to
 *    WEBUI_MAX_LIVE_SESSIONS_SMALL_RAM_MB, WEBUI_MAX_LIVE_SESSIONS_LARGE above.
 *
 * Fresh provisions get both keys from buildWebUIConfigYaml. Update mode
 * preserves the box's config.yaml, so buildWebUISessionRetentionRepairCommand
 * repairs it on every update: it sets a key when it is missing or still holds a
 * value that is replaceable (the agent's stock default, or a value Hivra itself
 * shipped, such as the other memory tier's cap after a resize), backs up the
 * pre-repair file once, and keeps any other value. The agent's save_config
 * writes a key to config.yaml only when someone set it explicitly, so a
 * different value there is an owner choice and wins.
 */

export const WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS = 4 * 60 * 60;

/**
 * Values the update repair may move to the current grace pin: the agent's stock
 * default (what an unset key means) and any grace an earlier Hivra release
 * pinned. When the pin changes, add the previous pin here so boxes that still
 * carry it follow; owner-chosen values are never in this list.
 */
export const WEBUI_WS_ORPHAN_REAP_REPLACEABLE_SECONDS: readonly number[] = [20];

/** Live web-chat sessions kept in memory on a computer with up to 2 GB of RAM. */
export const WEBUI_MAX_LIVE_SESSIONS_SMALL = 4;
/** Live web-chat sessions kept in memory on a computer with more RAM. */
export const WEBUI_MAX_LIVE_SESSIONS_LARGE = 8;
/** Largest RAM tier (MB) that gets WEBUI_MAX_LIVE_SESSIONS_SMALL. */
export const WEBUI_MAX_LIVE_SESSIONS_SMALL_RAM_MB = 2048;

/**
 * Values the update repair may move to the current cap: the agent's
 * DEFAULT_CONFIG value (16, what a full-defaults config.yaml would carry) and
 * every tier value Hivra ships, so a resized computer follows its new tier.
 */
export const WEBUI_MAX_LIVE_SESSIONS_REPLACEABLE: readonly number[] = [
  16,
  WEBUI_MAX_LIVE_SESSIONS_SMALL,
  WEBUI_MAX_LIVE_SESSIONS_LARGE,
];

/**
 * The live-session cap for a memory tier. An unknown tier gets the small cap:
 * evicting an idle parked session only costs a reload when it is reopened,
 * while too many resident sessions can run a small computer out of memory.
 */
export function webuiMaxLiveSessionsForRamMb(ramMb: number | null | undefined): number {
  if (typeof ramMb === "number" && Number.isFinite(ramMb) && ramMb > WEBUI_MAX_LIVE_SESSIONS_SMALL_RAM_MB) {
    return WEBUI_MAX_LIVE_SESSIONS_LARGE;
  }
  return WEBUI_MAX_LIVE_SESSIONS_SMALL;
}

/** Suffix of the one-time backup of /state/config.yaml taken before the first repair. */
export const WEBUI_SESSION_RETENTION_BACKUP_SUFFIX = ".pre-session-retention";

/** One setting the repair pins: a key path, its value and what it may replace. */
export interface WebUISessionRetentionPin {
  path: readonly [string] | readonly [string, string];
  desired: number;
  replaceable: readonly number[];
  /** A key the agent reads when `path` is unset; its value counts as the current one. */
  fallback?: readonly [string, string];
}

export function webuiSessionRetentionPins(ramMb: number | null | undefined): WebUISessionRetentionPin[] {
  return [
    {
      path: ["dashboard", "ws_orphan_reap_grace_s"],
      desired: WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS,
      replaceable: WEBUI_WS_ORPHAN_REAP_REPLACEABLE_SECONDS,
    },
    {
      path: ["max_live_sessions"],
      desired: webuiMaxLiveSessionsForRamMb(ramMb),
      replaceable: WEBUI_MAX_LIVE_SESSIONS_REPLACEABLE,
      fallback: ["gateway", "max_live_sessions"],
    },
  ];
}

/** The settings buildWebUIConfigYaml emits for fresh provisions. */
export function buildWebUISessionRetentionConfigYaml(ramMb: number | null | undefined): string {
  return `# Keep at most this many web-chat sessions in memory, sized to this computer's
# memory. Only a session with no open tab and nothing running or waiting is let
# go, oldest first; opening it again reloads it.
max_live_sessions: ${webuiMaxLiveSessionsForRamMb(ramMb)}
dashboard:
  # Keep a running web-chat turn alive for 4 h after its tab closes (the prod
  # agent interrupts it after 20 s by default); bounds parked idle sessions too.
  ws_orphan_reap_grace_s: ${WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS}
`;
}

// Runs with the agent image's Python/PyYAML (like WEBUI_TERMINAL_CONFIG_SYNC_PYTHON).
// Edits only the pinned keys in place, keeping the owner's comments, ordering and
// every other setting; a parsed before/after comparison refuses any edit that
// would change anything else (aliases, duplicate keys, unexpected shapes). All or
// nothing per file: a file it cannot safely edit is left exactly as it was.
// argv: <pins JSON> <backup suffix> <state config.yaml> <seed config.yaml>
export const WEBUI_SESSION_RETENTION_CONFIG_SYNC_PYTHON = String.raw`
import copy
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import yaml

LABEL = "[webui-session-retention]"


def as_number(value):
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


def lookup(config, path):
    node = config
    for key in path[:-1]:
        node = node.get(key)
        if node is None:
            return None
        if not isinstance(node, dict):
            raise ValueError(key + " config must be a YAML mapping")
    return node.get(path[-1])


def decide(config, pin):
    value = lookup(config, pin["path"])
    fallback = pin.get("fallback")
    if value is None and fallback:
        # The agent reads the fallback key when the primary one is unset.
        parent = config.get(fallback[0])
        if isinstance(parent, dict):
            value = parent.get(fallback[1])
    if value is None:
        return "missing"
    current = as_number(value)
    if current is not None and current == float(pin["desired"]):
        return "pinned"
    if current is not None and current in [float(item) for item in pin["replaceable"]]:
        return "replaceable"
    return "owner"


def render(desired):
    if float(desired).is_integer():
        return str(int(desired)), int(desired)
    return repr(desired), desired


def set_in_mapping(source, mapping, key, text, newline):
    keys = [(k, node) for k, node in mapping.value if k.value == key]
    if len(keys) > 1:
        raise ValueError("duplicate " + key + " keys require manual repair")
    if keys:
        value_key, value_node = keys[0]
        if not isinstance(value_node, yaml.ScalarNode) or value_node.start_mark.index < value_key.end_mark.index:
            raise ValueError(key + " must be an explicit scalar")
        start = value_node.start_mark.index
        prefix = " " if source[:start].endswith(":") else ""
        return source[:start] + prefix + text + source[value_node.end_mark.index:]
    if mapping.flow_style:
        offset = mapping.end_mark.index - 1
        return source[:offset] + (", " if mapping.value else "") + key + ": " + text + source[offset:]
    first_key = mapping.value[0][0]
    offset = first_key.start_mark.index
    return source[:offset] + key + ": " + text + newline + (" " * first_key.start_mark.column) + source[offset:]


def append_top_level(source, document, block_lines, flow_text, newline):
    if document is not None and document.flow_style:
        offset = document.end_mark.index - 1
        return source[:offset] + (", " if document.value else "") + flow_text + source[offset:]
    offset = len(source) if document is None else document.end_mark.index
    indent = ""
    if document is not None and document.value:
        indent = " " * document.value[0][0].start_mark.column
    addition = "".join(indent + line + newline for line in block_lines)
    prefix = newline if source[:offset] and not source[:offset].endswith(("\n", "\r")) else ""
    return source[:offset] + prefix + addition + source[offset:]


def patch(source, path, text):
    document = yaml.compose(source)
    if document is not None and not isinstance(document, yaml.MappingNode):
        raise ValueError("config must be a YAML mapping")
    newline = "\r\n" if "\r\n" in source else "\n"
    entries = [] if document is None else document.value
    if len(path) == 1:
        key = path[0]
        if document is not None and any(k.value == key for k, _node in entries):
            return set_in_mapping(source, document, key, text, newline)
        return append_top_level(source, document, [key + ": " + text], key + ": " + text, newline)
    section, key = path
    sections = [(k, node) for k, node in entries if k.value == section]
    if len(sections) > 1:
        raise ValueError("duplicate " + section + " sections require manual repair")
    if not sections:
        return append_top_level(
            source,
            document,
            [section + ":", "  " + key + ": " + text],
            section + ": {" + key + ": " + text + "}",
            newline,
        )
    section_key, section_node = sections[0]
    # An alias points its node marks at the anchor, which could belong to a
    # different setting. Never edit the anchor as a side effect.
    if section_node.start_mark.index < section_key.end_mark.index:
        raise ValueError("aliased " + section + " config requires an explicit mapping")
    if isinstance(section_node, yaml.MappingNode):
        return set_in_mapping(source, section_node, key, text, newline)
    if isinstance(section_node, yaml.ScalarNode) and section_node.tag == "tag:yaml.org,2002:null":
        offset = section_node.start_mark.index
        prefix = " " if source[:offset].endswith(":") else ""
        return source[:offset] + prefix + "{" + key + ": " + text + "}" + source[section_node.end_mark.index:]
    raise ValueError(section + " config must be a YAML mapping")


def expect(config, path, value):
    if len(path) == 1:
        config[path[0]] = value
        return
    section, key = path
    config[section] = dict(config.get(section) or {}, **{key: value})


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
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".session-retention-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        if path.read_bytes() != original:
            raise RuntimeError("config changed during the session-retention repair; retry the update")
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def repair(path, pins, suffix, take_backup):
    if path.is_symlink():
        raise ValueError("session-retention repair will not replace a symlinked config")
    if not path.exists():
        return ["absent"] * len(pins)
    original = path.read_bytes()
    source = original.decode("utf-8")
    config = yaml.safe_load(source)
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("config must be a YAML mapping")
    decisions = [decide(config, pin) for pin in pins]
    patched = source
    expected = copy.deepcopy(config)
    for pin, decision in zip(pins, decisions):
        if decision not in ("missing", "replaceable"):
            continue
        text, value = render(pin["desired"])
        patched = patch(patched, pin["path"], text)
        expect(expected, pin["path"], value)
    if patched == source:
        return decisions
    if yaml.safe_load(patched) != expected:
        raise ValueError("session-retention repair would change unrelated configuration")
    metadata = path.stat()
    if take_backup:
        write_backup_once(path, original, metadata, suffix)
    publish(path, patched.encode("utf-8"), original, metadata)
    return ["set_from_" + d if d in ("missing", "replaceable") else d for d in decisions]


def main():
    pins = json.loads(sys.argv[1])
    suffix = sys.argv[2]
    state, seed = Path(sys.argv[3]), Path(sys.argv[4])
    for path, take_backup in ((state, True), (seed, False)):
        outcomes = repair(path, pins, suffix, take_backup)
        for pin, outcome in zip(pins, outcomes):
            print(
                LABEL + " " + str(path) + ": " + ".".join(pin["path"]) + " " + outcome
                + " (pin " + render(pin["desired"])[0] + ")"
            )


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
 * Update-mode step for buildWebUIBootstrapScript: pin the web-chat session
 * retention settings in the persisted /state/config.yaml (and the instance-dir
 * copy) with the agent image's Python. Never fails the update: a config it
 * cannot safely edit is left as is.
 */
export function buildWebUISessionRetentionRepairCommand(params: {
  containerName: string;
  agentImage: string;
  ramLimitMb: number | null | undefined;
}): string {
  const pins = JSON.stringify(webuiSessionRetentionPins(params.ramLimitMb));
  return `# Pin the web-chat session retention settings (dashboard.ws_orphan_reap_grace_s
# and max_live_sessions) in the persisted config.yaml so a web-chat turn keeps
# running after its tab closes and parked sessions stay bounded (see
# webui-session-retention.ts). Sets each only when missing or still a stock or
# Hivra-shipped value; an owner's value is kept. One backup of the pre-repair
# file. A failure leaves config.yaml untouched and does not fail the update.
docker run --rm -i --network none --user 0:0 \\
  -v ${params.containerName}_webui-state:/state \\
  -v "$INSTANCE_DIR":/seed \\
  --entrypoint /opt/hermes/.venv/bin/python \\
  ${params.agentImage} - ${shellSingleQuote(pins)} ${shellSingleQuote(WEBUI_SESSION_RETENTION_BACKUP_SUFFIX)} /state/config.yaml /seed/config.yaml <<'HERMES_SESSION_RETENTION_PY' || echo "[webui-update] WARN: could not pin the web-chat session retention settings; config.yaml left as it was" >&2
${WEBUI_SESSION_RETENTION_CONFIG_SYNC_PYTHON}
HERMES_SESSION_RETENTION_PY
`;
}
