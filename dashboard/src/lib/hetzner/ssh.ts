/**
 * SSH execution utility for Hetzner VM management.
 * 
 * Migrated to `ssh2` for robust pure-JS implementation, modeled after MoltBot Server.
 * Requires HETZNER_SSH_PRIVATE_KEY_B64 env var (Base64 encoded PEM).
 */

import { Client, type ConnectConfig } from "ssh2";
import { createHash } from "crypto";
import * as fs from "fs";
import { supabaseAdmin } from "@/lib/supabase";
import { isSshWarmupError } from "@/lib/ssh-warmup";
import { buildHermesVmidBoundGuestSshPrelude, isValidGuestSshUser } from "@/lib/proxmox/hermes-guest-ssh";

// ── Helpers ─────────────────────────────────────────────────────────────

function validateIp(ip: string): void {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        throw new Error(`Invalid IPv4 address: "${ip}"`);
    }
}

function shellQuote(value: string | number): string {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function isProxmoxPrivateGuestIp(ip: string): boolean {
    const prefix = process.env.PROXMOX_PRIVATE_SUBNET_PREFIX?.trim() || "10.250.20";
    return (
        Boolean(process.env.PROXMOX_SSH_HOST?.trim()) && ip.startsWith(`${prefix}.`)
    ) || Boolean(resolveProxmoxPrivateGuestHostConfig(ip));
}

interface ProxmoxSshHostConfig {
    hostId?: string | null;
    hostSlug?: string | null;
    envPrefix?: string | null;
    failClosed?: boolean;
}

function normalizeProxmoxTargetId(value: string | null | undefined): string | null {
    const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return normalized || null;
}

function proxmoxTargetEnvPrefixes(targetId: string): string[] {
    const upper = targetId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return [`PROXMOX_HOST_${upper}_`, `PROXMOX_${upper}_`, `${upper}_PROXMOX_`];
}

function targetProxmoxEnvValue(
    env: NodeJS.ProcessEnv,
    targetId: string,
    suffix: string
): string {
    for (const prefix of proxmoxTargetEnvPrefixes(targetId)) {
        const value = env[`${prefix}${suffix}`]?.trim();
        if (value) return value;
    }
    return "";
}

function resolveProxmoxPrivateGuestHostConfig(
    ip: string,
    env: NodeJS.ProcessEnv = process.env
): ProxmoxSshHostConfig | null {
    const targetIds = (env.HERMES_PROXMOX_TARGETS || "")
        .split(",")
        .map(normalizeProxmoxTargetId)
        .filter((targetId): targetId is string => Boolean(targetId));

    for (const targetId of targetIds) {
        const privateSubnetPrefix = targetProxmoxEnvValue(env, targetId, "PRIVATE_SUBNET_PREFIX");
        if (privateSubnetPrefix && ip.startsWith(`${privateSubnetPrefix}.`)) {
            return { hostSlug: targetId, failClosed: true };
        }
    }

    return null;
}

async function proxmoxGuestSshExec(
    ip: string,
    command: string,
    timeoutMs: number,
    stdin?: string | Buffer,
    proxmoxHostConfig?: ProxmoxSshHostConfig | null
): Promise<SshResult> {
    const commandB64 = Buffer.from(command, "utf8").toString("base64");

    // When the caller provides stdin payload, ship it base64-encoded
    // alongside the command so it survives the bash -c outer wrapper,
    // and pipe it into the user's command on the guest. The host script
    // hands `bash -s` both the command (via heredoc) and the decoded
    // stdin (via a pipe). The user's command can then do `cat <&0` or
    // similar to consume it, or rely on tools like `base64 -d` reading
    // stdin by default.
    const { resolveProxmoxHostEnv, runProxmoxHostScript } = await import(
        "@/lib/services/proxmox-instance-service"
    );
    let proxmoxEnv: Record<string, string | undefined> = process.env;
    if (proxmoxHostConfig) {
        try {
            proxmoxEnv = resolveProxmoxHostEnv(proxmoxHostConfig, process.env);
        } catch (err) {
            return {
                ok: false,
                stdout: "",
                stderr: "",
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    const vmSshUser = proxmoxEnv.PROXMOX_VM_SSH_USER?.trim() || "hermes";
    const vmSshKeyPath = proxmoxEnv.PROXMOX_VM_SSH_KEY_PATH?.trim() || "/etc/hivra/keys/vm-orchestrator";
    if (!isValidGuestSshUser(vmSshUser) || !vmSshKeyPath.startsWith("/")) {
        return {
            ok: false,
            stdout: "",
            stderr: "",
            error: "Refusing Proxmox guest SSH: the configured guest ssh user or key path is invalid",
        };
    }

    // Commands and stdin here carry secrets (config.yaml with the Bankr block,
    // OAuth tokens, integration keys). The host binds the IP to the one running
    // VM it has configured with it and pins SSH to the host key that VM's guest
    // agent attests, so a neighbour answering ARP for the IP receives nothing.
    const hostScriptHead = `#!/usr/bin/env bash
set -euo pipefail
VMID=""
PRIVATE_IP=${shellQuote(ip)}
VM_SSH_KEY_PATH=${shellQuote(vmSshKeyPath)}
COMMAND_B64=${shellQuote(commandB64)}`;
    const guestSshPrelude = buildHermesVmidBoundGuestSshPrelude({ sshUser: vmSshUser, quiet: true });

    if (stdin !== undefined) {
        const stdinB64 = Buffer.isBuffer(stdin)
            ? stdin.toString("base64")
            : Buffer.from(stdin, "utf8").toString("base64");
        return runProxmoxHostScript(
            `${hostScriptHead}
STDIN_B64=${shellQuote(stdinB64)}
${guestSshPrelude}
DECODED_CMD=$(printf '%s' "$COMMAND_B64" | base64 -d)
printf '%s' "$STDIN_B64" | base64 -d | "\${GUEST_SSH[@]}" "sudo bash -c $(printf %q "$DECODED_CMD")"
`,
            proxmoxEnv,
            timeoutMs
        );
    }

    return runProxmoxHostScript(
        `${hostScriptHead}
${guestSshPrelude}
printf '%s' "$COMMAND_B64" | base64 -d | "\${GUEST_SSH[@]}" "sudo bash -s"
`,
        proxmoxEnv,
        timeoutMs
    );
}

function getHostFingerprintEnvKey(ip: string): string {
    return `HETZNER_SSH_HOST_FINGERPRINT_${ip.replace(/\./g, "_")}`;
}

export function normalizeHostFingerprint(fingerprint: string): string {
    const trimmed = fingerprint.trim();
    if (!trimmed) {
        throw new Error("SSH host fingerprint is empty.");
    }

    const withoutPrefix = trimmed.replace(/^sha256:/i, "").trim();
    const compactHex = withoutPrefix.replace(/[\s:]+/g, "");
    if (/^[a-f0-9:\s]+$/i.test(withoutPrefix)) {
        if (compactHex.length !== 64) {
            throw new Error(
                `Invalid SSH host fingerprint hex digest length (${compactHex.length}). Expected 64 hex characters.`
            );
        }
        return compactHex.toLowerCase();
    }

    const compactBase64 = withoutPrefix.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compactBase64)) {
        throw new Error(
            "Invalid SSH host fingerprint format. Expected SHA256:BASE64 or a 64-character hex digest."
        );
    }

    const padding = compactBase64.length % 4;
    const paddedBase64 = compactBase64 + (padding === 0 ? "" : "=".repeat(4 - padding));
    const digest = Buffer.from(paddedBase64, "base64");
    if (digest.length !== 32) {
        throw new Error(
            `Invalid SSH host fingerprint digest length (${digest.length} bytes). Expected a SHA-256 digest.`
        );
    }

    const canonicalBase64 = digest.toString("base64").replace(/=+$/g, "");
    if (canonicalBase64 !== compactBase64.replace(/=+$/g, "")) {
        throw new Error(
            "Invalid SSH host fingerprint encoding. Expected a canonical SHA256:BASE64 fingerprint."
        );
    }

    return digest.toString("hex");
}

export function getExpectedHostFingerprint(ip: string): string | null {
    validateIp(ip);

    const direct = process.env[getHostFingerprintEnvKey(ip)];
    if (direct?.trim()) {
        return normalizeHostFingerprint(direct);
    }

    const bulkMap = process.env.HETZNER_SSH_HOST_FINGERPRINTS;
    if (!bulkMap?.trim()) {
        return null;
    }

    for (const entry of bulkMap.split(/[\n,;]+/)) {
        const [entryIp, fingerprint] = entry.split("=").map((part) => part?.trim());
        if (entryIp === ip && fingerprint) {
            return normalizeHostFingerprint(fingerprint);
        }
    }

    return null;
}

type ManagedFingerprintLookup = {
    managed: boolean;
    fingerprint: string | null;
};

type FingerprintLookupRow = {
    id?: string;
    ssh_host_fingerprint_sha256?: string | null;
};

const managedFingerprintCache = new Map<string, string>();
const SSH_FINGERPRINT_RETRY_DELAY_MS = 1_000;

function isSshHostVerificationFailure(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
        normalized.includes("verification failed") ||
        normalized.includes("host denied") ||
        normalized.includes("fingerprint mismatch")
    );
}

function isMissingFingerprintColumnError(error: { message?: string | null } | null | undefined): boolean {
    const message = error?.message?.toLowerCase() ?? "";
    return message.includes("ssh_host_fingerprint_sha256") && message.includes("does not exist");
}

export async function lookupManagedHostFingerprint(ip: string): Promise<ManagedFingerprintLookup> {
    if (!supabaseAdmin) {
        return { managed: false, fingerprint: null };
    }

    const [{ data: hosts, error: hostError }, { data: instances, error: instanceError }] = await Promise.all([
        supabaseAdmin
            .from("hermes_hosts")
            .select("id, ssh_host_fingerprint_sha256")
            .eq("ipv4_address", ip),
        supabaseAdmin
            .from("hermes_instances")
            .select("id, ssh_host_fingerprint_sha256")
            .eq("ipv4_address", ip)
            .neq("status", "deleted"),
    ]);

    const hostMissingFingerprintColumn = isMissingFingerprintColumnError(hostError);
    const instanceMissingFingerprintColumn = isMissingFingerprintColumnError(instanceError);

    if (hostError && !hostMissingFingerprintColumn) {
        throw new Error(`Failed to look up managed host fingerprint: ${hostError.message}`);
    }
    if (instanceError && !instanceMissingFingerprintColumn) {
        throw new Error(`Failed to look up legacy instance fingerprint: ${instanceError.message}`);
    }

    let hostRows: FingerprintLookupRow[] = Array.isArray(hosts) ? (hosts as FingerprintLookupRow[]) : [];
    let instanceRows: FingerprintLookupRow[] = Array.isArray(instances) ? (instances as FingerprintLookupRow[]) : [];

    if (hostMissingFingerprintColumn) {
        const { data: hostFallbackRows, error: hostFallbackError } = await supabaseAdmin
            .from("hermes_hosts")
            .select("id")
            .eq("ipv4_address", ip);

        if (hostFallbackError) {
            throw new Error(`Failed to look up managed host fingerprint: ${hostFallbackError.message}`);
        }

        hostRows = Array.isArray(hostFallbackRows) ? (hostFallbackRows as FingerprintLookupRow[]) : [];
    }

    if (instanceMissingFingerprintColumn) {
        const { data: instanceFallbackRows, error: instanceFallbackError } = await supabaseAdmin
            .from("hermes_instances")
            .select("id")
            .eq("ipv4_address", ip)
            .neq("status", "deleted");

        if (instanceFallbackError) {
            throw new Error(`Failed to look up legacy instance fingerprint: ${instanceFallbackError.message}`);
        }

        instanceRows = Array.isArray(instanceFallbackRows) ? (instanceFallbackRows as FingerprintLookupRow[]) : [];
    }

    const hostFingerprint = hostRows
        ?.map((row) => row.ssh_host_fingerprint_sha256)
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (hostFingerprint) {
        return { managed: true, fingerprint: normalizeHostFingerprint(hostFingerprint) };
    }

    const instanceFingerprint = instanceRows
        ?.map((row) => row.ssh_host_fingerprint_sha256)
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (instanceFingerprint) {
        return { managed: true, fingerprint: normalizeHostFingerprint(instanceFingerprint) };
    }

    const managed = hostRows.length > 0 || instanceRows.length > 0;
    return { managed, fingerprint: null };
}

export async function persistManagedHostFingerprint(ip: string, fingerprint: string): Promise<void> {
    if (!supabaseAdmin) {
        return;
    }

    const normalized = normalizeHostFingerprint(fingerprint);
    const [hostResult, instanceResult] = await Promise.all([
        supabaseAdmin
            .from("hermes_hosts")
            .update({ ssh_host_fingerprint_sha256: normalized })
            .eq("ipv4_address", ip),
        supabaseAdmin
            .from("hermes_instances")
            .update({ ssh_host_fingerprint_sha256: normalized })
            .eq("ipv4_address", ip)
            .neq("status", "deleted"),
    ]);

    if (hostResult.error && !isMissingFingerprintColumnError(hostResult.error)) {
        throw new Error(`Failed to persist host SSH fingerprint: ${hostResult.error.message}`);
    }
    if (instanceResult.error && !isMissingFingerprintColumnError(instanceResult.error)) {
        throw new Error(`Failed to persist legacy instance SSH fingerprint: ${instanceResult.error.message}`);
    }
}

export async function refreshManagedHostFingerprint(
    ip: string,
    deps: {
        getExpectedHostFingerprint?: typeof getExpectedHostFingerprint;
        lookupManagedHostFingerprint?: typeof lookupManagedHostFingerprint;
        captureHostFingerprint?: typeof captureHostFingerprint;
        persistManagedHostFingerprint?: typeof persistManagedHostFingerprint;
    } = {},
    timeoutMs = 15_000
): Promise<string | null> {
    validateIp(ip);

    const getExpected = deps.getExpectedHostFingerprint ?? getExpectedHostFingerprint;
    const lookupManaged = deps.lookupManagedHostFingerprint ?? lookupManagedHostFingerprint;
    const captureFingerprint = deps.captureHostFingerprint ?? captureHostFingerprint;
    const persistFingerprint = deps.persistManagedHostFingerprint ?? persistManagedHostFingerprint;

    if (getExpected(ip)) {
        return null;
    }

    const managedFingerprint = await lookupManaged(ip);
    if (!managedFingerprint.managed) {
        return null;
    }

    const capturedFingerprint = await captureFingerprint(ip, timeoutMs);
    await persistFingerprint(ip, capturedFingerprint);
    managedFingerprintCache.set(ip, capturedFingerprint);
    return capturedFingerprint;
}

export async function ensureManagedHostFingerprint(
    ip: string,
    deps: {
        getExpectedHostFingerprint?: typeof getExpectedHostFingerprint;
        lookupManagedHostFingerprint?: typeof lookupManagedHostFingerprint;
        captureHostFingerprint?: typeof captureHostFingerprint;
        persistManagedHostFingerprint?: typeof persistManagedHostFingerprint;
    } = {},
    timeoutMs = 15_000
): Promise<string | null> {
    validateIp(ip);

    const getExpected = deps.getExpectedHostFingerprint ?? getExpectedHostFingerprint;
    const lookupManaged = deps.lookupManagedHostFingerprint ?? lookupManagedHostFingerprint;
    const captureFingerprint = deps.captureHostFingerprint ?? captureHostFingerprint;
    const persistFingerprint = deps.persistManagedHostFingerprint ?? persistManagedHostFingerprint;

    const envFingerprint = getExpected(ip);
    if (envFingerprint) {
        managedFingerprintCache.set(ip, envFingerprint);
        return envFingerprint;
    }

    const cached = managedFingerprintCache.get(ip);
    if (cached) {
        return cached;
    }

    const managedFingerprint = await lookupManaged(ip);
    if (managedFingerprint.fingerprint) {
        managedFingerprintCache.set(ip, managedFingerprint.fingerprint);
        return managedFingerprint.fingerprint;
    }

    if (!managedFingerprint.managed) {
        return null;
    }

    const capturedFingerprint = await captureFingerprint(ip, timeoutMs);
    await persistFingerprint(ip, capturedFingerprint);
    managedFingerprintCache.set(ip, capturedFingerprint);
    return capturedFingerprint;
}

function isRetryableFingerprintCaptureError(message: string): boolean {
    const normalized = message.toLowerCase();

    return (
        isSshWarmupError(message) ||
        normalized.includes("etimedout") ||
        normalized.includes("econnrefused") ||
        normalized.includes("econnreset") ||
        normalized.includes("ehostunreach") ||
        normalized.includes("enetunreach")
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureHostFingerprintOnce(ip: string, timeoutMs: number): Promise<string> {
    validateIp(ip);

    return new Promise<string>((resolve, reject) => {
        const conn = new Client();
        let settled = false;
        let capturedFingerprint: string | null = null;

        const finishResolve = (fingerprint: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            conn.destroy();
            resolve(fingerprint);
        };

        const finishReject = (error: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            conn.destroy();
            reject(new Error(error));
        };

        const timer = setTimeout(() => {
            finishReject(`Timed out capturing SSH host fingerprint from ${ip} after ${timeoutMs}ms`);
        }, timeoutMs);

        conn.on("error", (err) => {
            if (capturedFingerprint) {
                finishResolve(capturedFingerprint);
                return;
            }
            finishReject(`SSH fingerprint capture failed: ${err.message}`);
        });

        conn.on("close", () => {
            if (capturedFingerprint) {
                finishResolve(capturedFingerprint);
            }
        });

        try {
            conn.connect({
                host: ip,
                port: 22,
                username: "root",
                privateKey: getPrivateKey(),
                readyTimeout: Math.min(timeoutMs, 60_000),
                hostVerifier: (key: Buffer | string) => {
                    const rawKey = Buffer.isBuffer(key) ? key : Buffer.from(key);
                    capturedFingerprint = createHash("sha256").update(rawKey).digest("hex");
                    return false;
                },
            });
        } catch (err) {
            finishReject(err instanceof Error ? err.message : String(err));
        }
    });
}

export async function captureHostFingerprint(ip: string, timeoutMs = 15_000): Promise<string> {
    validateIp(ip);

    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;

    while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            break;
        }

        try {
            return await captureHostFingerprintOnce(ip, remainingMs);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            lastError = error;

            if (!isRetryableFingerprintCaptureError(error.message)) {
                throw error;
            }

            const retryDelayMs = Math.min(
                SSH_FINGERPRINT_RETRY_DELAY_MS,
                Math.max(0, deadline - Date.now())
            );

            if (retryDelayMs <= 0) {
                break;
            }

            await delay(retryDelayMs);
        }
    }

    throw lastError ?? new Error(`Timed out capturing SSH host fingerprint from ${ip} after ${timeoutMs}ms`);
}

async function resolveExpectedHostFingerprint(ip: string, timeoutMs: number): Promise<string | null> {
    return ensureManagedHostFingerprint(ip, {}, timeoutMs);
}

export async function resolveSshConnectConfig(
    ip: string,
    timeoutMs: number,
    options: { expectedFingerprint?: string | null } = {}
): Promise<ConnectConfig> {
    validateIp(ip);

    const resolvedExpectedFingerprint = options.expectedFingerprint
        ? normalizeHostFingerprint(options.expectedFingerprint)
        : await resolveExpectedHostFingerprint(ip, timeoutMs);

    return buildConnectConfig(ip, timeoutMs, {
        expectedFingerprint: resolvedExpectedFingerprint,
    });
}

export function getPrivateKey(): string {
    // Try env var first (base64-encoded PEM)
    const b64 = process.env.HETZNER_SSH_PRIVATE_KEY_B64;
    if (b64) {
        // Vercel can sometimes pad base64 strings or inject literal "\n" strings if not set carefully
        const cleanB64 = b64.replace(/\s+/g, '').replace(/\\n/g, '').replace(/^"|"$/g, '');
        return Buffer.from(cleanB64, "base64").toString("utf8");
    }

    // Fallback: file on disk
    const HETZNER_SSH_KEY_PATH = process.env.HETZNER_SSH_KEY_PATH || "/tmp/hetzner_key";
    if (fs.existsSync(/*turbopackIgnore: true*/ HETZNER_SSH_KEY_PATH)) {
        return fs.readFileSync(/*turbopackIgnore: true*/ HETZNER_SSH_KEY_PATH, "utf8");
    }

    throw new Error(
        "No SSH private key configured. Set HETZNER_SSH_PRIVATE_KEY_B64 env var."
    );
}

export function buildConnectConfig(
    ip: string,
    timeoutMs: number,
    options: { expectedFingerprint?: string | null } = {}
): ConnectConfig {
    const config: ConnectConfig = {
        host: ip,
        port: 22,
        username: "root",
        privateKey: getPrivateKey(),
        readyTimeout: Math.min(timeoutMs, 60_000), 
        keepaliveInterval: 10_000,
        keepaliveCountMax: 10,
    };

    const expectedFingerprint = options.expectedFingerprint
        ? normalizeHostFingerprint(options.expectedFingerprint)
        : getExpectedHostFingerprint(ip);
    if (expectedFingerprint) {
        config.hostHash = "sha256";
        config.hostVerifier = (fingerprint: string) =>
            String(fingerprint).trim().toLowerCase() === expectedFingerprint;
        return config;
    }

    if (process.env.ALLOW_INSECURE_HETZNER_SSH === "true") {
        return config;
    }

    throw new Error(
        `SSH host fingerprint not configured for ${ip}. Set ${getHostFingerprintEnvKey(ip)} or ` +
        `HETZNER_SSH_HOST_FINGERPRINTS, or explicitly set ALLOW_INSECURE_HETZNER_SSH=true ` +
        `for temporary break-glass access.`
    );
}

// ── Public API ──────────────────────────────────────────────────────────

export interface SshResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    error?: string;
}

