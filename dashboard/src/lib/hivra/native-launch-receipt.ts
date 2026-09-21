"use client";

export const NATIVE_LAUNCH_RECEIPT_STORAGE_KEY = "hivra.native-launch-receipt.v1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StoredNativeLaunchReceipt = {
  ownerScope: string;
  intentKey: string;
  requestId: string;
};

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function read(target: Storage, ownerScope: string, intentKey: string): StoredNativeLaunchReceipt | null {
  try {
    const raw = target.getItem(NATIVE_LAUNCH_RECEIPT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredNativeLaunchReceipt>;
    return value.ownerScope === ownerScope
      && value.intentKey === intentKey
      && typeof value.requestId === "string"
      && UUID.test(value.requestId)
      ? { ownerScope, intentKey, requestId: value.requestId.toLowerCase() }
      : null;
  } catch {
    return null;
  }
}

/**
 * Keep one non-secret, owner-and-intent-bound request ID through refresh and an
 * uncertain HTTP acknowledgement. The caller deliberately supplies only the
 * effective non-secret launch fields in intentKey.
 */
export function nativeLaunchRequestId(ownerScope: string, intentKey: string): string {
  if (!ownerScope || ownerScope.length > 256 || !intentKey || intentKey.length > 4096) {
    throw new Error("Native launch receipt scope is invalid.");
  }
  const target = sessionStorageOrNull();
  const saved = target ? read(target, ownerScope, intentKey) : null;
  if (saved) return saved.requestId;

  const requestId = newRequestId();
  if (target) {
    try {
      target.setItem(NATIVE_LAUNCH_RECEIPT_STORAGE_KEY, JSON.stringify({
        ownerScope,
        intentKey,
        requestId,
      } satisfies StoredNativeLaunchReceipt));
    } catch {
      // The request still remains stable for the current submit call. The
      // receipt-backed primary launch flow uses its own persisted draft.
    }
  }
  return requestId;
}

export function clearNativeLaunchRequestId(ownerScope: string, requestId: string): void {
  const target = sessionStorageOrNull();
  if (!target) return;
  try {
    const raw = target.getItem(NATIVE_LAUNCH_RECEIPT_STORAGE_KEY);
    if (!raw) return;
    const value = JSON.parse(raw) as Partial<StoredNativeLaunchReceipt>;
    if (value.ownerScope === ownerScope && value.requestId === requestId) {
      target.removeItem(NATIVE_LAUNCH_RECEIPT_STORAGE_KEY);
    }
  } catch {
    // Storage cleanup is best-effort after a confirmed acceptance.
  }
}
