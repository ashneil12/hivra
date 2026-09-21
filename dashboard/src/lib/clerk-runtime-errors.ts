export function toError(input: unknown, fallbackTitle: string): Error {
  if (input instanceof Error) return input;
  if (typeof input === 'string' && input.trim()) return new Error(input);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const rawMessage = typeof record.message === 'string' ? record.message.trim() : '';
    const hasCode =
      (typeof record.code === 'number' && Number.isFinite(record.code)) ||
      (typeof record.code === 'string' && record.code.trim());
    const rawName = typeof record.name === 'string' ? record.name.trim() : '';

    if (rawMessage || hasCode) {
      const error = new Error(
        rawMessage || (hasCode ? `JSON-RPC error ${String(record.code)}` : fallbackTitle),
      );

      if (rawName) {
        error.name = rawName;
      }
      if (Object.prototype.hasOwnProperty.call(record, 'code')) {
        (error as Error & { code?: unknown }).code = record.code;
      }

      return error;
    }

    try {
      const serialized = JSON.stringify(input);
      if (serialized && serialized !== '{}') {
        const error = new Error(serialized);
        if (rawName) error.name = rawName;
        return error;
      }
    } catch {
      // Fall back below if the value is not serializable.
    }
  }

  try {
    const serialized = JSON.stringify(input);
    if (serialized && serialized !== '{}') return new Error(serialized);
  } catch {
    // Fall back below if the value is not serializable.
  }

  return new Error(fallbackTitle);
}

export function extractRawErrorMetadata(input: unknown): Record<string, unknown> {
  if (input instanceof Error) {
    const metadata: Record<string, unknown> = {
      rawErrorType: 'error',
      rawErrorName: input.name,
      rawErrorMessage: input.message,
    };

    const diagnosticFields = [
      'apiEndpoint',
      'requestId',
      'responseStatus',
      'rawBodySnippet',
      'streamRoute',
      'upstreamUrl',
      'userFacingMessage',
      'rawErrorCode',
      'rawErrorMethod',
      'walletProvider',
      'chainId',
    ];

    for (const field of diagnosticFields) {
      const value = (input as Error & Record<string, unknown>)[field];
      if (value !== undefined && value !== null && value !== '') {
        metadata[field] = value;
      }
    }

    return metadata;
  }

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const metadata: Record<string, unknown> = {
      rawErrorType: 'object',
      rawErrorKeys: Object.keys(record).slice(0, 20),
    };

    if (Object.prototype.hasOwnProperty.call(record, 'code')) {
      metadata.rawErrorCode = record.code;
    }
    if (typeof record.message === 'string') {
      metadata.rawErrorMessage = record.message;
    }
    if (typeof record.method === 'string') {
      metadata.rawErrorMethod = record.method;
    }

    return metadata;
  }

  return {
    rawErrorType: typeof input,
    rawErrorValue: typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean'
      ? input
      : undefined,
  };
}

export function containsBrowserExtensionOrigin(value: string): boolean {
  return /(?:chrome|moz|edge|safari|safari-web)-extension:\/\//i.test(value);
}

// Error messages emitted by browser-extension content scripts that run in the
// page context, so their stacks do not always reference an extension origin.
// Every entry must be a narrow extension-only signature — never add anything a
// first-party error could legitimately produce.
const EXTENSION_MESSAGE_SIGNATURES = [
  // Chrome extension messaging bridge losing its tab ("Invalid call to
  // runtime.sendMessage(). Tab not found." and variants).
  'Invalid call to runtime.sendMessage()',
  // Binance Wallet extension's injected SSE content-script bridge.
  'func sseError not found',
];

function matchesExtensionMessageSignature(value: string): boolean {
  return EXTENSION_MESSAGE_SIGNATURES.some((signature) => value.includes(signature));
}

// Known zero-signal noise that reaches window.onerror without an extension://
// frame in the stack: extension/in-app-browser injected bridges. Same
// narrowness rule as EXTENSION_MESSAGE_SIGNATURES — never add anything a
// first-party error could legitimately produce.
const KNOWN_CLIENT_NOISE_PATTERNS: RegExp[] = [
  // iOS Firefox injected bridge.
  /__firefox__/,
  // Legacy extension content-script callback noise.
  /^Object Not Found Matching Id:\d+, MethodName:/,
  // Chrome-on-iOS injected bridge.
  /__gCrWeb/,
];

