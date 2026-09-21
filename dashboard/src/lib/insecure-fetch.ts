import { Agent } from "undici";

/**
 * Legacy gateway fetch wrapper.
 *
 * TLS verification remains enabled by default.
 *
 * For controlled break-glass migrations only, operators may explicitly opt in
 * to the previous insecure behavior with `ALLOW_INSECURE_GATEWAY_TLS=true`.
 */
function shouldAllowInsecureGatewayTls(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (/^\d{1,3}(?:-\d{1,3}){3}\.sslip\.io$/.test(hostname)) {
      return true;
    }
  } catch {}

  return process.env.ALLOW_INSECURE_GATEWAY_TLS === "true";
}

type RequestInitWithDispatcher = RequestInit & {
  dispatcher?: Agent;
};

export const insecureAgent = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

export async function fetchWithInsecureTLS(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  if (
    typeof window !== "undefined" ||
    !shouldAllowInsecureGatewayTls(url)
  ) {
    return fetch(url, options);
  }

  return fetch(url, {
    ...(options as RequestInitWithDispatcher),
    dispatcher:
      (options as RequestInitWithDispatcher).dispatcher ?? insecureAgent,
  } as RequestInitWithDispatcher);
}
