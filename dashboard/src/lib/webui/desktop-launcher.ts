// Nous Hermes Desktop one-time setup-script generator.
//
// The Desktop app reads its connection settings from a JSON file in its
// userData dir (apps/desktop/electron/main.cjs → readDesktopConnectionConfig,
// DESKTOP_CONNECTION_CONFIG_PATH = <userData>/connection.json). On launch,
// `resolveRemoteBackend()` checks that file BEFORE the local installer — so a
// saved `mode:"remote"` connects to the remote backend and skips the install
// screen entirely, even on a fresh machine.
//
// Crucially, the token does NOT have to be Keychain-encrypted: decryptDesktopSecret
// returns `token.value` verbatim unless `token.encoding === "safeStorage"`. So a
// script can write the file with a PLAINTEXT token — no Electron, no env vars, no
// manual paste — and the connection PERSISTS across restarts and self-updates
// (the file lives in userData, which survives updates).
//
// userData dir per OS (productName "Hermes", unless HERMES_DESKTOP_USER_DATA_DIR
// overrides it):
//   macOS   ~/Library/Application Support/Hermes/connection.json
//   Windows %APPDATA%\Hermes\connection.json
//   Linux   ~/.config/Hermes/connection.json   (XDG_CONFIG_HOME honored)
//
// Pure module (no server-only import) so the connect-modal can build the
// downloads client-side without a second round-trip for the secret.

export type DesktopLauncherOS = "macos" | "linux" | "windows";

export interface DesktopConnection {
  gatewayUrl: string;
  token: string;
}

export const DESKTOP_DOWNLOAD_URL =
  "https://hermes-agent.nousresearch.com/desktop";

/** The exact connection.json the Desktop app reads (plaintext token). */
export function buildDesktopConnectionConfig(conn: DesktopConnection): string {
  return JSON.stringify({
    mode: "remote",
    remote: { url: conn.gatewayUrl, token: { value: conn.token } },
  });
}

// Single-quote for POSIX shells; ' inside is closed-escaped-reopened. The
// config JSON uses only double quotes + url-safe chars, but quote defensively.
function shSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * One-time setup script: writes connection.json (persistent), then relaunches
 * Hermes so it picks up the saved backend. After running once, the user just
 * opens Hermes normally — it stays connected.
 */
export function buildDesktopLauncherScript(
  os: DesktopLauncherOS,
  conn: DesktopConnection
): string {
  const cfg = buildDesktopConnectionConfig(conn);

  if (os === "windows") {
    // JSON single-quoted in PowerShell (JSON has no single quotes).
    return `# Connect Hermes Desktop to your Hivra instance (one time).
# Right-click > Run with PowerShell. After this, just open Hermes normally —
# it stays connected. The token below is your instance credential; keep it private.
$ErrorActionPreference = 'SilentlyContinue'
$dir = "$env:APPDATA\\Hermes"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
'${cfg.replace(/'/g, "''")}' | Set-Content -Path "$dir\\connection.json" -Encoding utf8 -NoNewline
Write-Host "Saved Hivra connection."
$exe = "$env:LOCALAPPDATA\\Programs\\Hermes\\Hermes.exe"
if (-not (Test-Path $exe)) {
  Write-Host "Hermes Desktop isn't installed - opening the download page."
  Start-Process "${DESKTOP_DOWNLOAD_URL}"
  exit
}
Get-Process Hermes -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
# First launch bypasses the fresh-install installer via env vars; the saved
# connection.json keeps normal launches connected afterwards.
$env:HERMES_DESKTOP_REMOTE_URL = '${conn.gatewayUrl.replace(/'/g, "''")}'
$env:HERMES_DESKTOP_REMOTE_TOKEN = '${conn.token.replace(/'/g, "''")}'
& $exe
Write-Host "Connected. From now on, just open Hermes normally."
`;
  }

  if (os === "linux") {
    return `#!/bin/bash
# Connect Hermes Desktop to your Hivra instance (one time).
# chmod +x this file and run it. After this, just open Hermes normally — it
# stays connected. The token below is your instance credential; keep it private.
set -e
DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/Hermes"
mkdir -p "$DIR"
printf '%s' ${shSingle(cfg)} > "$DIR/connection.json"
echo "Saved Hivra connection."
BIN="$(command -v hermes-desktop || command -v hermes || true)"
if [ -z "$BIN" ]; then
  echo "Hermes Desktop isn't installed - opening the download page."
  ( xdg-open "${DESKTOP_DOWNLOAD_URL}" >/dev/null 2>&1 & ) || true
  exit 0
fi
pkill -f "hermes-desktop|Hermes.AppImage|/hermes$" 2>/dev/null || true
sleep 2
# First launch bypasses the fresh-install installer via env vars; the saved
# connection.json keeps normal launches connected afterwards.
( HERMES_DESKTOP_REMOTE_URL=${shSingle(conn.gatewayUrl)} HERMES_DESKTOP_REMOTE_TOKEN=${shSingle(conn.token)} "$BIN" >/dev/null 2>&1 & )
echo "Connected. From now on, just open Hermes normally."
`;
  }

  // macOS
  return `#!/bin/bash
# Connect Hermes Desktop to your Hivra instance (one time).
# Double-click this file. First run: if macOS blocks it, right-click > Open.
# After this, just open Hermes normally — it stays connected. The token below is
# your instance credential; keep it private.
set -e
DIR="$HOME/Library/Application Support/Hermes"
mkdir -p "$DIR"
printf '%s' ${shSingle(cfg)} > "$DIR/connection.json"
echo "Saved Hivra connection."
if [ ! -d "/Applications/Hermes.app" ]; then
  echo "Hermes Desktop isn't installed - opening the download page."
  open "${DESKTOP_DOWNLOAD_URL}"
  exit 0
fi
osascript -e 'quit app "Hermes"' >/dev/null 2>&1 || pkill -f "Hermes.app/Contents/MacOS/" 2>/dev/null || true
sleep 2
# First launch must bypass the fresh-install installer (which ignores the saved
# config); env vars short-circuit straight to the remote backend. After this run,
# the saved connection.json keeps normal dock launches connected.
BIN="/Applications/Hermes.app/Contents/MacOS/$(ls -1 /Applications/Hermes.app/Contents/MacOS/ | head -1)"
HERMES_DESKTOP_REMOTE_URL=${shSingle(conn.gatewayUrl)} HERMES_DESKTOP_REMOTE_TOKEN=${shSingle(conn.token)} nohup "$BIN" >/dev/null 2>&1 &
echo "Connected. From now on, just open Hermes normally."
`;
}

