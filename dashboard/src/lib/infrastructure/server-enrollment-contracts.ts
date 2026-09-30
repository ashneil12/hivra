import { z } from "zod";

/**
 * Contracts shared by the report route, the owner routes and the Capacity
 * page for one-command server enrollment
 * (docs/superpowers/specs/2026-09-24-server-enrollment-command.md).
 * Browser-safe: no secret, code or private key ever appears in these shapes.
 */

export const SERVER_ENROLLMENT_PHASES = [
  "issued", "reported", "unsupported", "confirmed", "rejected", "cancelled", "expired",
] as const;
export type ServerEnrollmentPhase = (typeof SERVER_ENROLLMENT_PHASES)[number];

const HostnameSchema = z.string().regex(/^[A-Za-z0-9.-]{1,253}$/);
const Ed25519KeySchema = z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/);
export const Sha256FingerprintSchema = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);
const IsoSchema = z.string().datetime({ offset: true });
const WordsSchema = z.string().regex(/^[a-z]{2,10}-[a-z]{2,10}-[a-z]{2,10}$/);

/** The facts the script reports. A value that didn't match its pattern on
 * the server is null. These are "reported by the server": a malicious server
 * can send anything that matches, so nothing here decides support or
 * readiness on its own. */
export const ServerEnrollmentFactsSchema = z.object({
  hostname: HostnameSchema.nullable(),
  osId: z.string().regex(/^[a-z0-9._-]{1,64}$/).nullable(),
  osVersionId: z.string().regex(/^[0-9][0-9.]{0,15}$/).nullable(),
  architecture: z.string().regex(/^[a-z0-9_]{1,32}$/).nullable(),
  cpuCount: z.number().int().min(0).max(1_000_000).nullable(),
  memoryBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  virtualization: z.string().regex(/^[a-z0-9_-]{1,32}$/).nullable(),
  proxmoxVersion: z.string().regex(/^[0-9][0-9.]{0,15}$/).nullable(),
  sshMatchRules: z.boolean(),
}).strict();
export type ServerEnrollmentFacts = z.infer<typeof ServerEnrollmentFactsSchema>;

const ReportCommon = {
  version: z.literal(1),
  scriptVersion: z.string().regex(/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{1,3}$/),
  consent: z.enum(["terminal", "no_terminal"]),
  facts: ServerEnrollmentFactsSchema,
};

export const ServerEnrollmentReportSchema = z.discriminatedUnion("kind", [
  z.object({
    ...ReportCommon,
    kind: z.literal("enrolled"),
    hostPublicKey: Ed25519KeySchema,
    adminKeyFingerprint: Sha256FingerprintSchema,
    sshPort: z.number().int().min(1).max(65_535),
    reenrollment: z.boolean(),
  }).strict(),
  z.object({
    ...ReportCommon,
    kind: z.literal("unsupported"),
    hostPublicKey: z.null(),
    adminKeyFingerprint: z.null(),
    sshPort: z.null(),
    reenrollment: z.literal(false),
  }).strict(),
]);
export type ServerEnrollmentReport = z.infer<typeof ServerEnrollmentReportSchema>;

/** The same rule the script applies (bootstrap/server-enroll-support-cases.json
 * pins both): Ubuntu 22.04 or 24.04 on x86_64. Proxmox VE 8 or 9 joins only
 * once Proxmox launches may run through sudo (release gate T43); until then
 * the script sends a Proxmox VE server to the advanced root login and Hivra
 * treats a Proxmox VE report as unsupported. Hivra re-checks this at report
 * and its answer wins. */
export function isServerEnrollmentSupported(facts: Pick<ServerEnrollmentFacts,
  "osId" | "osVersionId" | "architecture" | "proxmoxVersion">,
options: { proxmoxSudoAllowed: boolean }): boolean {
  if (facts.architecture !== "x86_64") return false;
  if (facts.proxmoxVersion) return options.proxmoxSudoAllowed && /^(8|9)(\.|$)/.test(facts.proxmoxVersion);
  return facts.osId === "ubuntu" && (facts.osVersionId === "22.04" || facts.osVersionId === "24.04");
}

export const SERVER_ENROLLMENT_REBUILD_INSTRUCTION =
  "The setup command works with Ubuntu 22.04 or 24.04 on x86. Rebuild this server with a supported image, then run a new command.";
/** Proxmox VE while release gate T43 is closed: not a rebuild, the advanced
 * path with a root login. */
export const SERVER_ENROLLMENT_PROXMOX_INSTRUCTION =
  "Proxmox VE servers connect with a root login for now: choose Connect with SSH details instead (advanced) and sign in as root.";

/** What an existing connection in this account with the same SSH identity
 * lets the owner do. A match never allows Yes (8.1). */
