import "server-only";

import { z } from "zod";
import { shellQuote } from "./proxmox-target";
import { buildVmidBoundGuestSshPrelude } from "./vmid-bound-guest-ssh";

/**
 * Buzz publishes Sprig as a static Linux multicall bundle. The rolling release
 * is mutable, so Hivra treats the URL as an untrusted transport and pins both
 * the archive and extracted binary hashes. A future upstream replacement fails
 * closed until these constants are reviewed and deliberately updated.
 */
export const BUZZ_SPRIG_RELEASE = {
  sourceGitSha: "1c8321cd08feb597f8bcff5195c21148fb3e98ed",
  version: "0.1.0+git.1c8321c",
  baseUrl: "https://github.com/block/buzz/releases/download/sprig-latest",
  targets: {
    x86_64: {
      target: "x86_64-unknown-linux-musl",
      archiveSha256: "2f73c2bf2ad69aa515f7821d73666583bff300099c638145a3f77bc0dcf2d916",
      binarySha256: "0e1062f1ae58c92f312f4445df3291c0269e0fa8a08f452bf5bfa95dd3611356",
    },
    aarch64: {
      target: "aarch64-unknown-linux-musl",
      archiveSha256: "73758486876233800c79e9da41850b890e98e6fadece8eab342952f74c5c5df1",
      binarySha256: "8435bc5a9105f5f200de1f54844feda262ab65baed8d7abb8dbc5fa134473f55",
    },
  },
} as const;

const Uuid = z.string().uuid();
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const SafeModel = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/);
const PublicRelay = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "wss:" && !parsed.username && !parsed.password
    && !parsed.search && !parsed.hash && (parsed.pathname === "" || parsed.pathname === "/");
});
const ApiKey = z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/);

export const BuzzRuntimeInstallInputSchema = z.object({
  bindingId: Uuid,
  agentId: Uuid,
  agentType: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  agentIp: z.string().ip({ version: "v4" }),
  publicKey: Hex64,
  privateKey: Hex64,
  relayUrl: PublicRelay,
  provider: z.enum(["openai", "anthropic", "venice"]),
  model: SafeModel,
  apiKey: ApiKey,
  ownerPublicKey: Hex64,
  operationId: Uuid,
  requestDigest: Hex64,
  leaseId: Uuid,
}).strict();
export type BuzzRuntimeInstallInput = z.infer<typeof BuzzRuntimeInstallInputSchema>;

export const BuzzRuntimeIdentitySchema = z.object({
  bindingId: Uuid,
  agentId: Uuid,
  agentIp: z.string().ip({ version: "v4" }),
  publicKey: Hex64,
}).strict();
export type BuzzRuntimeIdentity = z.infer<typeof BuzzRuntimeIdentitySchema>;

export const BuzzRuntimeRemoveInputSchema = BuzzRuntimeIdentitySchema.extend({
  operationId: Uuid,
  requestDigest: Hex64,
  leaseId: Uuid,
}).strict();
export type BuzzRuntimeRemoveInput = z.infer<typeof BuzzRuntimeRemoveInputSchema>;

const ReceiptBase = z.object({
  protocol: z.literal("hivra-buzz-runtime-v1"),
  action: z.enum(["installed", "observed", "removed"]),
  bindingId: Uuid,
  agentId: Uuid,
  publicKey: Hex64,
  serviceName: z.string().regex(/^hivra-buzz-[a-f0-9-]+\.service$/),
  sourceGitSha: z.literal(BUZZ_SPRIG_RELEASE.sourceGitSha),
  observedAt: z.string().datetime({ offset: true }),
});

const BuzzRuntimeReceiptSchema = z.discriminatedUnion("action", [
  ReceiptBase.extend({
    action: z.literal("installed"),
    state: z.literal("active"),
    architecture: z.enum(["x86_64", "aarch64"]),
    archiveSha256: Hex64,
    binarySha256: Hex64,
    provider: z.enum(["openai", "anthropic", "venice"]),
    model: SafeModel,
    ownerPublicKey: Hex64,
    operationId: Uuid,
    requestDigest: Hex64,
    leaseId: Uuid,
    mainPid: z.number().int().positive(),
  }).strict(),
  ReceiptBase.extend({
    action: z.literal("observed"),
    state: z.literal("active"),
    architecture: z.enum(["x86_64", "aarch64"]),
    binarySha256: Hex64,
    mainPid: z.number().int().positive(),
  }).strict(),
  ReceiptBase.extend({
    action: z.literal("removed"),
    state: z.literal("absent"),
    operationId: Uuid,
    requestDigest: Hex64,
    leaseId: Uuid,
  }).strict(),
]);
export type BuzzRuntimeReceipt = z.infer<typeof BuzzRuntimeReceiptSchema>;

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

