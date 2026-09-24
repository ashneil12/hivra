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
 *    `max_live_sessions` (falling back to `gateway.max_live_sessions` when that
 *    is unset or null) from the raw config.yaml WITHOUT the agent's defaults, so
 *    an unset key means 0, cap off, although DEFAULT_CONFIG lists 16; the fork
 *    documents 0 and null as the ways to turn the cap off. `_enforce_session_cap()`
 *    runs on every idle-reaper scan and on every session create/resume, and
 *    evicts only sessions `_session_is_lru_evictable()` allows: never one that is
 *    running a turn, has a pending approval/clarify/input prompt, owns active
 *    delegated work, is still building its agent, or has a live client
 *    transport. Reopening an evicted session reloads it from disk. Hivra sets the
 *    cap from the computer's memory tier: WEBUI_MAX_LIVE_SESSIONS_SMALL up to
 *    WEBUI_MAX_LIVE_SESSIONS_SMALL_RAM_MB, WEBUI_MAX_LIVE_SESSIONS_LARGE above.
 *
 * Fresh provisions get both keys from buildWebUIConfigYaml, and the state seed
 * records that Hivra wrote them (WEBUI_SESSION_RETENTION_RECORD_SUFFIX, a JSON
 * file next to /state/config.yaml). Update mode preserves the box's
 * config.yaml, so buildWebUISessionRetentionRepairCommand repairs it on every
 * update. For each key it:
 *   - sets it when it is absent (or, for the grace only, null: the agent reads a
 *     null grace as its 20 s default);
 *   - replaces it when it still holds the value the record says Hivra wrote (so
 *     a resized computer follows its new tier, and a changed pin reaches boxes
 *     that carry the old one), or a stock value no owner chose (the pin's
 *     `stock` list);
 *   - otherwise keeps it: any other value, an explicit null cap (the fork's
 *     "off"), an owner's `gateway.max_live_sessions` (Hivra never writes that
 *     key), and an owner's value that happens to equal a Hivra value are all the
 *     owner's. A key it keeps drops out of the record, so it stays the owner's.
 * The record is written after config.yaml, so an interrupted repair can only
 * leave a Hivra value looking like the owner's (kept, not overwritten), never
 * the other way round. The agent's save_config writes a key to config.yaml only
 * when someone set it explicitly, so a value Hivra did not write is an owner's
 * unless it is a listed stock value.
 */

export const WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS = 4 * 60 * 60;

/**
 * Grace values the repair treats as unset: the agent's stock default, which is
 * also what an absent or null key means (the prod fork's resolver falls back
 * to 20 for both). Earlier Hivra pins do not belong here; the record tracks
 * what Hivra wrote.
 */
export const WEBUI_WS_ORPHAN_REAP_STOCK_SECONDS: readonly number[] = [20];

/** Live web-chat sessions kept in memory on a computer with up to 2 GB of RAM. */
export const WEBUI_MAX_LIVE_SESSIONS_SMALL = 4;
/** Live web-chat sessions kept in memory on a computer with more RAM. */
export const WEBUI_MAX_LIVE_SESSIONS_LARGE = 8;
/** Largest RAM tier (MB) that gets WEBUI_MAX_LIVE_SESSIONS_SMALL. */
export const WEBUI_MAX_LIVE_SESSIONS_SMALL_RAM_MB = 2048;

/**
 * Caps the repair may replace although the record does not say Hivra wrote
 * them: the agent's DEFAULT_CONFIG value. The prod fork has carried
 * `max_live_sessions: 16` in DEFAULT_CONFIG since its 2026-06-27 upstream sync,
 * and until its 2026-07-02 sync its config migrations could still save a full
 * defaults dump into config.yaml, so a 16 there is not proof that an owner chose
 * it. Lowering an owner's 16 only costs a reload when an evicted idle session is
 * reopened; keeping a machine-written 16 would let up to 16 parked sessions stay
 * resident for the 4 h grace on a small computer. Hivra's own tier values are
 * not listed: an owner who sets 4 or 8 keeps it.
 */
export const WEBUI_MAX_LIVE_SESSIONS_STOCK: readonly number[] = [16];

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

/**
 * Suffix of the record, next to /state/config.yaml, of the value Hivra last
 * wrote for each pinned key: `{"version": 1, "written": {"<key path>": [value]}}`.
 */
