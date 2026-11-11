/**
 * Pure helpers for the "bring your own private network" feature: the client
 * version floor, the guest-side outbound block, the ready-made policy the owner
 * pastes into their own network, and NetBird address validation. Nothing here
 * touches a machine, so the Manage panel and the server both import it.
 *
 * Hivra never runs or pays for a shared network. The owner brings their own
 * Tailscale, Headscale or NetBird account, and these helpers keep the computer
 * from reaching the owner's other devices over it.
 */

/** Tailscale clients older than this are refused. 1.104.4 fixed the October 2026 Tailscale SSH and Serve findings. */
export const TAILSCALE_MIN_VERSION = "1.104.4";

/** Turns on NetBird and the policy help in the Manage panel. Off by default. */
export function isPrivateNetworkV2Enabled(): boolean {
  return process.env.NEXT_PUBLIC_HIVRA_PRIVATE_NETWORK_V2 === "1";
}

export const PRIVATE_NETWORK_PROVIDERS = ["tailscale", "headscale", "netbird"] as const;
export type PrivateNetworkProvider = (typeof PRIVATE_NETWORK_PROVIDERS)[number];

export const DEFAULT_NETBIRD_MANAGEMENT_URL = "https://api.netbird.io";

/** The only tag Hivra asks owners to use. Nothing else is accepted anywhere. */
export const HIVRA_TAILNET_TAG = "tag:hivra";

export const TAILSCALE_INTERFACE = "tailscale0";
export const NETBIRD_INTERFACE = "wt0";

export const PRIVATE_ACCESS_FAILURE_MARKER = "HIVRA_PRIVATE_ACCESS_FAILURE";

// ---------------------------------------------------------------------------
// Version floor
// ---------------------------------------------------------------------------

