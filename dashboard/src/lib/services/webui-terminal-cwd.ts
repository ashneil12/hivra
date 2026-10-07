/**
 * The directory a Hermes box's dashboard file tree and agent terminal open in.
 *
 * Upstream's `_fs_default_cwd` (hermes_cli/web_routers/files.py) reads
 * `terminal.cwd` from config.yaml BEFORE the TERMINAL_CWD env var, and the
 * agent's config default is `.`, so without a value here the file tree opens at
 * the agent's install directory instead of the owner's workspace. The agent fork
 * no longer carries a patch for this (see .hermesos/WEBCHAT_SEAMS.md on its
 * rebase onto upstream v2026.9.24), so Hivra seeds the key itself.
 *
 * Only for the local terminal backend. With docker, modal or daytona the key is
 * also the working directory inside the remote sandbox, where /workspace (the
 * box's workspace volume) need not exist, so those boxes keep the agent's
 * default.
 *
 * Fresh provisions get `terminal.cwd` from buildWebUIConfigYaml. Update mode
 * preserves the box's config.yaml, so buildWebUITerminalCwdRepairCommand repairs
 * existing boxes on every update: it sets the key only when it is missing (or
 * null) or still the stock `.`, and keeps any other value as the owner's. A box
 * whose config says a non-local backend is left alone.
 */

/** Where the box's workspace volume is mounted for the gateway and dashboard. */
export const WEBUI_TERMINAL_CWD = "/workspace";

/** Prefix of the one-time backup of /state/config.yaml taken before a repair changes it. */
export const WEBUI_TERMINAL_CWD_BACKUP_INFIX = ".bak.";

/** The `terminal:` lines buildWebUIConfigYaml emits after `backend:` for a backend. */
export function buildWebUITerminalCwdConfigYaml(backend: string): string {
  return backend === "local" ? `  cwd: "${WEBUI_TERMINAL_CWD}"\n` : "";
}

