'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AlertTriangle, Clipboard, Eraser, Loader2, RefreshCw, RotateCcw, Terminal as TerminalIcon, Wifi } from 'lucide-react';
import { useTheme } from 'next-themes';
import styles from './TerminalPanel.module.css';
import { clientLog } from '@/lib/client/logger';
import { getHermesTuiTheme, resolveHermesTuiColorMode, type HermesTuiColorMode } from '@/lib/tui-theme';
interface TerminalPanelProps {
    instanceId: string; isActive: boolean; sessionMode?: 'shell' | 'tui'; colorMode?: HermesTuiColorMode; surfaceKey?: string;
}
interface PersistedTerminalSession { sessionKey: string; sessionToken: string; gatewayWebSocketUrl?: string; }
type ConnState = 'init' | 'connecting' | 'connected' | 'error' | 'closed';
interface PendingTerminalRttSample { char: string; startedAt: number; }
const TERMINAL_RTT_SAMPLE_EVENT = 'terminal-rtt-sample';
const TERMINAL_RTT_MAX_PENDING_SAMPLES = 200;
const TERMINAL_RTT_STALE_SAMPLE_MS = 30_000;
const RESIZE_DEBOUNCE_MS = 120;
const SSE_RETRY_DELAY_MS = 500;
const MAX_INPUT_CHUNK_BYTES = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function shouldPersistTerminalSession(surfaceKey: string | undefined) { return surfaceKey?.startsWith('tui-') === true; }
function terminalRttDebugEnabled() { return process.env.NEXT_PUBLIC_TERMINAL_DEBUG_RTT === '1'; }
function withIncludeScrollback(rawUrl: string, includeScrollback: boolean): string | null {
    try {
        const parsed = new URL(rawUrl);
        parsed.searchParams.set('includeScrollback', includeScrollback ? '1' : '0');
        return parsed.toString();
    } catch {
        return null;
    }
}
function isPrintableTerminalRttChar(data: string) {
    if (data.length !== 1) return false;
    const code = data.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e;
}
function chunkTerminalInput(data: string) {
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += MAX_INPUT_CHUNK_BYTES) {
        chunks.push(data.slice(i, i + MAX_INPUT_CHUNK_BYTES));
    }
    return chunks;
}
export function TerminalPanel({ instanceId, isActive, sessionMode = 'shell', colorMode, surfaceKey }: TerminalPanelProps) {
    const { resolvedTheme } = useTheme();
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);
    const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
    const eventSourceRef = useRef<EventSource | null>(null);
    const webSocketRef = useRef<WebSocket | null>(null);
    const sessionKeyRef = useRef<string | null>(null);
    const sessionTokenRef = useRef<string | null>(null);
    const gatewayWebSocketUrlRef = useRef<string | null>(null);
    const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const streamRetryUsedRef = useRef(false);
    const mountedRef = useRef(false);
    const isActiveRef = useRef(isActive);
    const terminalRttSequenceRef = useRef(0);
    const pendingTerminalRttSamplesRef = useRef(new Map<string, PendingTerminalRttSample>());
    const pendingTerminalRttKeysByCharRef = useRef(new Map<string, string[]>());
    const [connState, setConnState] = useState<ConnState>('init');
    const [errMsg, setErrMsg] = useState<string | null>(null);
    const apiBase = `/api/instances/${instanceId}/terminal/interactive`;
    const surfaceKeySuffix = surfaceKey ? `:${surfaceKey}` : '';
    const persistedSessionStorageKey = `${apiBase}:${sessionMode}:persisted-session${surfaceKeySuffix}`;
    const terminalSurfaceId = surfaceKey ? `terminal-${instanceId}-${surfaceKey}` : `terminal-${instanceId}`;
    const persistSessionForSurface = shouldPersistTerminalSession(surfaceKey);
    const resolvedColorMode = useMemo(() => colorMode ?? resolveHermesTuiColorMode(resolvedTheme), [colorMode, resolvedTheme]);
    const tuiTheme = useMemo(() => getHermesTuiTheme(resolvedColorMode), [resolvedColorMode]);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
    const focusTerminal = useCallback(() => { termRef.current?.focus(); }, []);
    const logTerminalWarning = useCallback((message: string, failureType: string, err?: unknown) => {
        clientLog.warn(message, {
            source: 'terminal-panel',
            instanceId,
            terminalMode: sessionMode,
            surfaceKey,
            failureType,
        }, err);
    }, [instanceId, sessionMode, surfaceKey]);
    const pruneTerminalRttSamples = useCallback((now: number) => {
        const pendingSamples = pendingTerminalRttSamplesRef.current;
        let removedStaleSample = false;
        for (const [key, sample] of pendingSamples.entries()) {
            if (now - sample.startedAt > TERMINAL_RTT_STALE_SAMPLE_MS) {
                pendingSamples.delete(key);
                removedStaleSample = true;
            }
        }
        if (pendingSamples.size > TERMINAL_RTT_MAX_PENDING_SAMPLES) {
            pendingSamples.clear();
            pendingTerminalRttKeysByCharRef.current.clear();
            return;
        }
        if (!removedStaleSample) return;
        const rebuiltKeysByChar = new Map<string, string[]>();
        for (const [key, sample] of pendingSamples.entries()) {
            const pendingKeys = rebuiltKeysByChar.get(sample.char) ?? [];
            pendingKeys.push(key);
            rebuiltKeysByChar.set(sample.char, pendingKeys);
        }
        pendingTerminalRttKeysByCharRef.current = rebuiltKeysByChar;
    }, []);
    const recordTerminalRttInput = useCallback((data: string) => {
        if (!terminalRttDebugEnabled() || !isPrintableTerminalRttChar(data)) return;
        const now = performance.now();
        pruneTerminalRttSamples(now);
        const key = `${data}:${terminalRttSequenceRef.current++}`;
        pendingTerminalRttSamplesRef.current.set(key, {
            char: data,
            startedAt: now,
        });
        const pendingKeys = pendingTerminalRttKeysByCharRef.current.get(data) ?? [];
        pendingKeys.push(key);
        pendingTerminalRttKeysByCharRef.current.set(data, pendingKeys);
    }, [pruneTerminalRttSamples]);
    const observeTerminalRttOutput = useCallback((data: string, transport: 'sse' | 'websocket' = 'sse') => {
        if (!terminalRttDebugEnabled() || !data) return;
        pruneTerminalRttSamples(performance.now());
        for (const char of data) {
            const pendingKeys = pendingTerminalRttKeysByCharRef.current.get(char);
            if (!pendingKeys?.length) continue;
            while (pendingKeys.length) {
                const key = pendingKeys.shift();
                if (!key) break;
                const sample = pendingTerminalRttSamplesRef.current.get(key);
                if (!sample) continue;
                pendingTerminalRttSamplesRef.current.delete(key);
                const ms = performance.now() - sample.startedAt;
                // eslint-disable-next-line no-console -- Env-gated RTT telemetry is intentionally visible in browser devtools.
                console.debug(`[terminal-rtt] char=${sample.char} ms=${ms.toFixed(1)}`);
                if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                    window.dispatchEvent(new CustomEvent(TERMINAL_RTT_SAMPLE_EVENT, {
                        detail: {
                            char: sample.char,
                            ms,
                            sessionMode,
                            surfaceKey,
                            transport,
                        },
                    }));
                }
                break;
            }
            if (pendingKeys.length === 0) {
                pendingTerminalRttKeysByCharRef.current.delete(char);
            }
        }
    }, [pruneTerminalRttSamples, sessionMode, surfaceKey]);
    const postAction = useCallback(async (body: Record<string, unknown>) => {
        const response = await fetch(apiBase, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(
                typeof payload?.error === 'string'
                    ? payload.error
                    : `Terminal request failed with HTTP ${response.status}`,
            );
        }
        return payload;
    }, [apiBase]);
    const readPersistedSession = useCallback((): PersistedTerminalSession | null => {
        if (!persistSessionForSurface || typeof window === 'undefined') return null;
        try {
            const raw = window.sessionStorage.getItem(persistedSessionStorageKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as PersistedTerminalSession | null;
            if (!parsed?.sessionKey || typeof parsed.sessionToken !== 'string' || !UUID_PATTERN.test(parsed.sessionToken)) {
                window.sessionStorage.removeItem(persistedSessionStorageKey);
                return null;
            }
            return {
                sessionKey: parsed.sessionKey,
                sessionToken: parsed.sessionToken,
                gatewayWebSocketUrl: typeof parsed.gatewayWebSocketUrl === 'string' ? parsed.gatewayWebSocketUrl : undefined,
            };
        } catch {
            return null;
        }
    }, [persistSessionForSurface, persistedSessionStorageKey]);
    const persistSession = useCallback((sessionKey: string, sessionToken: string, gatewayWebSocketUrl?: string | null) => {
        if (!persistSessionForSurface || typeof window === 'undefined') return;
        try {
            window.sessionStorage.setItem(
                persistedSessionStorageKey,
                JSON.stringify({
                    sessionKey,
                    sessionToken,
                    ...(gatewayWebSocketUrl ? { gatewayWebSocketUrl } : {}),
                } satisfies PersistedTerminalSession),
            );
        } catch {
            // Storage failure should never break an active terminal.
        }
    }, [persistSessionForSurface, persistedSessionStorageKey]);
    const clearPersistedSession = useCallback(() => {
        if (!persistSessionForSurface || typeof window === 'undefined') return;
        try {
            window.sessionStorage.removeItem(persistedSessionStorageKey);
        } catch {
            // Storage failure should never break the terminal close path.
        }
    }, [persistSessionForSurface, persistedSessionStorageKey]);
    const closeWebSocket = useCallback(() => {
        webSocketRef.current?.close();
        webSocketRef.current = null;
    }, []);
    const sendInput = useCallback((data: string) => {
        const sessionKey = sessionKeyRef.current;
        const sessionToken = sessionTokenRef.current;
        if (!sessionKey || !sessionToken) return;
        const activeWebSocket = webSocketRef.current;
        if (activeWebSocket && activeWebSocket.readyState === WebSocket.OPEN) {
            for (const chunk of chunkTerminalInput(data)) {
                activeWebSocket.send(JSON.stringify({ type: 'input', data: chunk }));
            }
            return;
        }
        for (const chunk of chunkTerminalInput(data)) {
            void fetch(apiBase, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'input',
                    data: chunk,
                    mode: sessionMode,
                    sessionKey,
                    sessionToken,
                }),
            }).catch((err) => {
                logTerminalWarning('Terminal input request failed', 'terminal_input_request_failed', err);
            });
        }
    }, [apiBase, logTerminalWarning, sessionMode]);
    const sendResize = useCallback((cols: number, rows: number) => {
        const sessionKey = sessionKeyRef.current;
        const sessionToken = sessionTokenRef.current;
        if (!sessionKey || !sessionToken) return;
        const activeWebSocket = webSocketRef.current;
        if (activeWebSocket && activeWebSocket.readyState === WebSocket.OPEN) {
            activeWebSocket.send(JSON.stringify({ type: 'resize', cols, rows }));
            return;
        }
        void fetch(apiBase, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'resize',
                cols,
                rows,
                mode: sessionMode,
                sessionKey,
                sessionToken,
            }),
        }).catch((err) => {
            logTerminalWarning('Terminal resize request failed', 'terminal_resize_request_failed', err);
        });
    }, [apiBase, logTerminalWarning, sessionMode]);
    const fitTerminal = useCallback(() => {
        try {
            fitRef.current?.fit();
        } catch {
            return;
        }
    }, []);
    const scheduleResize = useCallback(() => {
        if (resizeTimerRef.current) {
            clearTimeout(resizeTimerRef.current);
        }
        resizeTimerRef.current = setTimeout(() => {
            resizeTimerRef.current = null;
            fitTerminal();
            const term = termRef.current;
            if (!term || term.cols <= 0 || term.rows <= 0) return;
            sendResize(term.cols, term.rows);
        }, RESIZE_DEBOUNCE_MS);
    }, [fitTerminal, sendResize]);
    const closeEventStream = useCallback(() => {
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
    }, []);
    const handleTerminalStreamEvent = useCallback((parsed: {
        type?: string;
        data?: unknown;
        error?: unknown;
        message?: unknown;
    }, transport: 'sse' | 'websocket') => {
        const term = termRef.current;
        if (!term) return;
        if (parsed.type === 'output' && typeof parsed.data === 'string' && parsed.data) {
            observeTerminalRttOutput(parsed.data, transport);
            term.write(parsed.data);
            return;
        }
        if (parsed.type === 'closed') {
            closeEventStream();
            closeWebSocket();
            clearPersistedSession();
            sessionKeyRef.current = null;
            sessionTokenRef.current = null;
            gatewayWebSocketUrlRef.current = null;
            setConnState('closed');
            const message = typeof parsed.message === 'string' ? parsed.message : 'Session closed.';
            setErrMsg(message);
            term.writeln(`\r\n\x1b[31m  [!] ${message}\x1b[0m\r\n`);
            return;
        }
        if (parsed.type === 'error') {
            const message =
                typeof parsed.error === 'string'
                    ? parsed.error
                    : typeof parsed.message === 'string'
                        ? parsed.message
                        : 'Terminal stream error.';
            setConnState('error');
            setErrMsg(message);
            term.writeln(`\r\n\x1b[31m  [!] ${message}\x1b[0m\r\n`);
        }
    }, [clearPersistedSession, closeEventStream, closeWebSocket, observeTerminalRttOutput]);
    const openEventStream = useCallback((
        sessionKey: string,
        sessionToken: string,
        options: { includeScrollback?: boolean; isRetry?: boolean } = {},
    ) => {
        const term = termRef.current;
        if (!term) return;
        closeEventStream();
        if (!options.isRetry) {
            streamRetryUsedRef.current = false;
        }
        const includeScrollback = options.includeScrollback ?? !options.isRetry;
        const sseUrl =
            `${apiBase}?sessionKey=${encodeURIComponent(sessionKey)}&sessionToken=${encodeURIComponent(sessionToken)}&includeScrollback=${includeScrollback ? '1' : '0'}`;
        const eventSource = new EventSource(sseUrl);
        eventSourceRef.current = eventSource;
        eventSource.onopen = () => {
            if (!mountedRef.current || eventSourceRef.current !== eventSource) return;
            streamRetryUsedRef.current = false;
            setConnState('connected');
            setErrMsg(null);
            term.writeln(options.isRetry ? '\r\n\x1b[32m  [+] Reconnected\x1b[0m\r\n' : '\x1b[32m  [+] Connected\x1b[0m\r\n');
            if (isActiveRef.current) {
                scheduleResize();
                focusTerminal();
            }
        };
        eventSource.onmessage = (event) => {
            if (!mountedRef.current) return;
            try {
                const parsed = JSON.parse(event.data) as {
                    type?: string;
                    data?: unknown;
                    error?: unknown;
                    message?: unknown;
                };
                handleTerminalStreamEvent(parsed, 'sse');
            } catch (err) {
                logTerminalWarning('Terminal stream emitted malformed JSON', 'terminal_stream_malformed_message', err);
            }
        };
        eventSource.onerror = () => {
            if (!mountedRef.current || eventSourceRef.current !== eventSource) return;
            eventSource.close();
            eventSourceRef.current = null;
            if (streamRetryUsedRef.current) {
                setConnState('error');
                setErrMsg('Connection lost.');
                term.writeln('\r\n\x1b[33m  [!] Connection lost. Reconnect to restore the terminal.\x1b[0m\r\n');
                logTerminalWarning('Terminal SSE stream failed after one retry', 'terminal_sse_retry_exhausted');
                return;
            }
            streamRetryUsedRef.current = true;
            setConnState('connecting');
            setErrMsg(null);
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
            }
            reconnectTimerRef.current = setTimeout(() => {
                reconnectTimerRef.current = null;
                if (!mountedRef.current) return;
                if (sessionKeyRef.current !== sessionKey || sessionTokenRef.current !== sessionToken) return;
                openEventStream(sessionKey, sessionToken, { includeScrollback: false, isRetry: true });
            }, SSE_RETRY_DELAY_MS);
        };
    }, [
        apiBase,
        closeEventStream,
        handleTerminalStreamEvent,
        focusTerminal,
        logTerminalWarning,
        scheduleResize,
    ]);
    const openWebSocket = useCallback((rawWebSocketUrl: string, options: { includeScrollback?: boolean; isRetry?: boolean } = {}) => {
        const term = termRef.current;
        if (!term) return false;
        const gatewayWebSocketUrl = withIncludeScrollback(
            rawWebSocketUrl,
            options.includeScrollback ?? !options.isRetry,
        );
        if (!gatewayWebSocketUrl) {
            logTerminalWarning('Terminal websocket url was invalid', 'terminal_websocket_invalid_url');
            return false;
        }
        closeEventStream();
        closeWebSocket();
        if (!options.isRetry) {
            streamRetryUsedRef.current = false;
        }
        gatewayWebSocketUrlRef.current = gatewayWebSocketUrl;
        const socket = new WebSocket(gatewayWebSocketUrl);
        webSocketRef.current = socket;
        socket.onopen = () => {
            if (!mountedRef.current || webSocketRef.current !== socket) return;
            streamRetryUsedRef.current = false;
            setConnState('connected');
            setErrMsg(null);
            term.writeln(options.isRetry ? '\r\n\x1b[32m  [+] Reconnected\x1b[0m\r\n' : '\x1b[32m  [+] Connected\x1b[0m\r\n');
            if (isActiveRef.current) {
                scheduleResize();
                focusTerminal();
            }
        };
        socket.onmessage = (event) => {
            if (!mountedRef.current || typeof event.data !== 'string') return;
            try {
                handleTerminalStreamEvent(JSON.parse(event.data), 'websocket');
            } catch (err) {
                logTerminalWarning('Terminal websocket emitted malformed JSON', 'terminal_websocket_malformed_message', err);
            }
        };
        socket.onerror = () => {
            socket.close();
        };
        socket.onclose = () => {
            if (!mountedRef.current || webSocketRef.current !== socket) return;
            webSocketRef.current = null;
            if (!sessionKeyRef.current || !sessionTokenRef.current) return;
            if (streamRetryUsedRef.current) {
                setConnState('error');
                setErrMsg('Connection lost.');
                term.writeln('\r\n\x1b[33m  [!] Connection lost. Reconnect to restore the terminal.\x1b[0m\r\n');
                logTerminalWarning('Terminal websocket failed after one retry', 'terminal_websocket_retry_exhausted');
                return;
            }
            streamRetryUsedRef.current = true;
            setConnState('connecting');
            setErrMsg(null);
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
            }
            reconnectTimerRef.current = setTimeout(() => {
                reconnectTimerRef.current = null;
                if (!mountedRef.current || !gatewayWebSocketUrlRef.current) return;
                openWebSocket(gatewayWebSocketUrlRef.current, { includeScrollback: false, isRetry: true });
            }, SSE_RETRY_DELAY_MS);
        };
        return true;
    }, [closeEventStream, closeWebSocket, focusTerminal, handleTerminalStreamEvent, logTerminalWarning, scheduleResize]);
    const connect = useCallback(async () => {
        const term = termRef.current;
        if (!term) return;
        closeEventStream();
        closeWebSocket();
        streamRetryUsedRef.current = false;
        setConnState('connecting');
        setErrMsg(null);
        try {
            const persistedSession = readPersistedSession();
            if (persistedSession) {
                sessionKeyRef.current = persistedSession.sessionKey;
                sessionTokenRef.current = persistedSession.sessionToken;
                term.writeln('\x1b[90m  > Restoring previous Hermes TUI session...\x1b[0m');
                if (persistedSession.gatewayWebSocketUrl && openWebSocket(persistedSession.gatewayWebSocketUrl, {
                    includeScrollback: false,
                })) {
                    return;
                }
                openEventStream(persistedSession.sessionKey, persistedSession.sessionToken, {
                    includeScrollback: false,
                });
                return;
            }
            const cols = term.cols || 80;
            const rows = term.rows || 24;
            const result = await postAction({ action: 'start', cols, rows, mode: sessionMode });
            if (!mountedRef.current) return;
            if (!result?.ok || typeof result.sessionKey !== 'string' || typeof result.sessionToken !== 'string') {
                const message = typeof result?.error === 'string' ? result.error : 'Failed to start terminal session.';
                setConnState('error');
                setErrMsg(message);
                term.writeln(`\r\n\x1b[31m  [!] Error: ${message}\x1b[0m\r\n`);
                return;
            }
            sessionKeyRef.current = result.sessionKey;
            sessionTokenRef.current = result.sessionToken;
            gatewayWebSocketUrlRef.current =
                typeof result.gatewayWebSocketUrl === 'string' ? result.gatewayWebSocketUrl : null;
            persistSession(result.sessionKey, result.sessionToken, gatewayWebSocketUrlRef.current);
            if (gatewayWebSocketUrlRef.current && openWebSocket(gatewayWebSocketUrlRef.current)) {
                return;
            }
            openEventStream(result.sessionKey, result.sessionToken);
        } catch (err) {
            if (!mountedRef.current) return;
            const message = err instanceof Error ? err.message : String(err);
            setConnState('error');
            setErrMsg(message);
            term.writeln(`\r\n\x1b[31m  [!] Connect Error: ${message}\x1b[0m\r\n`);
            logTerminalWarning('Terminal connect failed', 'terminal_connect_failed', err);
        }
    }, [
        closeWebSocket,
        closeEventStream,
        logTerminalWarning,
        openEventStream,
        openWebSocket,
        persistSession,
        postAction,
        readPersistedSession,
        sessionMode,
    ]);
    const scheduleConnect = useCallback(() => {
        if (connectTimerRef.current) {
            clearTimeout(connectTimerRef.current);
        }
        connectTimerRef.current = setTimeout(() => {
            connectTimerRef.current = null;
            void connect();
        }, 50);
    }, [connect]);
    useEffect(() => {
        if (!isActive || !containerRef.current || termRef.current) return undefined;
        let cancelled = false;
        void (async () => {
            const { Terminal } = await import('@xterm/xterm');
            const { FitAddon } = await import('@xterm/addon-fit');
            await import('@xterm/xterm/css/xterm.css');
            if (cancelled || !containerRef.current) return;
            const term = new Terminal({
                theme: tuiTheme.terminal.xterm,
                fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "Courier New", monospace',
                fontSize: 13,
                lineHeight: 1.55,
                letterSpacing: 0,
                cursorBlink: true,
                cursorStyle: 'block',
                allowTransparency: false,
                scrollback: 20000,
                convertEol: sessionMode !== 'tui',
            });
            const fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.open(containerRef.current);
            termRef.current = term;
            fitRef.current = fitAddon;
            term.onResize(({ cols, rows }) => {
                sendResize(cols, rows);
            });
            term.onData((data) => {
                recordTerminalRttInput(data);
                sendInput(data);
            });
            focusTerminal();
            fitTerminal();
            setConnState('connecting');
            scheduleConnect();
        })();
        return () => {
            cancelled = true;
        };
    }, [fitTerminal, focusTerminal, isActive, recordTerminalRttInput, scheduleConnect, sendInput, sendResize, sessionMode, tuiTheme]);
    useEffect(() => {
        const term = termRef.current;
        if (!term || !term.options) return;
        term.options.theme = tuiTheme.terminal.xterm;
        if (typeof (term as { refresh?: (start: number, end: number) => void }).refresh === 'function') {
            (term as { refresh: (start: number, end: number) => void }).refresh(0, Math.max(term.rows - 1, 0));
        }
    }, [tuiTheme]);
    useEffect(() => {
        if (!isActive || !termRef.current) return;
        scheduleResize();
        focusTerminal();
    }, [focusTerminal, isActive, scheduleResize]);
    useEffect(() => {
        if (!containerRef.current || !fitRef.current) return undefined;
        const observer = new ResizeObserver(() => {
            scheduleResize();
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [connState, scheduleResize]);
    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const handleViewportResize = () => {
            scheduleResize();
        };
        window.addEventListener('resize', handleViewportResize);
        window.visualViewport?.addEventListener('resize', handleViewportResize);
        return () => {
            window.removeEventListener('resize', handleViewportResize);
            window.visualViewport?.removeEventListener('resize', handleViewportResize);
        };
    }, [scheduleResize]);
    useEffect(() => {
        if (typeof document === 'undefined' || !('fonts' in document)) return undefined;
        let cancelled = false;
        document.fonts.ready
            .then(() => {
                if (!cancelled) scheduleResize();
            })
            .catch(() => {
                // Font readiness is best-effort; the resize observer still covers layout changes.
            });
        return () => {
            cancelled = true;
        };
    }, [scheduleResize]);
    useEffect(() => {
        return () => {
            if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
            if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
            closeEventStream();
            closeWebSocket();
            const sessionKey = sessionKeyRef.current;
            const sessionToken = sessionTokenRef.current;
            if (sessionKey && sessionToken && !persistSessionForSurface) {
                void fetch(apiBase, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'stop',
                        mode: sessionMode,
                        sessionKey,
                        sessionToken,
                    }),
                    keepalive: true,
                }).catch((err) => {
                    logTerminalWarning('Terminal stop request failed during cleanup', 'terminal_stop_cleanup_failed', err);
                });
            }
            sessionKeyRef.current = null;
            sessionTokenRef.current = null;
            gatewayWebSocketUrlRef.current = null;
            termRef.current?.dispose();
            termRef.current = null;
            fitRef.current = null;
        };
    }, [apiBase, closeEventStream, closeWebSocket, logTerminalWarning, persistSessionForSurface, sessionMode]);
    const handleReconnect = useCallback(() => {
        if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
        }
        closeEventStream();
        closeWebSocket();
        clearPersistedSession();
        sessionKeyRef.current = null;
        sessionTokenRef.current = null;
        gatewayWebSocketUrlRef.current = null;
        streamRetryUsedRef.current = false;
        setErrMsg(null);
        setConnState('connecting');
        termRef.current?.writeln('\r\n\x1b[90m  -- reconnecting --\x1b[0m\r\n');
        scheduleConnect();
    }, [clearPersistedSession, closeEventStream, closeWebSocket, scheduleConnect]);
    const handleClearTerminal = useCallback(() => {
        termRef.current?.clear();
        focusTerminal();
    }, [focusTerminal]);
    const handleCopyTerminalOutput = useCallback(() => {
        const buffer = termRef.current?.buffer.active;
        if (!buffer || typeof navigator === 'undefined' || !navigator.clipboard) return;
        const lines: string[] = [];
        for (let index = 0; index < buffer.length; index += 1) {
            const text = buffer.getLine(index)?.translateToString(true);
            if (text) lines.push(text);
        }
        void navigator.clipboard.writeText(lines.join('\n').trimEnd()).catch((err) => {
            logTerminalWarning('Terminal output copy failed', 'terminal_output_copy_failed', err);
        });
        focusTerminal();
    }, [focusTerminal, logTerminalWarning]);
    const handleRestartTerminal = useCallback(() => {
        const sessionKey = sessionKeyRef.current;
        const sessionToken = sessionTokenRef.current;
        closeEventStream();
        closeWebSocket();
        clearPersistedSession();
        sessionKeyRef.current = null;
        sessionTokenRef.current = null;
        gatewayWebSocketUrlRef.current = null;
        streamRetryUsedRef.current = false;
        setErrMsg(null);
        setConnState('connecting');
        termRef.current?.reset();
        void (async () => {
            if (sessionKey && sessionToken) {
                try {
                    await postAction({
                        action: 'stop',
                        mode: sessionMode,
                        sessionKey,
                        sessionToken,
                    });
                } catch (err) {
                    logTerminalWarning('Terminal restart stop request failed', 'terminal_restart_stop_failed', err);
                }
            }
            scheduleConnect();
        })();
    }, [clearPersistedSession, closeEventStream, closeWebSocket, logTerminalWarning, postAction, scheduleConnect, sessionMode]);
    const statusColor: Record<ConnState, string> = {
        init: tuiTheme.status.init, connecting: tuiTheme.status.connecting, connected: tuiTheme.status.connected,
        error: tuiTheme.status.error, closed: tuiTheme.status.closed,
    };
    const statusLabel: Record<ConnState, string> = {
        init: 'Starting', connecting: 'Connecting', connected: 'Online', error: 'Needs attention', closed: 'Closed',
    };
    const statusDetail: Record<ConnState, string> = {
        init: 'Preparing session',
        connecting: 'Opening secure session',
        connected: sessionMode === 'tui' ? 'Hermes TUI is ready' : 'Shell is ready',
        error: errMsg ?? 'Terminal connection failed',
        closed: errMsg ?? 'Session closed',
    };
    const sessionLabel = sessionMode === 'tui' ? 'Hermes TUI' : 'SSH shell';
    const shortInstanceId = instanceId.slice(0, 8);
    const isLight = resolvedColorMode === 'light';
    const statusIsError = connState === 'error';
    const terminalActions = [
        { label: 'Clear', icon: Eraser, onClick: handleClearTerminal },
        { label: 'Copy output', icon: Clipboard, onClick: handleCopyTerminalOutput },
        { label: 'Restart', icon: RotateCcw, onClick: handleRestartTerminal },
    ];
    const chromeVars = {
        '--terminal-panel-bg': isLight ? '#f7f2ea' : '#050711',
        '--terminal-header-bg': isLight ? 'rgba(255, 251, 244, 0.86)' : 'rgba(9, 12, 22, 0.92)',
        '--terminal-border': isLight ? 'rgba(58, 45, 31, 0.12)' : 'rgba(150, 166, 190, 0.12)',
        '--terminal-header-text': tuiTheme.terminal.headerText,
        '--terminal-muted-text': tuiTheme.terminal.headerMutedText,
        '--terminal-accent-border': isLight ? 'rgba(15, 118, 110, 0.2)' : 'rgba(45, 212, 191, 0.2)',
        '--terminal-accent-bg': isLight ? 'rgba(15, 118, 110, 0.08)' : 'rgba(45, 212, 191, 0.08)',
        '--terminal-status-color': statusColor[connState],
        '--terminal-status-border': statusIsError ? 'rgba(248, 113, 113, 0.28)' : isLight ? 'rgba(15, 118, 110, 0.18)' : 'rgba(45, 212, 191, 0.18)',
        '--terminal-status-bg': statusIsError ? 'rgba(248, 113, 113, 0.08)' : isLight ? 'rgba(15, 118, 110, 0.08)' : 'rgba(45, 212, 191, 0.08)',
        '--terminal-button-border': isLight ? 'rgba(58, 45, 31, 0.12)' : 'rgba(148, 163, 184, 0.12)',
        '--terminal-button-bg': isLight ? 'rgba(255, 251, 244, 0.72)' : 'rgba(148, 163, 184, 0.06)',
        '--terminal-reconnect-bg': tuiTheme.terminal.reconnectBackground,
        '--terminal-reconnect-hover': tuiTheme.terminal.reconnectBackgroundHover,
        '--terminal-reconnect-border': tuiTheme.terminal.reconnectBorder,
        '--terminal-reconnect-text': tuiTheme.terminal.reconnectText,
        '--terminal-xterm-bg': tuiTheme.terminal.xterm.background,
    } as CSSProperties;
    return (
        <div className={styles.panel} style={chromeVars} data-color-mode={resolvedColorMode}>
            <div className={styles.header}>
                <div className={styles.identity}>
                    <span className={styles.iconBox}>
                        <TerminalIcon size={15} />
                    </span>
                    <div className={styles.identityText}>
                        <div className={styles.titleRow}>
                            <span className={styles.title}>{sessionLabel}</span>
                            <span className={styles.instanceId}>{shortInstanceId}</span>
                        </div>
                        <span className={`${styles.detail} ${statusIsError ? styles.detailError : ''}`}>
                            {statusDetail[connState]}
                        </span>
                    </div>
                </div>
                <div className={styles.actions}>
                    {terminalActions.map((action) => {
                        const Icon = action.icon;
                        return (
                            <button
                                key={action.label}
                                type="button"
                                aria-label={action.label}
                                title={action.label}
                                onClick={action.onClick}
                                className={styles.iconButton}
                            >
                                <Icon size={13} />
                            </button>
                        );
                    })}
                    <span className={styles.statusPill}>
                        <span className={styles.statusDot} />
                        {statusLabel[connState]}
                        {connState === 'connecting' && <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />}
                        {connState === 'connected' && <Wifi size={11} style={{ opacity: 0.78 }} />}
                        {connState === 'error' && <AlertTriangle size={11} />}
                    </span>
                    {(connState === 'error' || connState === 'closed') && (
                        <button
                            onClick={handleReconnect}
                            title="Reconnect"
                            className={styles.reconnectButton}
                        >
                            <RefreshCw size={12} />
                            Reconnect
                        </button>
                    )}
                </div>
            </div>
            <div
                ref={containerRef}
                id={terminalSurfaceId}
                onPointerDownCapture={focusTerminal}
                className={styles.viewport}
            />
        </div>
    );
}
