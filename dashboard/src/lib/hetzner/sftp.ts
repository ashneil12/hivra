import { Client, type SFTPWrapper, type Stats } from "ssh2";
import { isProxmoxPrivateGuestIp, resolveSshConnectConfig, sshExec, type ProxmoxSshHostConfig } from "./ssh";

export interface FileItem {
    name: string;
    type: 'file' | 'directory' | 'symlink' | 'other';
    size: number;
    modifyTime: number; // Unix timestamp in seconds
}

export class SftpPreviewLimitError extends Error {
    readonly status = 413;

    constructor(maxBytes: number) {
        super(`File too large to preview in browser (max ${formatPreviewMegabytes(maxBytes)})`);
        this.name = 'SftpPreviewLimitError';
    }
}

const SFTP_CONNECT_TIMEOUT_MS = 15_000;
const SFTP_IDLE_TIMEOUT_MS = 20_000;
const PROXMOX_SFTP_TIMEOUT_MS = 60_000;

type PooledSshConnection = {
    conn: Client;
    readyPromise: Promise<Client>;
    state: "connecting" | "ready" | "closed";
    idleTimer: ReturnType<typeof setTimeout> | null;
};

const connectionPool = new Map<string, PooledSshConnection>();

function formatPreviewMegabytes(maxBytes: number) {
    return `${(maxBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getType(attrs: Stats): 'file' | 'directory' | 'symlink' | 'other' {
    if (attrs.isDirectory()) return 'directory';
    if (attrs.isFile()) return 'file';
    if (attrs.isSymbolicLink()) return 'symlink';
    return 'other';
}

function clearIdleTimer(entry: PooledSshConnection) {
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
}

function closeClient(conn: Client) {
    try {
        conn.end();
    } catch {
        try {
            (conn as Client & { destroy?: () => void }).destroy?.();
        } catch {
            // ignore shutdown cleanup failures
        }
    }
}

function destroyConnection(ip: string, entry = connectionPool.get(ip)) {
    if (!entry) return;
    if (connectionPool.get(ip) === entry) {
        connectionPool.delete(ip);
    }
    entry.state = "closed";
    clearIdleTimer(entry);
    closeClient(entry.conn);
}

function scheduleIdleCleanup(ip: string, entry: PooledSshConnection) {
    clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
        if (connectionPool.get(ip) === entry) {
            destroyConnection(ip, entry);
        }
    }, SFTP_IDLE_TIMEOUT_MS);
    entry.idleTimer.unref?.();
}

function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

const PROXMOX_SFTP_HELPER_SCRIPT = String.raw`
import base64
import errno
import json
import os
import stat
import sys

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")))

def error_code(exc):
    code = getattr(exc, "errno", None)
    if code is not None:
        return errno.errorcode.get(code, str(code))
    return type(exc).__name__

def file_type(mode):
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"

try:
    payload = json.load(sys.stdin)
    action = payload.get("action")
    target_path = payload.get("path")
    if not isinstance(target_path, str) or not target_path:
        raise ValueError("Missing path")

    if action == "realpath":
        emit({"ok": True, "path": os.path.realpath(target_path)})
    elif action == "list":
        files = []
        with os.scandir(target_path) as entries:
            for entry in entries:
                try:
                    attrs = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue
                item_type = file_type(attrs.st_mode)
                files.append({
                    "name": entry.name,
                    "type": item_type,
                    "size": int(attrs.st_size or 0),
                    "modifyTime": int(attrs.st_mtime or 0),
                })
        files.sort(key=lambda item: (0 if item["type"] == "directory" else 1, item["name"].casefold()))
        emit({"ok": True, "files": files})
    elif action == "read":
        max_bytes = int(payload.get("maxBytes", 2 * 1024 * 1024))
        size = os.stat(target_path).st_size
        if size > max_bytes:
            emit({"ok": False, "code": "EFBIG", "error": "File too large to read in browser (max 2MB)"})
        else:
            with open(target_path, "rb") as handle:
                data = handle.read(max_bytes + 1)
            if len(data) > max_bytes:
                emit({"ok": False, "code": "EFBIG", "error": "File too large to read in browser (max 2MB)"})
            else:
                emit({"ok": True, "content": data.decode("utf-8", errors="replace")})
    elif action == "readBinary":
        max_bytes = int(payload.get("maxBytes", 8 * 1024 * 1024))
        size = os.stat(target_path).st_size
        if size > max_bytes:
            emit({"ok": False, "code": "EFBIG", "error": "File too large to preview"})
        else:
            with open(target_path, "rb") as handle:
                data = handle.read(max_bytes + 1)
            if len(data) > max_bytes:
                emit({"ok": False, "code": "EFBIG", "error": "File too large to preview"})
            else:
                emit({"ok": True, "contentBase64": base64.b64encode(data).decode("ascii")})
    elif action == "write":
        content = payload.get("content", "")
        if not isinstance(content, str):
            raise ValueError("Content must be a string")
        with open(target_path, "w", encoding="utf-8") as handle:
            handle.write(content)
        emit({"ok": True})
    else:
        raise ValueError("Unsupported action")
except Exception as exc:
    emit({"ok": False, "code": error_code(exc), "error": str(exc)})
`;

type ProxmoxSftpPayload =
    | { action: "list"; path: string }
    | { action: "realpath"; path: string }
    | { action: "read"; path: string; maxBytes: number }
    | { action: "readBinary"; path: string; maxBytes: number }
    | { action: "write"; path: string; content: string };

type ProxmoxSftpResponse =
    | { ok: true; files?: FileItem[]; path?: string; content?: string; contentBase64?: string }
    | { ok: false; code?: string; error?: string };

function parseProxmoxSftpResponse(stdout: string): ProxmoxSftpResponse {
    const jsonLine = stdout
        .trim()
        .split(/\r?\n/)
        .reverse()
        .find((line) => line.trim().startsWith("{") && line.trim().endsWith("}"));

    if (!jsonLine) {
        throw new Error("Proxmox SFTP helper returned invalid JSON");
    }

    return JSON.parse(jsonLine) as ProxmoxSftpResponse;
}

function throwProxmoxSftpError(response: Extract<ProxmoxSftpResponse, { ok: false }>): never {
    const err = new Error(response.error || "Remote filesystem operation failed") as Error & { code?: string };
    if (response.code) {
        err.code = response.code;
    }
    throw err;
}

async function runProxmoxSftpOperation(
    ip: string,
    payload: ProxmoxSftpPayload,
    guestTarget: ProxmoxSshHostConfig | null | undefined
): Promise<ProxmoxSftpResponse> {
    const result = await sshExec(ip, `python3 -c ${shellQuote(PROXMOX_SFTP_HELPER_SCRIPT)}`, {
        timeoutMs: PROXMOX_SFTP_TIMEOUT_MS,
        stdin: JSON.stringify(payload),
        ...(guestTarget ? { proxmoxHostConfig: guestTarget } : {}),
    });

    if (!result.ok) {
        throw new Error(result.stderr?.trim() || result.error?.trim() || "Remote filesystem operation failed");
    }

    return parseProxmoxSftpResponse(result.stdout);
}

function isRetryableConnectionError(err: unknown): boolean {
    const message = getErrorMessage(err).toLowerCase();
    return (
        message.includes("timed out") ||
        message.includes("timeout") ||
        message.includes("connection lost") ||
        message.includes("connection reset") ||
        message.includes("socket closed") ||
        message.includes("not connected") ||
        message.includes("channel") ||
        message.includes("econnreset") ||
        message.includes("econnrefused") ||
        message.includes("ehostunreach") ||
        message.includes("enetunreach")
    );
}

function createConnection(ip: string): Promise<Client> {
    const conn = new Client();
    let settleReady: ((value: Client) => void) | null = null;
    let settleError: ((reason?: unknown) => void) | null = null;
    let readySettled = false;

    const readyPromise = new Promise<Client>((resolve, reject) => {
        settleReady = resolve;
        settleError = reject;
    });

    const entry: PooledSshConnection = {
        conn,
        readyPromise,
        state: "connecting",
        idleTimer: null,
    };

    connectionPool.set(ip, entry);

    const settleReject = (reason: unknown) => {
        if (readySettled) return;
        readySettled = true;
        settleError?.(reason);
    };

    const settleResolve = (client: Client) => {
        if (readySettled) return;
        readySettled = true;
        settleReady?.(client);
    };

    const connectTimeout = setTimeout(() => {
        destroyConnection(ip, entry);
        settleReject(new Error("SSH connection timed out"));
    }, SFTP_CONNECT_TIMEOUT_MS);
    connectTimeout.unref?.();

    const clearConnectTimeout = () => clearTimeout(connectTimeout);

    conn.on("ready", () => {
        clearConnectTimeout();
        entry.state = "ready";
        scheduleIdleCleanup(ip, entry);
        settleResolve(conn);
    });

    conn.on("error", (err) => {
        clearConnectTimeout();
        if (entry.state !== "ready") {
            destroyConnection(ip, entry);
            settleReject(err);
            return;
        }

        destroyConnection(ip, entry);
    });

    conn.on("close", () => {
        clearConnectTimeout();
        if (entry.state !== "ready") {
            destroyConnection(ip, entry);
            settleReject(new Error("SSH connection closed before it became ready"));
            return;
        }

        destroyConnection(ip, entry);
    });

    void resolveSshConnectConfig(ip, SFTP_CONNECT_TIMEOUT_MS)
        .then((connectConfig) => {
            if (entry.state === "closed") return;
            conn.connect(connectConfig);
        })
        .catch((err) => {
            clearConnectTimeout();
            destroyConnection(ip, entry);
            settleReject(err);
        });

    return readyPromise.catch((err) => {
        destroyConnection(ip, entry);
        throw err;
    });
}

async function getConnection(ip: string): Promise<Client> {
    const existing = connectionPool.get(ip);
    if (existing && existing.state !== "closed") {
        clearIdleTimer(existing);
        return existing.readyPromise;
    }

    return createConnection(ip);
}

async function withSftpChannel<T>(
    ip: string,
    operation: (sftp: SFTPWrapper) => Promise<T>,
    attempt = 0,
): Promise<T> {
    let conn: Client | null = null;

    try {
        conn = await getConnection(ip);

        const result = await new Promise<T>((resolve, reject) => {
            conn!.sftp((err, sftp) => {
                if (err || !sftp) {
                    reject(err ?? new Error("Failed to open SFTP session"));
                    return;
                }

                let settled = false;
                const finish = (error: unknown | null, value?: T) => {
                    if (settled) return;
                    settled = true;

                    try {
                        (sftp as SFTPWrapper & { end?: () => void }).end?.();
                    } catch {
                        // ignore wrapper shutdown failures
                    }

                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve(value as T);
                };

                (sftp as SFTPWrapper & { on?: (event: string, listener: (error: unknown) => void) => void }).on?.(
                    "error",
                    (wrapperError: unknown) => finish(wrapperError),
                );

                void operation(sftp).then(
                    (value) => finish(null, value),
                    (error) => finish(error),
                );
            });
        });

        const entry = connectionPool.get(ip);
        if (entry && entry.conn === conn && entry.state === "ready") {
            scheduleIdleCleanup(ip, entry);
        }

        return result;
    } catch (err) {
        if (conn) {
            destroyConnection(ip);
        }

        if (attempt === 0 && isRetryableConnectionError(err)) {
            return withSftpChannel(ip, operation, attempt + 1);
        }

        throw err;
    }
}

export async function sftpList(
    ip: string,
    targetPath: string,
    guestTarget?: ProxmoxSshHostConfig | null
): Promise<FileItem[]> {
    if (guestTarget || isProxmoxPrivateGuestIp(ip)) {
        const response = await runProxmoxSftpOperation(ip, { action: "list", path: targetPath }, guestTarget);
        if (!response.ok) {
            throwProxmoxSftpError(response);
        }
        return response.files ?? [];
    }

    return withSftpChannel(ip, (sftp) =>
        new Promise((resolve, reject) => {
            sftp.readdir(targetPath, (err, list) => {
                if (err) return reject(err);

                const files: FileItem[] = list.map(item => ({
                    name: item.filename,
                    type: getType(item.attrs),
                    size: item.attrs.size || 0,
                    modifyTime: item.attrs.mtime || 0
                })).sort((a, b) => {
                    // Directories first, then alphabetical
                    if (a.type === 'directory' && b.type !== 'directory') return -1;
                    if (b.type === 'directory' && a.type !== 'directory') return 1;
                    return a.name.localeCompare(b.name);
                });

                resolve(files);
            });
        })
    );
}

export async function sftpRealpath(
    ip: string,
    targetPath: string,
    guestTarget?: ProxmoxSshHostConfig | null
): Promise<string> {
    if (guestTarget || isProxmoxPrivateGuestIp(ip)) {
        const response = await runProxmoxSftpOperation(ip, { action: "realpath", path: targetPath }, guestTarget);
        if (!response.ok) {
            throwProxmoxSftpError(response);
        }
        return response.path ?? targetPath;
    }

    return withSftpChannel(ip, (sftp) =>
        new Promise((resolve, reject) => {
            sftp.realpath(targetPath, (err, resolvedPath) => {
                if (err) return reject(err);
                resolve(resolvedPath);
            });
        })
    );
}

export async function sftpRead(
    ip: string,
    filePath: string,
    guestTarget?: ProxmoxSshHostConfig | null
): Promise<string> {
    if (guestTarget || isProxmoxPrivateGuestIp(ip)) {
        const response = await runProxmoxSftpOperation(ip, {
            action: "read",
            path: filePath,
            maxBytes: 2 * 1024 * 1024,
        }, guestTarget);
        if (!response.ok) {
            throwProxmoxSftpError(response);
        }
        return response.content ?? "";
    }

    return withSftpChannel(ip, (sftp) =>
        new Promise((resolve, reject) => {
            // Read file size first to prevent memory exhaustion
            sftp.stat(filePath, (err, stats) => {
                if (err) {
                    return reject(err);
                }
                if (stats.size > 2 * 1024 * 1024) {
                    return reject(new Error("File too large to read in browser (max 2MB)"));
                }

                sftp.readFile(filePath, 'utf8', (err, data) => {
                    if (err) return reject(err);
                    resolve(data.toString());
                });
            });
        })
    );
}

export async function sftpReadBinary(
    ip: string,
    filePath: string,
    maxBytes = 8 * 1024 * 1024,
    guestTarget?: ProxmoxSshHostConfig | null
): Promise<Buffer> {
    if (guestTarget || isProxmoxPrivateGuestIp(ip)) {
        const response = await runProxmoxSftpOperation(ip, {
            action: "readBinary",
            path: filePath,
            maxBytes,
        }, guestTarget);
        if (!response.ok) {
            if (response.code === "EFBIG") {
                throw new SftpPreviewLimitError(maxBytes);
            }
            throwProxmoxSftpError(response);
        }
        return Buffer.from(response.contentBase64 ?? "", "base64");
    }

    return withSftpChannel(ip, (sftp) =>
        new Promise((resolve, reject) => {
            sftp.stat(filePath, (err, stats) => {
                if (err) {
                    return reject(err);
                }
                if (stats.size > maxBytes) {
                    return reject(new SftpPreviewLimitError(maxBytes));
                }

                sftp.readFile(filePath, (err, data) => {
                    if (err) return reject(err);
                    resolve(data);
                });
            });
        })
    );
}

export async function sftpWrite(
    ip: string,
    filePath: string,
    content: string,
    guestTarget?: ProxmoxSshHostConfig | null
): Promise<void> {
    if (guestTarget || isProxmoxPrivateGuestIp(ip)) {
        const response = await runProxmoxSftpOperation(ip, {
            action: "write",
            path: filePath,
            content,
        }, guestTarget);
        if (!response.ok) {
            throwProxmoxSftpError(response);
        }
        return;
    }

    return withSftpChannel(ip, (sftp) =>
        new Promise((resolve, reject) => {
            sftp.writeFile(filePath, content, 'utf8', (err) => {
                if (err) return reject(err);
                resolve();
            });
        })
    );
}