function serviceName(bindingId: string) {
  return `hivra-buzz-${bindingId}.service`;
}

function environmentFile(input: BuzzRuntimeInstallInput) {
  const provider = input.provider === "openai"
    ? [
      "BUZZ_AGENT_PROVIDER=openai",
      `OPENAI_COMPAT_API_KEY=${input.apiKey}`,
      `OPENAI_COMPAT_MODEL=${input.model}`,
      "OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1",
      "OPENAI_COMPAT_API=responses",
    ]
    : input.provider === "venice" ? [
      "BUZZ_AGENT_PROVIDER=openai",
      `OPENAI_COMPAT_API_KEY=${input.apiKey}`,
      `OPENAI_COMPAT_MODEL=${input.model}`,
      "OPENAI_COMPAT_BASE_URL=https://api.venice.ai/api/v1",
      "OPENAI_COMPAT_API=chat",
    ] : [
      "BUZZ_AGENT_PROVIDER=anthropic",
      `ANTHROPIC_API_KEY=${input.apiKey}`,
      `ANTHROPIC_MODEL=${input.model}`,
      "ANTHROPIC_BASE_URL=https://api.anthropic.com",
    ];
  return [
    `BUZZ_PRIVATE_KEY=${input.privateKey}`,
    `NOSTR_PRIVATE_KEY=${input.privateKey}`,
    `BUZZ_RELAY_URL=${input.relayUrl}`,
    `BUZZ_ACP_AGENT_OWNER=${input.ownerPublicKey}`,
    "BUZZ_ACP_RESPOND_TO=owner-only",
    "BUZZ_ACP_AGENT_COMMAND=/opt/hivra/buzz/current/buzz-agent",
    "BUZZ_ACP_AGENT_ARGS=",
    "BUZZ_ACP_MCP_COMMAND=/opt/hivra/buzz/current/buzz-dev-mcp",
    "BUZZ_ACP_AGENTS=1",
    "BUZZ_AGENT_REQUIRE_REPLY=1",
    // Buzz Agent defaults to 65,536 output tokens, which exceeds the published
    // limit of some otherwise supported models (including Venice qwen3-4b).
    // A conservative shared ceiling keeps the adapter portable across every
    // provider exposed by this form while remaining well above normal replies.
    "BUZZ_AGENT_MAX_OUTPUT_TOKENS=32768",
    `BUZZ_ACP_DISPLAY_NAME=${input.agentType}-${input.agentId.slice(0, 8)}`,
    ...provider,
    "",
  ].join("\n");
}

function unitFile(name: string, envPath: string) {
  return `[Unit]
Description=Hivra Buzz ACP runtime ${name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bux
Group=bux
WorkingDirectory=/home/bux
EnvironmentFile=${envPath}
Environment=PATH=/opt/hivra/buzz/current:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/opt/hivra/buzz/current/buzz-acp
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/bux /var/lib/hivra/buzz
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
`;
}

/** Build the root guest operation. Secrets are carried only in the base64
 * document written to the root-only EnvironmentFile and are never echoed. */