/** First line of `tailscale version` (for example "1.104.6" or "1.105.0-t1a2b3c"), reduced to x.y.z. */
export function parseClientVersion(output: string): string | null {
  const first = output.split("\n", 1)[0]?.trim() ?? "";
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(first);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** True when `version` is at least `minimum`. Unreadable versions never pass. */
export function meetsMinimumVersion(version: string | null, minimum: string = TAILSCALE_MIN_VERSION): boolean {
  const have = version ? parseClientVersion(version) : null;
  const want = parseClientVersion(minimum);
  if (!have || !want) return false;
  const a = have.split(".").map(Number);
  const b = want.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** Guest shell, run after install and before `tailscale up`. Prints a failure code and exits 1 below the floor. */
export function buildTailscaleVersionFloorScript(minimum: string = TAILSCALE_MIN_VERSION): string {
  if (!/^\d+\.\d+\.\d+$/.test(minimum)) throw new Error("Invalid minimum version");
  return [
    `HIVRA_TS_MIN='${minimum}'`,
    "HIVRA_TS_VERSION=\"$(tailscale version 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)\"",
    "case \"$HIVRA_TS_VERSION\" in",
    "  [0-9]*.[0-9]*.[0-9]*) ;;",
    `  *) echo '${PRIVATE_ACCESS_FAILURE_MARKER} client_version_unreadable'; exit 1 ;;`,
    "esac",
    "HIVRA_TS_VERSION=\"${HIVRA_TS_VERSION%%[!0-9.]*}\"",
    "HIVRA_TS_LOWEST=\"$(printf '%s\\n%s\\n' \"$HIVRA_TS_MIN\" \"$HIVRA_TS_VERSION\" | sort -V | head -n 1)\"",
    "if [ \"$HIVRA_TS_LOWEST\" != \"$HIVRA_TS_MIN\" ]; then",
    `  echo '${PRIVATE_ACCESS_FAILURE_MARKER} client_too_old'`,
    "  exit 1",
    "fi",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Guest-side outbound block (defence in depth)
// ---------------------------------------------------------------------------

export const OUTBOUND_BLOCK_TABLE = "hivra_private_access";
export const OUTBOUND_BLOCK_UNIT = "hivra-private-access-block.service";
export const OUTBOUND_BLOCK_RULES_FILE = "/etc/hivra/private-access.nft";

function assertInterface(name: string): string {
  if (!/^[a-z][a-z0-9]{0,14}$/.test(name)) throw new Error("Invalid network interface name");
  return name;
}

/**
 * The nftables rules: in their own table, on the private-network interface only,
 * the computer may answer (established and related traffic) and use the
 * network's own name service, but may not start new connections to other
 * devices. Inbound connections, the computer's normal internet and Hivra's own
 * access path (all on other interfaces) are untouched.
 */
export function buildOutboundBlockRules(iface: string = TAILSCALE_INTERFACE): string {
  const name = assertInterface(iface);
  return [
    `table inet ${OUTBOUND_BLOCK_TABLE}`,
    `delete table inet ${OUTBOUND_BLOCK_TABLE}`,
    `table inet ${OUTBOUND_BLOCK_TABLE} {`,
    "  chain output {",
    "    type filter hook output priority 0; policy accept;",
    `    oifname "${name}" ct state established,related accept`,
    // MagicDNS (Tailscale). Harmless on other networks.
    `    oifname "${name}" ip daddr 100.100.100.100 accept`,
    `    oifname "${name}" ip6 daddr fd7a:115c:a1e0::53 accept`,
    `    oifname "${name}" drop`,
    "  }",
    "}",
  ].join("\n");
}

/** Guest shell: install the rules now and on every boot. Fails closed (before the join) if it cannot. */
export function buildOutboundBlockInstallScript(iface: string = TAILSCALE_INTERFACE): string {
  const rules = buildOutboundBlockRules(iface);
  const fail = `echo '${PRIVATE_ACCESS_FAILURE_MARKER} outbound_block_failed'; exit 1`;
  return [
    "if ! command -v nft >/dev/null 2>&1; then",
    "  if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y nftables; fi",
    "fi",
    `command -v nft >/dev/null 2>&1 || { ${fail}; }`,
    "HIVRA_NFT_BIN=\"$(command -v nft)\"",
    "install -d -m 0755 /etc/hivra",
    `cat > ${OUTBOUND_BLOCK_RULES_FILE} <<'HIVRA_NFT_RULES'`,
    rules,
    "HIVRA_NFT_RULES",
    `chmod 0644 ${OUTBOUND_BLOCK_RULES_FILE}`,
    "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then",
    `  cat > /etc/systemd/system/${OUTBOUND_BLOCK_UNIT} <<HIVRA_NFT_UNIT`,
    "[Unit]",
    "Description=Hivra: no new outbound connections to other devices on the private network",
    "Before=network-pre.target tailscaled.service",
    "Wants=network-pre.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=$HIVRA_NFT_BIN -f ${OUTBOUND_BLOCK_RULES_FILE}`,
    `ExecStop=-$HIVRA_NFT_BIN delete table inet ${OUTBOUND_BLOCK_TABLE}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "HIVRA_NFT_UNIT",
    "  systemctl daemon-reload",
    `  systemctl enable ${OUTBOUND_BLOCK_UNIT} >/dev/null 2>&1 || { ${fail}; }`,
    `  systemctl restart ${OUTBOUND_BLOCK_UNIT} || { ${fail}; }`,
    "else",
    `  "$HIVRA_NFT_BIN" -f ${OUTBOUND_BLOCK_RULES_FILE} || { ${fail}; }`,
    "fi",
    `"$HIVRA_NFT_BIN" list table inet ${OUTBOUND_BLOCK_TABLE} >/dev/null 2>&1 || { ${fail}; }`,
  ].join("\n");
}

/** Guest shell: take the rules and their unit away. Safe to run when nothing was installed. */
export function buildOutboundBlockRemoveScript(): string {
  return [
    "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then",
    `  systemctl disable --now ${OUTBOUND_BLOCK_UNIT} >/dev/null 2>&1 || true`,
    "fi",
    `rm -f /etc/systemd/system/${OUTBOUND_BLOCK_UNIT} ${OUTBOUND_BLOCK_RULES_FILE}`,
    "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi",
    `if command -v nft >/dev/null 2>&1; then nft delete table inet ${OUTBOUND_BLOCK_TABLE} 2>/dev/null || true; fi`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// NetBird
// ---------------------------------------------------------------------------

/** HTTPS origin only: no credentials, path, query or fragment. Blank means NetBird's own cloud. */
export function normalizeNetbirdManagementUrl(value: unknown): string | null {
  if (value == null || value === "") return DEFAULT_NETBIRD_MANAGEMENT_URL;
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ready-made policy for the owner's own network
// ---------------------------------------------------------------------------

/**
 * huJSON for the owner's Tailscale or Headscale policy file. Full-line `//`
 * comments only, so a test can strip them and parse the rest.
 */
export function buildPrivateNetworkPolicy(kind: "tailscale" | "headscale"): string {
  const owner = kind === "tailscale" ? "autogroup:member" : "you@";
  const ownerLogin = kind === "tailscale" ? "you@example.com" : "you@";
  const header = kind === "tailscale"
    ? "// Your own devices may reach your Hivra computers on SSH (port 22). Hivra computers may reach nothing."
    : "// Your own devices may reach your Hivra computers on SSH (port 22). Hivra computers may reach nothing. Replace you@ with your Headscale user.";
  const lines = [
    header,
    "{",
    '  "tagOwners": {',
    `    "${HIVRA_TAILNET_TAG}": ["${kind === "tailscale" ? "autogroup:admin" : "you@"}"]`,
    "  },",
    '  "acls": [',
    `    { "action": "accept", "src": ["${owner}"], "dst": ["${HIVRA_TAILNET_TAG}:22"] }`,
    "  ],",
    "  // These checks make your network refuse a policy edit that would let a Hivra computer reach your devices.",
    '  "tests": [',
    `    { "src": "${ownerLogin}", "accept": ["${HIVRA_TAILNET_TAG}:22"] },`,
    "    // Use the private address of one of your own devices below.",
    `    { "src": "${HIVRA_TAILNET_TAG}", "deny": ["100.64.0.1:22", "${HIVRA_TAILNET_TAG}:22"] }`,
    "  ]",
    "}",
  ];
  return lines.join("\n");
}

/** Plain steps for NetBird, which has no policy file to paste. */
export const NETBIRD_POLICY_STEPS: readonly string[] = [
  "Make a setup key that can be used once and puts the computer in a group called hivra.",
  "In Access Control, add a one-way policy: your own devices group to the hivra group, TCP port 22 only.",
  "Delete the Default policy so nothing else is allowed. A hivra computer then cannot start a connection to any device.",
];

// ---------------------------------------------------------------------------
// Failure codes in plain words
// ---------------------------------------------------------------------------

export const PRIVATE_ACCESS_FAILURE_COPY: Record<string, string> = {
  client_too_old: `This computer's Tailscale is older than ${TAILSCALE_MIN_VERSION}, which Hivra needs to connect safely. Update Tailscale on the computer, then connect again.`,
  client_version_unreadable: "Hivra could not read this computer's Tailscale version, so it did not connect. Try again in a minute.",
  outbound_block_failed: "Hivra could not put its safety rule in place on this computer, so it did not connect. Try again; if it keeps failing, contact support.",
};

export function privateAccessFailureMessage(code: unknown): string | null {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(PRIVATE_ACCESS_FAILURE_COPY, code)
    ? PRIVATE_ACCESS_FAILURE_COPY[code] : null;
}

/** Pulls a failure code the guest program printed, from a command's output. */
export function extractPrivateAccessFailureCode(output: string): string | null {
  const match = new RegExp(`^${PRIVATE_ACCESS_FAILURE_MARKER} ([a-z_]{1,64})$`, "m").exec(output);
  return match ? match[1] : null;
}
