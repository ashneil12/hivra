import { createHash } from "crypto";

export function deriveBrowserVncPassword(apiServerKey: string): string {
  return createHash("sha256")
    .update(`${apiServerKey}:browser-vnc`)
    .digest("hex")
    .slice(0, 24);
}

export function buildBrowserVncWebSocketUrl(gatewayBase: string): string {
  const gatewayUrl = new URL(gatewayBase);
  const wsProtocol = gatewayUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${gatewayUrl.host}/vnc/websockify`;
}