export function buildBuzzRuntimeInstallGuestScript(raw: BuzzRuntimeInstallInput): string {
  const input = BuzzRuntimeInstallInputSchema.parse(raw);
  const name = serviceName(input.bindingId);
  const envPath = `/etc/hivra/buzz/${input.bindingId}.env`;
  const unitPath = `/etc/systemd/system/${name}`;
  const envDocument = b64(environmentFile(input));
  const unitDocument = b64(unitFile(name, envPath));
  const release = BUZZ_SPRIG_RELEASE;
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077
FAILURE_STAGE=prerequisites
BUZZ_RUNTIME_TMP=
report_hivra_buzz_failure() {
  code=$?
  trap - EXIT
  case "\${BUZZ_RUNTIME_TMP:-}" in
    /var/lib/hivra/buzz/install.*) rm -rf -- "$BUZZ_RUNTIME_TMP" ;;
    "") ;;
    *) printf 'refusing to remove unexpected Buzz runtime directory\n' >&2 ;;
  esac
  if [ "$code" -ne 0 ]; then
    printf 'HIVRA_BUZZ_RUNTIME_FAILURE stage=%s code=%s\n' "$FAILURE_STAGE" "$code" >&2
  fi
  exit "$code"
}
trap report_hivra_buzz_failure EXIT
[ "$(id -u)" = 0 ] || { echo 'root required' >&2; exit 41; }
for cmd in curl sha256sum tar systemctl flock base64 grep readlink install; do command -v "$cmd" >/dev/null || { echo "missing prerequisite: $cmd" >&2; exit 42; }; done
[ -d /run/systemd/system ] || { echo 'systemd unavailable' >&2; exit 43; }
[ -d /home/bux ] || { echo 'agent home unavailable' >&2; exit 44; }
FAILURE_STAGE=runtime_lock
exec 9>/run/lock/hivra-buzz-runtime.lock
flock -x 9
FAILURE_STAGE=architecture
case "$(uname -m)" in
  x86_64) ARCH=x86_64; TARGET=${release.targets.x86_64.target}; ARCHIVE_SHA=${release.targets.x86_64.archiveSha256}; BINARY_SHA=${release.targets.x86_64.binarySha256} ;;
  aarch64|arm64) ARCH=aarch64; TARGET=${release.targets.aarch64.target}; ARCHIVE_SHA=${release.targets.aarch64.archiveSha256}; BINARY_SHA=${release.targets.aarch64.binarySha256} ;;
  *) echo 'unsupported architecture' >&2; exit 45 ;;
esac
ROOT=/opt/hivra/buzz/${release.sourceGitSha}
install -d -o root -g root -m 0755 /opt/hivra /opt/hivra/buzz
install -d -o root -g root -m 0755 /etc/hivra
install -d -o root -g root -m 0700 /etc/hivra/buzz
install -d -o root -g root -m 0755 /var/lib/hivra
install -d -o bux -g bux -m 0750 /var/lib/hivra/buzz
install -d -o root -g root -m 0755 "$ROOT"
if [ ! -x "$ROOT/sprig" ] || [ "$(sha256sum "$ROOT/sprig" | awk '{print $1}')" != "$BINARY_SHA" ]; then
  FAILURE_STAGE=download
  TMP=$(mktemp -d /var/lib/hivra/buzz/install.XXXXXX)
  BUZZ_RUNTIME_TMP=$TMP
  ARCHIVE="$TMP/sprig.tar.gz"
  curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 --max-time 120 \
    "${release.baseUrl}/sprig-$TARGET.tar.gz" -o "$ARCHIVE"
  FAILURE_STAGE=archive_digest
  [ "$(sha256sum "$ARCHIVE" | awk '{print $1}')" = "$ARCHIVE_SHA" ] || { echo 'archive digest mismatch' >&2; exit 46; }
  FAILURE_STAGE=archive_contents
  tar -tzf "$ARCHIVE" | sort > "$TMP/archive.list"
  printf '%s\n' './' './README.md' './buzz-acp' './buzz-agent' './buzz-dev-mcp' './sprig' './sprig.json' | sort > "$TMP/expected.list"
  cmp -s "$TMP/archive.list" "$TMP/expected.list" || { echo 'unexpected archive contents' >&2; exit 47; }
  FAILURE_STAGE=extract
  mkdir "$TMP/extract"
  tar -xzf "$ARCHIVE" -C "$TMP/extract" --no-same-owner --no-same-permissions
  FAILURE_STAGE=bundle_links
  [ "$(readlink "$TMP/extract/buzz-acp")" = sprig ]
  [ "$(readlink "$TMP/extract/buzz-agent")" = sprig ]
  [ "$(readlink "$TMP/extract/buzz-dev-mcp")" = sprig ]
  FAILURE_STAGE=binary_digest
  [ "$(sha256sum "$TMP/extract/sprig" | awk '{print $1}')" = "$BINARY_SHA" ] || { echo 'binary digest mismatch' >&2; exit 48; }
  FAILURE_STAGE=metadata
  grep -Fq '"git_sha": "${release.sourceGitSha}"' "$TMP/extract/sprig.json"
  grep -Fq '"version": "${release.version}"' "$TMP/extract/sprig.json"
  grep -Fq "\\\"target\\\": \\\"\${TARGET}\\\"" "$TMP/extract/sprig.json"
  FAILURE_STAGE=install_binary
  install -o root -g root -m 0755 "$TMP/extract/sprig" "$ROOT/sprig"
  ln -sfn sprig "$ROOT/buzz-acp"
  ln -sfn sprig "$ROOT/buzz-agent"
  ln -sfn sprig "$ROOT/buzz-dev-mcp"
