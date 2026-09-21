type TerminalBackend = "local" | "docker" | "modal" | "daytona";

/** Keep the persisted YAML and env overrides on the same supported backend. */
export function resolveWebUITerminalBackend(settings: {
  terminalBackend?: TerminalBackend;
  gatewayDockerAccess?: boolean;
  daytonaApiKey?: string;
}): TerminalBackend {
  if (settings.terminalBackend === "modal") return "modal";
  if (settings.terminalBackend === "daytona" && settings.daytonaApiKey?.trim()) return "daytona";
  if (settings.terminalBackend === "docker" && settings.gatewayDockerAccess === true) return "docker";
  return "local";
}

// Runs with the agent image's Python/PyYAML, not with an added host dependency.
// Upstream bridges terminal.backend from config.yaml over TERMINAL_ENV. Change
// that one key in the existing document, retaining the owner's image, other
// terminal options, comments and unrelated config. Parsed before/after equality
// rejects ambiguous aliases or unsupported shapes instead of corrupting them.
export const WEBUI_TERMINAL_CONFIG_SYNC_PYTHON = String.raw`
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import yaml


def patch_backend(source, backend):
    if backend not in ("local", "docker", "modal", "daytona"):
        raise ValueError("unsupported terminal backend")
    config = yaml.safe_load(source)
    document = yaml.compose(source)
    if config is None and document is None:
        config = {}
    if not isinstance(config, dict) or (document is not None and not isinstance(document, yaml.MappingNode)):
        raise ValueError("runtime config must be a YAML mapping")
    terminal = config.get("terminal")
    if terminal is None:
        terminal = {}
    if not isinstance(terminal, dict):
        raise ValueError("terminal config must be a YAML mapping")
    if terminal.get("backend") == backend:
        return source
    expected = dict(config)
    expected["terminal"] = dict(terminal, backend=backend)
    value = json.dumps(backend)
    newline = "\r\n" if "\r\n" in source else "\n"
    entries = [] if document is None else document.value
    terminal_entries = [(key, node) for key, node in entries if key.value == "terminal"]
    if len(terminal_entries) > 1:
        raise ValueError("duplicate terminal sections require manual repair")
    if not terminal_entries:
        if document is not None and document.flow_style:
            offset = document.end_mark.index - 1
            addition = yaml.safe_dump({"terminal": expected["terminal"]}, default_flow_style=True, sort_keys=False).strip()[1:-1]
            patched = source[:offset] + (", " if entries else "") + addition + source[offset:]
        else:
            offset = len(source) if document is None else document.end_mark.index
            addition = yaml.safe_dump({"terminal": expected["terminal"]}, sort_keys=False).replace("\n", newline)
            prefix = newline if source[:offset] and not source[:offset].endswith(("\n", "\r")) else ""
            patched = source[:offset] + prefix + addition + source[offset:]
    else:
        terminal_key, terminal_node = terminal_entries[0]
        # An alias points its node marks at the anchor, which could belong to a
        # different setting. Never edit the anchor as a side effect.
        if terminal_node.start_mark.index < terminal_key.end_mark.index:
            raise ValueError("aliased terminal config requires an explicit terminal mapping")
        if isinstance(terminal_node, yaml.MappingNode):
            backends = [(key, node) for key, node in terminal_node.value if key.value == "backend"]
            if len(backends) > 1:
                raise ValueError("duplicate terminal backends require manual repair")
            if backends:
                backend_key, backend_node = backends[0]
                if not isinstance(backend_node, yaml.ScalarNode) or backend_node.start_mark.index < backend_key.end_mark.index:
                    raise ValueError("terminal backend must be an explicit scalar")
                patched = source[:backend_node.start_mark.index] + value + source[backend_node.end_mark.index:]
            elif terminal_node.flow_style:
                offset = terminal_node.end_mark.index - 1
                patched = source[:offset] + (", " if terminal_node.value else "") + "backend: " + value + source[offset:]
            else:
                first_key = terminal_node.value[0][0]
                offset = first_key.start_mark.index
                patched = source[:offset] + "backend: " + value + newline + (" " * first_key.start_mark.column) + source[offset:]
        elif isinstance(terminal_node, yaml.ScalarNode) and terminal_node.tag == "tag:yaml.org,2002:null":
            offset = terminal_node.start_mark.index
            prefix = " " if source[:offset].endswith(":") else ""
            patched = source[:offset] + prefix + "{backend: " + value + "}" + source[terminal_node.end_mark.index:]
        else:
            raise ValueError("terminal config must be a YAML mapping")
    if yaml.safe_load(patched) != expected:
        raise ValueError("terminal sync would change unrelated configuration")
    return patched


def publish(path, payload, original):
    if payload == original:
        return
    metadata = path.stat() if original is not None else None
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".terminal-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode) if metadata else 0o600)
        os.chown(temporary, metadata.st_uid if metadata else 1024, metadata.st_gid if metadata else 1024)
        current = path.read_bytes() if path.exists() else None
        if current != original:
            raise RuntimeError("runtime config changed during terminal sync; retry apply")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    backend, state_name, seed_name = sys.argv[1:]
    state, seed = Path(state_name), Path(seed_name)
    if state.is_symlink() or seed.is_symlink():
        raise ValueError("terminal sync will not replace a symlinked runtime config")
    originals = {path: path.read_bytes() if path.exists() else None for path in (state, seed)}
    source = originals[state] if originals[state] is not None else originals[seed]
    if source is None:
        raise ValueError("runtime config is missing")
    payload = patch_backend(source.decode("utf-8"), backend).encode("utf-8")
    publish(state, payload, originals[state])
    publish(seed, payload, originals[seed])
    print("[webui-terminal-config] terminal.backend=" + backend + "; other config preserved")


if __name__ == "__main__":
    try:
        main()
    except (yaml.YAMLError, UnicodeDecodeError):
        # Parser errors include source lines, which may contain API keys.
        print("[webui-terminal-config] cannot parse saved YAML; no config changes applied", file=sys.stderr)
        sys.exit(1)
`;