// Runs with the agent image's Python/PyYAML (like WEBUI_TERMINAL_CONFIG_SYNC_PYTHON
// and the session-retention repair). Edits only terminal.cwd in place, keeping the
// owner's comments, ordering and every other setting; a parsed before/after
// comparison refuses any edit that would change anything else (aliases, duplicate
// keys, unexpected shapes). All or nothing per file: a file it cannot safely edit
// is left exactly as it was. Idempotent: a second run finds the value set and
// changes nothing, so it takes no backup.
// argv: <cwd> <backup infix> <state config.yaml> <seed config.yaml>
export const WEBUI_TERMINAL_CWD_REPAIR_PYTHON = String.raw`
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import yaml

LABEL = "[webui-terminal-cwd]"


def decide(config):
    terminal = config.get("terminal")
    if terminal is None:
        return "set_from_missing"
    if not isinstance(terminal, dict):
        raise ValueError("terminal config must be a YAML mapping")
    backend = terminal.get("backend")
    if backend is not None and str(backend).strip().strip("\"'") != "local":
        return "skipped_non_local_backend"
    if "cwd" not in terminal or terminal["cwd"] is None:
        return "set_from_missing"
    if isinstance(terminal["cwd"], str) and terminal["cwd"].strip() == ".":
        return "set_from_stock"
    return "kept_owner_value"


def set_in_mapping(source, mapping, key, text, newline):
    keys = [(k, node) for k, node in mapping.value if k.value == key]
    if len(keys) > 1:
        raise ValueError("duplicate " + key + " keys require manual repair")
    if keys:
        value_key, value_node = keys[0]
        if not isinstance(value_node, yaml.ScalarNode) or value_node.start_mark.index < value_key.end_mark.index:
            raise ValueError(key + " must be an explicit scalar")
        start = value_node.start_mark.index
        end = value_node.end_mark.index
        if start == end:
            # An empty value ("cwd:"): the node has no text of its own, so the
            # new value goes right after the colon.
            start = end = value_key.end_mark.index + 1
            if source[value_key.end_mark.index:start] != ":":
                raise ValueError(key + " must be an explicit scalar")
            return source[:start] + " " + text + source[end:]
        prefix = " " if source[:start].endswith(":") else ""
        return source[:start] + prefix + text + source[end:]
    if mapping.flow_style:
        offset = mapping.end_mark.index - 1
        return source[:offset] + (", " if mapping.value else "") + key + ": " + text + source[offset:]
    first_key = mapping.value[0][0]
    offset = first_key.start_mark.index
    return source[:offset] + key + ": " + text + newline + (" " * first_key.start_mark.column) + source[offset:]


def patch(source, value):
    text = json.dumps(value)
    document = yaml.compose(source)
    if document is not None and not isinstance(document, yaml.MappingNode):
        raise ValueError("config must be a YAML mapping")
    newline = "\r\n" if "\r\n" in source else "\n"
    entries = [] if document is None else document.value
    sections = [(k, node) for k, node in entries if k.value == "terminal"]
    if len(sections) > 1:
        raise ValueError("duplicate terminal sections require manual repair")
    if not sections:
        if document is not None and document.flow_style:
            offset = document.end_mark.index - 1
            return source[:offset] + (", " if document.value else "") + "terminal: {cwd: " + text + "}" + source[offset:]
        offset = len(source) if document is None else document.end_mark.index
        indent = ""
        if document is not None and document.value:
            indent = " " * document.value[0][0].start_mark.column
        addition = indent + "terminal:" + newline + indent + "  cwd: " + text + newline
        prefix = newline if source[:offset] and not source[:offset].endswith(("\n", "\r")) else ""
        return source[:offset] + prefix + addition + source[offset:]
    section_key, section_node = sections[0]
    # An alias points its node marks at the anchor, which could belong to a
    # different setting. Never edit the anchor as a side effect.
    if section_node.start_mark.index < section_key.end_mark.index:
        raise ValueError("aliased terminal config requires an explicit mapping")
    if isinstance(section_node, yaml.MappingNode):
        return set_in_mapping(source, section_node, "cwd", text, newline)
    if isinstance(section_node, yaml.ScalarNode) and section_node.tag == "tag:yaml.org,2002:null":
        offset = section_node.start_mark.index
        if offset == section_node.end_mark.index:
            offset = section_key.end_mark.index + 1
            return source[:offset] + " {cwd: " + text + "}" + source[offset:]
        prefix = " " if source[:offset].endswith(":") else ""
        return source[:offset] + prefix + "{cwd: " + text + "}" + source[section_node.end_mark.index:]
    raise ValueError("terminal config must be a YAML mapping")


def write_backup(path, original, metadata, infix):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(path.name + infix + stamp)
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
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".terminal-cwd-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        if path.read_bytes() != original:
            raise RuntimeError("config changed during the terminal.cwd repair; retry the update")
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def repair(path, desired, backup_infix):
    if path.is_symlink():
        raise ValueError("terminal.cwd repair will not replace a symlinked config")
    if not path.exists():
        return "absent", None
    original = path.read_bytes()
    source = original.decode("utf-8")
    config = yaml.safe_load(source)
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("config must be a YAML mapping")
    decision = decide(config)
    if decision not in ("set_from_missing", "set_from_stock"):
        return decision, None
    patched = patch(source, desired)
    expected = dict(config)
    expected["terminal"] = dict(config.get("terminal") or {}, cwd=desired)
    if yaml.safe_load(patched) != expected:
        raise ValueError("terminal.cwd repair would change unrelated configuration")
    metadata = path.stat()
    backup = write_backup(path, original, metadata, backup_infix) if backup_infix is not None else None
    publish(path, patched.encode("utf-8"), original, metadata)
    return decision, backup


def main():
    desired, backup_infix, state_name, seed_name = sys.argv[1:]
    for name, infix in ((state_name, backup_infix), (seed_name, None)):
        decision, backup = repair(Path(name), desired, infix)
        print(
            LABEL + " " + name + ": terminal.cwd " + decision + " (pin " + desired + ")"
            + (" backup=" + str(backup) if backup else "")
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
 * Update-mode step for buildWebUIBootstrapScript: set terminal.cwd in the
 * persisted /state/config.yaml (and the instance-dir copy) with the agent
 * image's Python. Never fails the update: a config it cannot safely edit is left
 * as is, with the reason on stderr.
 */
export function buildWebUITerminalCwdRepairCommand(params: {
  containerName: string;
  agentImage: string;
}): string {
  return `# Point the dashboard file tree and terminal at the workspace volume
# (terminal.cwd) in the persisted config.yaml. Upstream reads this key before
# TERMINAL_CWD, and the stock "." opens the agent's install directory (see
# webui-terminal-cwd.ts). Sets it only when missing or "."; an owner's value and
# a non-local terminal backend are kept. One timestamped backup, taken only when
# the file changes. A failure leaves config.yaml untouched and does not fail the
# update.
docker run --rm -i --network none --user 0:0 \\
  -v ${params.containerName}_webui-state:/state \\
  -v "$INSTANCE_DIR":/seed \\
  --entrypoint /opt/hermes/.venv/bin/python \\
  ${params.agentImage} - ${shellSingleQuote(WEBUI_TERMINAL_CWD)} ${shellSingleQuote(WEBUI_TERMINAL_CWD_BACKUP_INFIX)} /state/config.yaml /seed/config.yaml <<'HERMES_TERMINAL_CWD_PY' || echo "[webui-update] WARN: could not set terminal.cwd; config.yaml left as it was" >&2
${WEBUI_TERMINAL_CWD_REPAIR_PYTHON}
HERMES_TERMINAL_CWD_PY
`;
}