fi
ln -sfn sprig "$ROOT/buzz"
FAILURE_STAGE=activate_binary
[ "$(sha256sum "$ROOT/sprig" | awk '{print $1}')" = "$BINARY_SHA" ] || { echo 'installed binary digest mismatch' >&2; exit 49; }
ln -sfn "$ROOT" /opt/hivra/buzz/current.next
mv -Tf /opt/hivra/buzz/current.next /opt/hivra/buzz/current
FAILURE_STAGE=write_environment
printf '%s' '${envDocument}' | base64 -d > '${envPath}.new'
chown root:root '${envPath}.new'
chmod 0600 '${envPath}.new'
mv -f '${envPath}.new' '${envPath}'
FAILURE_STAGE=write_unit
printf '%s' '${unitDocument}' | base64 -d > '${unitPath}.new'
chown root:root '${unitPath}.new'
chmod 0644 '${unitPath}.new'
mv -f '${unitPath}.new' '${unitPath}'
FAILURE_STAGE=start_service
systemctl daemon-reload
systemctl enable --now '${name}' >/dev/null
sleep 2
FAILURE_STAGE=service_health
systemctl is-active --quiet '${name}' || { systemctl status '${name}' --no-pager -n 20 >&2 || true; exit 50; }
PID=$(systemctl show '${name}' -p MainPID --value)
case "$PID" in ''|0|*[!0-9]*) echo 'runtime main pid unavailable' >&2; exit 51;; esac
FAILURE_STAGE=receipt
OBSERVED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'HIVRA_BUZZ_RUNTIME_V1 {"protocol":"hivra-buzz-runtime-v1","action":"installed","bindingId":"${input.bindingId}","agentId":"${input.agentId}","publicKey":"${input.publicKey}","serviceName":"${name}","sourceGitSha":"${release.sourceGitSha}","observedAt":"%s","state":"active","architecture":"%s","archiveSha256":"%s","binarySha256":"%s","provider":"${input.provider}","model":"${input.model}","ownerPublicKey":"${input.ownerPublicKey}","operationId":"${input.operationId}","requestDigest":"${input.requestDigest}","leaseId":"${input.leaseId}","mainPid":%s}\n' "$OBSERVED" "$ARCH" "$ARCHIVE_SHA" "$BINARY_SHA" "$PID"
`;
}

export function buildBuzzRuntimeObserveGuestScript(raw: BuzzRuntimeIdentity): string {
  const input = BuzzRuntimeIdentitySchema.parse(raw);
  const name = serviceName(input.bindingId);
  const release = BUZZ_SPRIG_RELEASE;
  return `#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = 0 ] || exit 41
