import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { validateTrustedAppOrigin } from "@/lib/infrastructure/trusted-app-origin";

/** The bridge's own files, byte for byte the ones in services/host-connector (a test keeps the
 * two copies identical). The installer carries them inline, so the one command downloads one
 * script and nothing else. */
export const BRIDGE_FILES = ["hivra_bridge.py", "hivra_connector.py"] as const;
export const BRIDGE_SCRIPT = "install-bridge.sh";
const FILES_DIR = "bootstrap/local-bridge";
const MAX_FILE_BYTES = 256 * 1024;

export class BridgeScriptError extends Error {
  constructor() {
    super("Bridge installer unavailable");
    this.name = "BridgeScriptError";
  }
}

export async function renderBridgeInstaller(
  origin: string,
  read: (path: string) => Promise<Buffer> = readFile,
): Promise<string> {
  const safeOrigin = validateTrustedAppOrigin(origin);
  const load = async (name: string) => {
    let file: Buffer;
    try {
      file = await read(join(process.cwd(), FILES_DIR, name));
    } catch {
      throw new BridgeScriptError();
    }
    if (file.length === 0 || file.length > MAX_FILE_BYTES) throw new BridgeScriptError();
    return file;
  };
  const template = (await load(BRIDGE_SCRIPT)).toString("utf8");
  if (!template.includes("@@ORIGIN@@") || !template.includes("# @@FILES@@")) throw new BridgeScriptError();
  let files = "";
  for (const name of BRIDGE_FILES) {
    const body = (await load(name)).toString("base64").replace(/(.{76})/g, "$1\n");
    files += `base64 -d > "$program_dir/${name}" <<'HIVRA_B64'\n${body}\nHIVRA_B64\n`;
  }
  return template.replace("@@ORIGIN@@", () => safeOrigin).replace("# @@FILES@@\n", () => files);
}