export const WEBUI_SESSION_RETENTION_RECORD_SUFFIX = ".session-retention-pins.json";

/** One setting the repair pins: a key path, its value and what else it may replace. */
export interface WebUISessionRetentionPin {
  path: readonly [string] | readonly [string, string];
  desired: number;
  /** Values that may be present without an owner having chosen them. */
  stock: readonly number[];
  /** Whether an explicit null means the agent's default (unset) rather than an owner's "off". */
  nullIsUnset: boolean;
  /**
   * A key the agent reads when `path` is unset or null. Hivra never writes it,
   * so whatever it holds is the owner's.
   */
  fallback?: readonly [string, string];
}

export function webuiSessionRetentionPins(ramMb: number | null | undefined): WebUISessionRetentionPin[] {
  return [
    {
      path: ["dashboard", "ws_orphan_reap_grace_s"],
      desired: WEBUI_WS_ORPHAN_REAP_GRACE_SECONDS,
      stock: WEBUI_WS_ORPHAN_REAP_STOCK_SECONDS,
      nullIsUnset: true,
    },
    {
      path: ["max_live_sessions"],
      desired: webuiMaxLiveSessionsForRamMb(ramMb),
      stock: WEBUI_MAX_LIVE_SESSIONS_STOCK,
      nullIsUnset: false,
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

/** The record a fresh provision writes: Hivra wrote every pin buildWebUISessionRetentionConfigYaml emits. */
export function buildWebUISessionRetentionRecordJson(ramMb: number | null | undefined): string {
  const written: Record<string, number[]> = {};
  for (const pin of webuiSessionRetentionPins(ramMb)) {
    written[pin.path.join(".")] = [pin.desired];
  }
  return JSON.stringify({ version: 1, written });
}

/** Env var that carries buildWebUISessionRetentionRecordJson into the provision state seed. */
export const WEBUI_SESSION_RETENTION_RECORD_ENV = "HIVRA_SESSION_RETENTION_RECORD";

/**
 * Busybox shell step for the fresh-provision state seed (inside its single-quoted
 * `sh -c`, so no single quotes here), run right after config.yaml is copied into
 * /state. Never fails the seed: without a record the pins read as the owner's,
 * which only stops a later update from moving them (after a resize, say).
 */
export const WEBUI_SESSION_RETENTION_RECORD_SEED_SH =
  `{ printf "%s\\n" "$${WEBUI_SESSION_RETENTION_RECORD_ENV}" > /state/config.yaml${WEBUI_SESSION_RETENTION_RECORD_SUFFIX} ` +
  `|| echo "[webui-provision] WARN: could not record the session retention settings Hivra wrote" >&2; }`;

// Runs with the agent image's Python/PyYAML (like WEBUI_TERMINAL_CONFIG_SYNC_PYTHON).
// Edits only the pinned keys in place, keeping the owner's comments, ordering and
// every other setting; a parsed before/after comparison refuses any edit that
// would change anything else (aliases, duplicate keys, unexpected shapes). All or
// nothing per file: a file it cannot safely edit is left exactly as it was.
// Both files are judged against the record of what Hivra wrote into the state
// file (the instance-dir copy mirrors it earlier in the same update); only the
// state file gets the backup and the record update.
// argv: <pins JSON> <backup suffix> <record suffix> <state config.yaml> <seed config.yaml>
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
    """(present, value) for a key path; an absent or null section holds nothing."""
    node = config
    for key in path[:-1]:
        node = node.get(key)
        if node is None:
            return False, None
        if not isinstance(node, dict):
            raise ValueError(key + " config must be a YAML mapping")
    if path[-1] in node:
        return True, node[path[-1]]
    return False, None


def pin_key(pin):
    return ".".join(pin["path"])


def decide(config, pin, written):
    present, value = lookup(config, pin["path"])
    fallback = pin.get("fallback")
    if fallback and value is None:
        # The agent reads the fallback key when the primary one is unset or
        # null. Hivra never writes it, so whatever it holds (null included) is
        # the owner's, and a primary key set here would shadow it.
        parent = config.get(fallback[0])
        if isinstance(parent, dict) and fallback[1] in parent:
            return "owner"
    if not present or (value is None and pin["nullIsUnset"]):
        return "missing"
    current = as_number(value)
    if current is None:
        # An explicit null where it means "off", or anything that is not a number.
        return "owner"
    if current in written:
        # The value Hivra wrote, unchanged since.
        return "pinned" if current == float(pin["desired"]) else "replaceable"
    if current in [float(item) for item in pin["stock"]]:
        return "replaceable"
    return "owner"


def read_record(path):
    """Values Hivra wrote, per pinned key; empty when there is no usable record."""
    if not path.exists() and not path.is_symlink():
        return {}
    try:
        if path.is_symlink() or not path.is_file():
            raise ValueError("not a regular file")
        data = json.loads(path.read_text("utf-8"))
        written = data.get("written") if isinstance(data, dict) else None
        if not isinstance(written, dict):
            raise ValueError("no written values")
        record = {}
        for key, values in written.items():
            if isinstance(key, str) and isinstance(values, list):
                numbers = [as_number(item) for item in values if not isinstance(item, str)]
                record[key] = sorted(set(item for item in numbers if item is not None))
        return record
    except (OSError, ValueError, UnicodeDecodeError):
        # Fail safe: without a record, values Hivra wrote read as the owner's.
        print(LABEL + " ignoring an unusable record at " + str(path), file=sys.stderr)
        return {}


def write_record(path, record, metadata):
    written = {}
    for key, values in sorted(record.items()):
        written[key] = [int(item) if float(item).is_integer() else item for item in values]
    payload = (json.dumps({"version": 1, "written": written}, sort_keys=True) + "\n").encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        # Replaces a planted symlink itself, never its target.
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


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


def repair(path, pins, written, backup_suffix, record_path):
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
    decisions = [decide(config, pin, written.get(pin_key(pin), [])) for pin in pins]
    patched = source
    expected = copy.deepcopy(config)
    for pin, decision in zip(pins, decisions):
        if decision not in ("missing", "replaceable"):
            continue
        text, value = render(pin["desired"])
        patched = patch(patched, pin["path"], text)
        expect(expected, pin["path"], value)
    metadata = path.stat()
    if patched != source:
        if yaml.safe_load(patched) != expected:
            raise ValueError("session-retention repair would change unrelated configuration")
        if backup_suffix is not None:
            write_backup_once(path, original, metadata, backup_suffix)
        publish(path, patched.encode("utf-8"), original, metadata)
    if record_path is not None:
        # Only after config.yaml is final: an interrupted repair can then only
        # leave a Hivra value looking like the owner's, never the reverse. A key
        # the owner holds drops out, so an owner's later copy of a Hivra value
        # still reads as the owner's.
        record = {
            pin_key(pin): [float(pin["desired"])]
            for pin, decision in zip(pins, decisions)
            if decision in ("missing", "replaceable", "pinned")
        }
        if record != written:
            write_record(record_path, record, metadata)
    return ["set_from_" + d if d in ("missing", "replaceable") else d for d in decisions]


def main():
    pins = json.loads(sys.argv[1])
    backup_suffix, record_suffix = sys.argv[2], sys.argv[3]
    state, seed = Path(sys.argv[4]), Path(sys.argv[5])
    record_path = state.with_name(state.name + record_suffix)
    written = read_record(record_path)
    for path, is_state in ((state, True), (seed, False)):
        outcomes = repair(
            path,
            pins,
            written,
            backup_suffix if is_state else None,
            record_path if is_state else None,
        )
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
# webui-session-retention.ts). Sets each only when missing, still the value
# Hivra recorded writing, or a stock value; an owner's value is kept. One backup
# of the pre-repair file. A failure leaves config.yaml untouched and does not
# fail the update.
docker run --rm -i --network none --user 0:0 \\
  -v ${params.containerName}_webui-state:/state \\
  -v "$INSTANCE_DIR":/seed \\
  --entrypoint /opt/hermes/.venv/bin/python \\
  ${params.agentImage} - ${shellSingleQuote(pins)} ${shellSingleQuote(WEBUI_SESSION_RETENTION_BACKUP_SUFFIX)} ${shellSingleQuote(WEBUI_SESSION_RETENTION_RECORD_SUFFIX)} /state/config.yaml /seed/config.yaml <<'HERMES_SESSION_RETENTION_PY' || echo "[webui-update] WARN: could not pin the web-chat session retention settings; config.yaml left as it was" >&2
${WEBUI_SESSION_RETENTION_CONFIG_SYNC_PYTHON}
HERMES_SESSION_RETENTION_PY
`;
}