systemctl is-active --quiet '${name}' || exit 52
PID=$(systemctl show '${name}' -p MainPID --value)
case "$PID" in ''|0|*[!0-9]*) exit 53;; esac
case "$(uname -m)" in x86_64) ARCH=x86_64; BINARY_SHA=${release.targets.x86_64.binarySha256};; aarch64|arm64) ARCH=aarch64; BINARY_SHA=${release.targets.aarch64.binarySha256};; *) exit 45;; esac
[ "$(sha256sum /opt/hivra/buzz/current/sprig | awk '{print $1}')" = "$BINARY_SHA" ] || exit 54
OBSERVED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'HIVRA_BUZZ_RUNTIME_V1 {"protocol":"hivra-buzz-runtime-v1","action":"observed","bindingId":"${input.bindingId}","agentId":"${input.agentId}","publicKey":"${input.publicKey}","serviceName":"${name}","sourceGitSha":"${release.sourceGitSha}","observedAt":"%s","state":"active","architecture":"%s","binarySha256":"%s","mainPid":%s}\n' "$OBSERVED" "$ARCH" "$BINARY_SHA" "$PID"
`;
}

export function buildBuzzRuntimeRemoveGuestScript(raw: BuzzRuntimeRemoveInput): string {
  const input = BuzzRuntimeRemoveInputSchema.parse(raw);
  const name = serviceName(input.bindingId);
  const envPath = `/etc/hivra/buzz/${input.bindingId}.env`;
  const unitPath = `/etc/systemd/system/${name}`;
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ] || exit 41
exec 9>/run/lock/hivra-buzz-runtime.lock
flock -x 9
systemctl disable --now '${name}' >/dev/null 2>&1 || true
rm -f '${unitPath}' '${envPath}' '${envPath}.new' '${unitPath}.new'
systemctl daemon-reload
systemctl reset-failed '${name}' >/dev/null 2>&1 || true
if systemctl is-active --quiet '${name}'; then echo 'runtime still active' >&2; exit 55; fi
[ ! -e '${envPath}' ] && [ ! -e '${unitPath}' ] || exit 56
OBSERVED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'HIVRA_BUZZ_RUNTIME_V1 {"protocol":"hivra-buzz-runtime-v1","action":"removed","bindingId":"${input.bindingId}","agentId":"${input.agentId}","publicKey":"${input.publicKey}","serviceName":"${name}","sourceGitSha":"${BUZZ_SPRIG_RELEASE.sourceGitSha}","observedAt":"%s","state":"absent","operationId":"${input.operationId}","requestDigest":"${input.requestDigest}","leaseId":"${input.leaseId}"}\n' "$OBSERVED"
`;
}

/** Run a guest operation through the selected Proxmox host. The SSH server
 * identity is attested through the selected VMID's QEMU Guest Agent channel. */
export function buildBuzzRuntimeHostScript(input: {
  agentIp: string;
  vmid: number;
  vmSshKeyPath: string;
  infrastructureBindingTag: string;
}, guestScript: string): string {
  const ip = z.string().ip({ version: "v4" }).parse(input.agentIp);
  const vmid = z.number().int().min(100).parse(input.vmid);
  const keyPath = z.string().min(1).max(512).parse(input.vmSshKeyPath);
  const bindingTag = z.string().regex(/^hivra-bind-[a-f0-9]{32}$/).parse(input.infrastructureBindingTag);
  const payload = b64(guestScript);
  return `#!/usr/bin/env bash
set -euo pipefail
VMID=${vmid}
GUEST_IP=${shellQuote(ip)}
VM_KEY=${shellQuote(keyPath)}
EXPECTED_BINDING_TAG=${shellQuote(bindingTag)}
[ -f "$VM_KEY" ] || { echo 'vm orchestrator key missing' >&2; exit 61; }
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo 'timed out waiting for Hivra lifecycle lock' >&2; exit 62; }
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = running ] \
  || { echo 'bound VM is not running' >&2; exit 63; }
VM_CONFIG="$(qm config "$VMID")"
TAGS="$(printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG" \
  || { echo 'bound VM tag mismatch' >&2; exit 64; }
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' \
  | sed -n 's/^ip=\\([^/]*\\)\\/.*/\\1/p' | grep -Fxq "$GUEST_IP" \
  || { echo 'bound VM IP mismatch' >&2; exit 65; }
${buildVmidBoundGuestSshPrelude()}
printf '%s' '${payload}' | "\${GUEST_SSH[@]}" "base64 -d | sudo -n bash"
`;
}

export function parseBuzzRuntimeReceipt(output: string): BuzzRuntimeReceipt {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith("HIVRA_BUZZ_RUNTIME_V1 "));
  if (lines.length !== 1) throw new Error("Buzz runtime receipt missing or ambiguous");
  return BuzzRuntimeReceiptSchema.parse(JSON.parse(lines[0].slice("HIVRA_BUZZ_RUNTIME_V1 ".length)));
}
