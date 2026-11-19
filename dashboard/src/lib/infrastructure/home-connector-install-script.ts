import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { validateTrustedAppOrigin } from "./trusted-app-origin";

/** The connector's own files, byte for byte the ones in services/host-connector
 * (a test keeps the two copies identical). The installer carries them inline, so
 * the one command downloads one script and nothing else. */
export const HOME_CONNECTOR_FILES = ["hivra_connector.py", "hivra-connector.service", "install.sh"] as const;
const FILES_DIR = "bootstrap/home-connector";
const MAX_FILE_BYTES = 128 * 1024;

export class HomeConnectorScriptError extends Error {
  constructor() {
    super("Home connector installer unavailable");
    this.name = "HomeConnectorScriptError";
  }
}

const HEAD = (origin: string) => `#!/usr/bin/env bash
# Hivra: install the connector on this machine. It only dials out to Hivra's
# relay; nothing on your router or firewall changes. Source:
# https://github.com/ashneil12/hivra/tree/canary/services/host-connector
set -euo pipefail
origin='${origin}'
token="\${1:-}"
if ! [[ "$token" =~ ^hvc_[A-Za-z0-9_-]{32}$ ]]; then
  echo "Use the full command from Hivra, including the code at the end." >&2
  exit 1
fi
[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }
for tool in curl base64 mktemp; do
  command -v "$tool" >/dev/null || { echo "$tool is required." >&2; exit 1; }
done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
`;

const TAIL = `
# The code works once and expires in 15 minutes. The secret it returns is
# written to the connector's own config (root and its service user only) and
# never printed.
if ! curl -fsS --max-time 30 -X POST -H 'content-type: application/json' \\
  --data "{\\"token\\":\\"$token\\"}" "$origin/api/infrastructure/home-connector/enrol" > "$tmp/config.json"; then
  echo "Hivra did not accept that code. It may have expired or been used. Get a new command in Hivra." >&2
  exit 1
fi
bash "$tmp/install.sh" < "$tmp/config.json"
`;

export async function renderHomeConnectorInstaller(
  origin: string,
  read: (path: string) => Promise<Buffer> = readFile,
): Promise<string> {
  const safeOrigin = validateTrustedAppOrigin(origin);
  let body = HEAD(safeOrigin);
  for (const name of HOME_CONNECTOR_FILES) {
    let file: Buffer;
    try {
      file = await read(join(process.cwd(), FILES_DIR, name));
    } catch {
      throw new HomeConnectorScriptError();
    }
    if (file.length === 0 || file.length > MAX_FILE_BYTES) throw new HomeConnectorScriptError();
    body += `base64 -d > "$tmp/${name}" <<'HIVRA_B64'\n${file.toString("base64").replace(/(.{76})/g, "$1\n")}\nHIVRA_B64\n`;
  }
  return body + TAIL;
}
