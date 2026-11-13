// The chat safety net: public chat services an agent with no profile (or a
// profile that does not know a channel) may still be connected to. The server
// resolves these names when it probes and hands the probe the addresses in
// the form /proc/net/tcp prints them; the probe never resolves anything.
//
// A connection the probe finds to one of them that no declared channel's own
// process holds is reported as the live channel "unknown:<platform>". No wake
// adapter ever covers an unknown channel, so the agent stays awake.
//
// Matching by address is approximate. A service behind a shared edge (Discord's
// gateway, matrix.org) shares addresses with other sites, so an unrelated
// connection can match too. That errs toward awake, which is the safe side.
//
// Pure (no server imports): the sleep scripts and the tests use it.

export interface ChatServiceEndpoints {
  platform: string;
  hosts: readonly string[];
  ports: readonly number[];
}

export const CHAT_SERVICE_ENDPOINTS: readonly ChatServiceEndpoints[] = [
  { platform: "telegram", hosts: ["api.telegram.org"], ports: [443, 80, 88, 8443] },
  { platform: "discord", hosts: ["gateway.discord.gg"], ports: [443] },
  { platform: "slack", hosts: ["wss-primary.slack.com", "wss-backup.slack.com"], ports: [443] },
  { platform: "whatsapp", hosts: ["web.whatsapp.com", "g.whatsapp.net"], ports: [443, 5222] },
  { platform: "matrix", hosts: ["matrix-client.matrix.org"], ports: [443, 8448] },
  { platform: "signal", hosts: ["chat.signal.org"], ports: [443] },
];

/** What the probe gets: per platform, the remote ports and addresses in /proc/net form. */
export interface ProbeEndpoint {
  p: string;
  ports: number[];
  a: string[];
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

function v4Bytes(address: string): number[] | null {
  const m = IPV4.exec(address);
  if (!m) return null;
  const bytes = m.slice(1).map(Number);
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function v6Bytes(address: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(address) || !address.includes(":")) return null;
  let text = address;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = v4Bytes(text.slice(lastColon + 1));
    if (!v4) return null;
    tail.push(...v4);
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if ((halves.length === 2 && fill < 1) || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const bytes = groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/**
 * An address as /proc/net/tcp or tcp6 prints it: each 32-bit word in the
 * kernel's (little-endian) order. An IPv4 address gives both its tcp form and
 * its IPv4-mapped tcp6 form. Null for anything that is not an address.
 */
export function procNetAddresses(address: string): string[] | null {
  const v4 = v4Bytes(address);
  const word = (bytes: number[]) => [...bytes].reverse().map(hex2).join("");
  if (v4) {
    const h = word(v4);
    return [h, `0000000000000000FFFF0000${h}`];
  }
  const v6 = v6Bytes(address);
  if (!v6) return null;
  return [[0, 4, 8, 12].map((i) => word(v6.slice(i, i + 4))).join("")];
}

/** The probe's endpoint list from resolved addresses per platform. Unusable addresses are dropped. */
export function probeEndpoints(resolved: Readonly<Record<string, readonly string[]>>): ProbeEndpoint[] {
  const out: ProbeEndpoint[] = [];
  for (const service of CHAT_SERVICE_ENDPOINTS) {
    const addrs = new Set<string>();
    for (const address of resolved[service.platform] ?? []) {
      for (const a of procNetAddresses(address) ?? []) addrs.add(a);
    }
    if (addrs.size > 0) out.push({ p: service.platform, ports: [...service.ports], a: [...addrs].sort().slice(0, 64) });
  }
  return out;
}
