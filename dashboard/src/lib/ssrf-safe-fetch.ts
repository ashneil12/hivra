import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Agent } from "undici";
import { reservedAddressReason } from "@/lib/url-safety";

/**
 * SSRF-hardened fetch for probing user-supplied endpoints.
 *
 * `checkOutboundUrlSafety` rejects URLs whose host is a *literal* private IP,
 * but a hostname can still DNS-rebind to a private address between validation
 * and connection. This helper closes that gap by validating the resolved
 * address at *connect* time: it installs a custom `lookup` on the undici
 * connector that resolves the hostname, refuses the connection if ANY
 * resolved address is private/reserved, and otherwise hands undici exactly
 * the addresses it just validated — so the socket connects to a checked IP
 * with no time-of-check/time-of-use window.
 *
 * This reuses the DNS resolution undici/node would perform anyway; it does
 * not add an extra round-trip.
 */

class BlockedAddressError extends Error {
  constructor(hostname: string, address: string, reason: string) {
    super(`ssrf_blocked:${reason} (${hostname} -> ${address})`);
    this.name = "BlockedAddressError";
  }
}

// Matches node's net.LookupFunction callback exactly (address is required in
// the type even though net ignores it whenever `err` is set), so ssrfSafeLookup
// is assignable to undici's connect.lookup without a cast.
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * net/undici-compatible lookup that fails closed on any private/reserved
 * resolved address. Exported for unit testing.
 */
export function ssrfSafeLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    // On every error path, `address` is passed as [] — net/undici read `err`
    // first and ignore the address when it is set.
    if (err) {
      callback(err, []);
      return;
    }
    const list: LookupAddress[] = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0) {
      callback(
        Object.assign(new Error(`ssrf_blocked:no_address (${hostname})`), {
          code: "ENOTFOUND",
        }) as NodeJS.ErrnoException,
        [],
      );
      return;
    }
    for (const entry of list) {
      const reason = reservedAddressReason(entry.address);
      if (reason) {
        callback(new BlockedAddressError(hostname, entry.address, reason) as NodeJS.ErrnoException, []);
        return;
      }
    }
    if (options?.all) {
      callback(null, list);
      return;
    }
    callback(null, list[0].address, list[0].family);
  });
}

const ssrfSafeAgent = new Agent({
  connect: {
    // node's TcpNetConnectOpts.lookup — undici threads this to net.connect.
    lookup: ssrfSafeLookup,
  },
});

function directSslipAddress(hostname: string): string | null {
  const match = /^([0-9]{1,3})-([0-9]{1,3})-([0-9]{1,3})-([0-9]{1,3})\.sslip\.io$/.exec(hostname);
  if (!match) return null;
  const address = match.slice(1).map(Number).join(".");
  return match.slice(1).every((octet, index) => Number(octet) <= 255 && String(Number(octet)) === match[index + 1])
    && !reservedAddressReason(address) ? address : null;
}

/** Direct provider access never trusts public DNS for its sslip hostname. The
 * URL host remains unchanged for TLS SNI/Host verification, while connect is
 * pinned to the exact IPv4 encoded by the immutable access binding. */
export function directSslipSafeLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  const address = directSslipAddress(hostname);
  if (!address) {
    callback(Object.assign(new Error("direct_sslip_address_invalid"), { code: "ENOTFOUND" }) as NodeJS.ErrnoException, []);
    return;
  }
  if (options?.all) callback(null, [{ address, family: 4 }]);
  else callback(null, address, 4);
}

const directSslipSafeAgent = new Agent({ connect: { lookup: directSslipSafeLookup } });

type RequestInitWithDispatcher = RequestInit & { dispatcher?: Agent };

/**
 * Drop-in `fetch` that routes through {@link ssrfSafeAgent}. Use this anywhere
 * the dashboard fetches a user-supplied / agent-supplied URL. Pair it with a
 * `checkOutboundUrlSafety` pre-check for the cheap literal-IP rejection.
 */
export async function ssrfSafeFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...(options as RequestInitWithDispatcher),
    dispatcher: (options as RequestInitWithDispatcher).dispatcher ?? ssrfSafeAgent,
  } as RequestInitWithDispatcher);
}

export async function directSslipSafeFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const parsed = new URL(url);
  if (!directSslipAddress(parsed.hostname)) throw new Error("direct_sslip_address_invalid");
  return fetch(url, { ...(options as RequestInitWithDispatcher), dispatcher: directSslipSafeAgent } as RequestInitWithDispatcher);
}
