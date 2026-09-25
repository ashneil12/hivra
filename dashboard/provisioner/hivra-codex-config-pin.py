"""Turn off Codex's startup update check for the computer owner.

Codex's TUI checks for, and offers to install, a new release on every start
(config key check_for_update_on_startup, default true). Hivra installs the
vetted version from agent-cli-versions.json instead, so a self-update must not
swap the binary the chat gateway runs. Runs as the owner (never root) with the
script on stdin. Only an absent top-level key is set, so an owner's explicit
choice stays; the rest of the file is kept byte for byte.
"""
import os
import re
import sys
import tempfile

KEY = "check_for_update_on_startup"
path = os.path.join(os.environ["HOME"], ".codex", "config.toml")
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
try:
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    mode = os.stat(path).st_mode & 0o777
except FileNotFoundError:
    text, mode = "", 0o600

# Top-level keys end at the first table header.
for line in text.splitlines():
    if re.match(r"\s*\[", line):
        break
    if re.match(r"\s*" + KEY + r"\s*=", line):
        print("HIVRA_CODEX_UPDATE_CHECK kept")
        sys.exit(0)

descriptor, staged = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".config.toml.")
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write("# Hivra installs the vetted Codex version (agent-cli-versions.json).\n")
        handle.write(KEY + " = false\n")
        handle.write(text)
    os.chmod(staged, mode)
    # Replaces the path itself; a symlink there is replaced, never followed.
    os.replace(staged, path)
except BaseException:
    os.unlink(staged)
    raise
print("HIVRA_CODEX_UPDATE_CHECK off")