/**
 * Wait until a server is reachable via SSH.
 */
export async function waitForSsh(
    ip: string,
    maxWaitMs = 180_000,
    pollMs = 5_000
): Promise<void> {
    validateIp(ip);
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
        const result = await sshExec(ip, "echo ok", { timeoutMs: 15_000 });
        if (result.ok && result.stdout.trim() === "ok") {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
    }

    throw new Error(`SSH not available on ${ip} after ${maxWaitMs}ms`);
}

/**
 * Execute a command on a remote server via SSH.
 */
export async function sshExec(
    ip: string,
    command: string,
    {
        timeoutMs = 120_000,
        expectedFingerprint,
        stdin,
        proxmoxHostConfig,
    }: {
        timeoutMs?: number;
        expectedFingerprint?: string | null;
        proxmoxHostConfig?: ProxmoxSshHostConfig | null;
        /**
         * Optional payload to write to the remote command's stdin. When
         * provided, callers can pass user-controlled data without having
         * to interpolate it into the shell command string — kills shell-
         * injection risk for arbitrary content.
         */
        stdin?: string | Buffer;
    } = {}
): Promise<SshResult> {
    validateIp(ip);

    const inferredProxmoxHostConfig =
        proxmoxHostConfig ?? resolveProxmoxPrivateGuestHostConfig(ip);

    if (proxmoxHostConfig || inferredProxmoxHostConfig || isProxmoxPrivateGuestIp(ip)) {
        return proxmoxGuestSshExec(
            ip,
            command,
            timeoutMs,
            stdin,
            inferredProxmoxHostConfig
        );
    }

    const callerSpecifiedFingerprint = expectedFingerprint !== undefined;

    let connectConfig: ConnectConfig;
    try {
        connectConfig = await resolveSshConnectConfig(ip, timeoutMs, {
            expectedFingerprint,
        });
    } catch (err) {
        return {
            ok: false,
            stdout: "",
            stderr: "",
            error: err instanceof Error ? err.message : String(err),
        };
    }

    const executeAttempt = async (
        activeConfig: ConnectConfig,
        allowFingerprintRefresh: boolean
    ): Promise<SshResult> =>
        new Promise<SshResult>((resolve) => {
            const conn = new Client();
            let settled = false;
            const timerObj: { current?: NodeJS.Timeout } = {};

            const finish = (result: SshResult) => {
                if (settled) return;
                settled = true;
                if (timerObj.current !== undefined) clearTimeout(timerObj.current);

                if (!result.ok) {
                    conn.destroy();
                } else {
                    conn.end();
                }
                resolve(result);
            };

            // Global timeout for the entire operation
            timerObj.current = setTimeout(() => {
                finish({
                    ok: false,
                    stdout: "",
                    stderr: "",
                    error: `SSH operation timed out after ${timeoutMs}ms`,
                });
            }, timeoutMs);

            conn.on("ready", () => {
                conn.exec(command, (err, stream) => {
                    if (err) {
                        finish({
                            ok: false,
                            stdout: "",
                            stderr: "",
                            error: err.message,
                        });
                        return;
                    }

                    if (stdin !== undefined) {
                        try {
                            stream.stdin.end(stdin);
                        } catch (writeErr) {
                            finish({
                                ok: false,
                                stdout: "",
                                stderr: "",
                                error: `SSH stdin write failed: ${
                                    writeErr instanceof Error ? writeErr.message : String(writeErr)
                                }`,
                            });
                            return;
                        }
                    }

                    const stdoutChunks: Buffer[] = [];
                    const stderrChunks: Buffer[] = [];

                    stream.on("data", (data: Buffer) => {
                        stdoutChunks.push(data);
                    });

                    stream.stderr.on("data", (data: Buffer) => {
                        stderrChunks.push(data);
                    });

                    stream.on("close", (code: number | null) => {
                        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
                        const stderr = Buffer.concat(stderrChunks).toString("utf8");

                        if (code !== 0 && code !== null) {
                            finish({
                                ok: false,
                                stdout,
                                stderr,
                                error: `Command exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
                            });
                        } else {
                            finish({ ok: true, stdout, stderr });
                        }
                    });

                    stream.on("error", (err: Error) => {
                        finish({
                            ok: false,
                            stdout: "",
                            stderr: "",
                            error: `SSH Stream Error: ${err.message}`,
                        });
                    });
                });
            });

            conn.on("error", (err) => {
                const errorMessage = `SSH connection error: ${err.message}`;

                if (allowFingerprintRefresh && isSshHostVerificationFailure(err.message)) {
                    if (settled) return;
                    settled = true;
                    if (timerObj.current !== undefined) clearTimeout(timerObj.current);
                    conn.destroy();

                    void (async () => {
                        try {
                            const refreshedFingerprint = await refreshManagedHostFingerprint(ip, {}, timeoutMs);
                            if (refreshedFingerprint) {
                                const retryConfig = buildConnectConfig(ip, timeoutMs, {
                                    expectedFingerprint: refreshedFingerprint,
                                });
                                resolve(await executeAttempt(retryConfig, false));
                                return;
                            }
                        } catch (refreshErr) {
                            resolve({
                                ok: false,
                                stdout: "",
                                stderr: "",
                                error: `${errorMessage}. Fingerprint refresh failed: ${
                                    refreshErr instanceof Error ? refreshErr.message : String(refreshErr)
                                }`,
                            });
                            return;
                        }

                        resolve({
                            ok: false,
                            stdout: "",
                            stderr: "",
                            error: errorMessage,
                        });
                    })();
                    return;
                }

                finish({
                    ok: false,
                    stdout: "",
                    stderr: "",
                    error: errorMessage,
                });
            });

            try {
                conn.connect(activeConfig);
            } catch (err) {
                finish({
                    ok: false,
                    stdout: "",
                    stderr: "",
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        });

    return executeAttempt(connectConfig, !callerSpecifiedFingerprint);
}

/**
 * Creates an interactive SSH shell and returns the SSH Client and ClientChannel.
 */
export function createSshShell(
    ip: string,
    onData: (data: Buffer | string) => void,
    onReady: (conn: Client, stream: import("ssh2").ClientChannel) => void,
    onClose: () => void,
    onError: (err: Error) => void
): void {
    void (async () => {
        try {
            const config = await resolveSshConnectConfig(ip, 60_000);

            const conn = new Client();

            conn.on("ready", () => {
                // Suppress the ugly Ubuntu MOTD permanently so our splash screen isn't pushed away
                conn.exec("touch ~/.hushlogin", () => {
                    conn.shell({ term: "xterm-256color" }, (err, stream) => {
                        if (err) {
                            onError(err);
                            conn.end();
                            return;
                        }

                        stream.on("data", (data: Buffer) => onData(data));
                        stream.stderr.on("data", (data: Buffer) => onData(data));

                        stream.on("close", () => {
                            conn.end();
                        });

                        stream.on("error", (streamErr: Error) => {
                            onError(streamErr);
                        });

                        onReady(conn, stream);
                    });
                });
            });

            conn.on("error", (connErr) => {
                onError(connErr);
            });

            conn.on("close", () => {
                onClose();
            });

            conn.connect(config);
        } catch (err) {
            onError(err instanceof Error ? err : new Error(String(err)));
        }
    })();
}
