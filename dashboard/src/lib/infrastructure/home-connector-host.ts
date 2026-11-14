// A machine reached through the outbound connector has no address Hivra can
// dial. Its connection carries this reserved name instead, built from the
// connector id. `.invalid` never resolves in DNS, so the name can never become
// a direct network connection: the only thing that understands it is the relay
// path, and only when the home connector flag is on.

const CONNECTOR_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CONNECTOR_HOST = new RegExp(`^(${CONNECTOR_ID})\\.connector\\.hivra\\.invalid$`);

export function connectorHostname(connectorId: string): string {
  return `${connectorId.toLowerCase()}.connector.hivra.invalid`;
}

/** The connector id a reserved name stands for, or null for any other host. */
export function parseConnectorHostname(host: string | null | undefined): string | null {
  if (typeof host !== "string") return null;
  const match = CONNECTOR_HOST.exec(host.trim().toLowerCase());
  return match ? match[1] : null;
}

/** True when the name is in the reserved connector namespace at all, even if malformed. */
export function isConnectorNamespace(host: string | null | undefined): boolean {
  return typeof host === "string" && host.trim().toLowerCase().endsWith(".connector.hivra.invalid");
}