function matchesKnownClientNoise(value: string): boolean {
  if (!value) return false;
  return KNOWN_CLIENT_NOISE_PATTERNS.some((pattern) => pattern.test(value));
}

function isGenericCrossOriginScriptError(value: string): boolean {
  return /^script error\.?$/i.test(value.trim());
}

function isMeaninglessNativeEventPayload(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    return keys.length === 1 && parsed.isTrusted === true;
  } catch {
    return false;
  }
}

export function shouldIgnoreClientError(error: Error): boolean {
  if (error.name === 'AbortError') return true;

  const message = error.message || '';
  const stack = error.stack || '';
  return (
    isMeaninglessNativeEventPayload(message) ||
    isGenericCrossOriginScriptError(message) ||
    matchesExtensionMessageSignature(message) ||
    containsBrowserExtensionOrigin(message) ||
    containsBrowserExtensionOrigin(stack) ||
    matchesKnownClientNoise(message) ||
    matchesKnownClientNoise(stack)
  );
}

export function isClerkSessionTouchNetworkError(error: Error): boolean {
  const message = error.message || '';
  return (
    message.includes('ClerkJS: Network error at') &&
    message.includes('/v1/client/sessions/') &&
    message.includes('/touch')
  );
}

const CLERK_ASSET_LOAD_ERROR_PATTERNS = [
  'failed to load clerk js sdk',
  'chunkloaderror',
  'loading chunk',
  'loading css chunk',
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
];

export function isClerkAssetLoadError(error: Error): boolean {
  const haystack = `${error.name} ${error.message}`.toLowerCase();
  const mentionsClerkRuntime =
    haystack.includes('clerkjs') ||
    haystack.includes('clerk js sdk') ||
    haystack.includes('@clerk/clerk-js') ||
    haystack.includes('@clerk/ui') ||
    haystack.includes('clerk.browser.js') ||
    haystack.includes('ui.browser.js') ||
    haystack.includes('clerk.hermesos.cloud');
  const matchesAssetLoadPattern = CLERK_ASSET_LOAD_ERROR_PATTERNS.some((pattern) =>
    haystack.includes(pattern)
  );

  return mentionsClerkRuntime && matchesAssetLoadPattern;
}

// One-shot reload policy for transient Clerk chunk/asset load failures.
//
// When the third-party Clerk UI CDN chunk (@clerk/ui) fails to load — a
// transient CDN-edge or stale-service-worker failure, not user error — the auth
// surface reloads the route ONCE to recover instead of leaving a broken/blank
// sign-in screen. The retry MUST be guarded so it fires at most once: an
// unguarded reload-on-chunk-error loops forever when the CDN is genuinely down.
// We persist the attempt in sessionStorage so the flag survives the reload
// itself; if the chunk still fails on the retried page the flag is already set,
// this policy declines, and the caller falls back to the graceful
// AuthRuntimeNotice instead of reloading again.
export const CLERK_CHUNK_RETRY_STORAGE_KEY = 'hermes:clerk-chunk-retry';

// The minimal slice of the Storage interface this policy depends on, so it
// stays unit-testable in the node test environment without a real
// sessionStorage (and so a missing/blocked store is an explicit input).
export interface ClerkChunkRetryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function shouldRetryClerkChunkLoad(
  store: ClerkChunkRetryStore | null | undefined,
): boolean {
  // No usable storage means we cannot guarantee the one-shot guard survives a
  // reload — decline so the caller shows the notice rather than risking a loop.
  if (!store) return false;

  try {
    if (store.getItem(CLERK_CHUNK_RETRY_STORAGE_KEY)) return false;
    store.setItem(CLERK_CHUNK_RETRY_STORAGE_KEY, '1');
    return true;
  } catch {
    // sessionStorage access can throw (private-mode quota, disabled storage).
    // If we cannot record the attempt, do NOT reload — an unrecorded retry
    // would loop on every chunk error.
    return false;
  }
}