/** One-liner alternative (writes the config inline), for users who'd rather paste. */
export function buildDesktopInlineCommand(
  os: DesktopLauncherOS,
  conn: DesktopConnection
): string {
  const cfg = buildDesktopConnectionConfig(conn);
  const url = conn.gatewayUrl;
  const tok = conn.token;
  if (os === "windows") {
    return `$d="$env:APPDATA\\Hermes"; ni -ItemType Directory -Force $d|Out-Null; '${cfg.replace(/'/g, "''")}'|Set-Content "$d\\connection.json" -NoNewline; Get-Process Hermes -EA 0|Stop-Process -Force; $env:HERMES_DESKTOP_REMOTE_URL='${url.replace(/'/g, "''")}'; $env:HERMES_DESKTOP_REMOTE_TOKEN='${tok.replace(/'/g, "''")}'; saps "$env:LOCALAPPDATA\\Programs\\Hermes\\Hermes.exe"`;
  }
  const dir =
    os === "macos"
      ? '"$HOME/Library/Application Support/Hermes"'
      : '"${XDG_CONFIG_HOME:-$HOME/.config}/Hermes"';
  // env-launch (not `open`) so a fresh install bypasses the installer; the saved
  // config keeps normal launches connected afterwards.
  const relaunch =
    os === "macos"
      ? `osascript -e 'quit app "Hermes"' 2>/dev/null; sleep 2; ( HERMES_DESKTOP_REMOTE_URL=${shSingle(url)} HERMES_DESKTOP_REMOTE_TOKEN=${shSingle(tok)} "/Applications/Hermes.app/Contents/MacOS/Hermes" >/dev/null 2>&1 & )`
      : `pkill -f hermes-desktop 2>/dev/null; sleep 2; ( HERMES_DESKTOP_REMOTE_URL=${shSingle(url)} HERMES_DESKTOP_REMOTE_TOKEN=${shSingle(tok)} "$(command -v hermes-desktop || command -v hermes)" >/dev/null 2>&1 & )`;
  return `mkdir -p ${dir} && printf '%s' ${shSingle(cfg)} > ${dir}/connection.json && ${relaunch}`;
}

/** Suggested filename for the downloaded setup script. */
export function desktopLauncherFilename(os: DesktopLauncherOS): string {
  switch (os) {
    case "macos":
      return "connect-hermesos.command";
    case "linux":
      return "connect-hermesos.sh";
    case "windows":
      return "connect-hermesos.ps1";
  }
}