export const KnownServerSchema = z.object({
  connectionId: z.string().uuid(),
  connectionName: z.string().min(1).max(80),
  connectionRevision: z.number().int().positive(),
  provider: z.enum(["host", "proxmox", "hetzner-cloud"]),
  sshUser: z.string().min(1).max(32).nullable(),
  sshHost: z.string().min(1).max(253).nullable(),
  offer: z.enum(["replace_key", "switch_user", "none"]),
  /** Why no Replace is offered, when offer is "none". */
  reason: z.enum(["login_in_use", "proxmox_needs_root", "proxmox_connection", "hetzner", "multiple"]).nullable(),
}).strict();
export type KnownServer = z.infer<typeof KnownServerSchema>;

export const ServerEnrollmentReportViewSchema = z.object({
  kind: z.enum(["enrolled", "unsupported"]),
  reportedAt: IsoSchema,
  /** The address Hivra saw the report come from; null when it saw none. */
  observedAddress: z.string().min(2).max(45).nullable(),
  sshPort: z.number().int().min(1).max(65_535).nullable(),
  hostFingerprintSha256: Sha256FingerprintSchema.nullable(),
  facts: ServerEnrollmentFactsSchema,
  consent: z.enum(["terminal", "no_terminal"]),
  words: WordsSchema.nullable(),
  reenrollment: z.boolean(),
}).strict();

export const ServerEnrollmentDtoSchema = z.object({
  id: z.string().uuid(),
  phase: z.enum(SERVER_ENROLLMENT_PHASES),
  issuedAt: IsoSchema,
  expiresAt: IsoSchema,
  confirmBy: IsoSchema.nullable(),
  scriptFetches: z.number().int().min(0).max(20),
  lastFetchedAt: IsoSchema.nullable(),
  refusedReports: z.number().int().min(0).max(10),
  lastRefusal: z.enum(["private_address", "ipv4_required", "invalid_report"]).nullable(),
  lastRefusedAt: IsoSchema.nullable(),
  report: ServerEnrollmentReportViewSchema.nullable(),
  knownServer: KnownServerSchema.nullable(),
  outcome: z.enum(["connected", "replaced_access"]).nullable(),
  connectionId: z.string().uuid().nullable(),
  decidedAt: IsoSchema.nullable(),
  replacementAttempts: z.number().int().min(0).max(5),
  lastReplacementFailure: z.enum([
    "host_key_mismatch", "connection_failed", "authentication_failed", "sudo_unavailable", "not_root",
    "connection_changed", "proxmox_needs_root",
  ]).nullable(),
}).strict();
export type ServerEnrollmentDto = z.infer<typeof ServerEnrollmentDtoSchema>;

/** Returned once, when a command is issued, and held only in React memory:
 * the command carries the one-time code. */
export const ServerEnrollmentIssueResultSchema = z.object({
  enrollment: ServerEnrollmentDtoSchema,
  command: z.string().min(1).max(512),
  dryRunCommand: z.string().min(1).max(512),
  downloadCommand: z.string().min(1).max(512),
  uninstallCommand: z.string().min(1).max(256),
  finalLine: z.string().min(1).max(512),
  downloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  scriptVersion: z.string().min(1).max(32),
  scriptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  accountCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
  origin: z.string().url(),
}).strict();
export type ServerEnrollmentIssueResult = z.infer<typeof ServerEnrollmentIssueResultSchema>;

export const ServerEnrollmentListSchema = z.object({
  enrollments: z.array(ServerEnrollmentDtoSchema),
  uninstallCommand: z.string().min(1).max(256).nullable(),
}).strict();
export type ServerEnrollmentList = z.infer<typeof ServerEnrollmentListSchema>;

export const ServerEnrollmentConfirmRequestSchema = z.object({
  /** An owner-entered address instead of the one Hivra saw. */
  sshHost: z.string().trim().min(1).max(253).nullable().optional(),
}).strict();

export const ServerEnrollmentReplaceRequestSchema = z.object({
  connectionId: z.string().uuid(),
  connectionRevision: z.number().int().positive(),
  /** Only for a switch: the owner may choose the address on the card. */
  sshHost: z.string().trim().min(1).max(253).nullable().optional(),
}).strict();

export const ServerEnrollmentIssueRequestSchema = z.object({
  replaceEnrollmentId: z.string().uuid().nullable().optional(),
}).strict();

/** "ip-172-31-4-9 · Ubuntu 24.04 · x86 · 4 CPU · 16 GB": what the server
 * reported, for the card's "Reported by the server" row. */
export function serverEnrollmentFactsSummary(facts: ServerEnrollmentFacts): string {
  const parts: string[] = [];
  if (facts.hostname) parts.push(facts.hostname);
  if (facts.proxmoxVersion) parts.push(`Proxmox VE ${facts.proxmoxVersion}`);
  else if (facts.osId) {
    const name = facts.osId.charAt(0).toUpperCase() + facts.osId.slice(1);
    parts.push(facts.osVersionId ? `${name} ${facts.osVersionId}` : name);
  }
  if (facts.architecture) parts.push(facts.architecture === "x86_64" ? "x86" : facts.architecture);
  if (facts.cpuCount !== null) parts.push(`${facts.cpuCount} CPU`);
  if (facts.memoryBytes !== null) {
    const gb = facts.memoryBytes / 1024 ** 3;
    parts.push(`${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`);
  }
  return parts.join(" · ") || "no details";
}
