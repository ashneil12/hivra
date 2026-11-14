import { Agent } from "undici";

/**
 * Legacy gateway fetch wrapper.
 *
 * TLS verification is enabled unconditionally unless the operator explicitly
 * opts in to insecure mode with `ALLOW_INSECURE_GATEWAY_TLS=true`. That is a
 * break-glass escape hatch for boxes whose ACME issuance is permanently
 * broken — nothing else should need it. Managed `<ip>.sslip.io` gateways get
 * real Let's Encrypt certs from their Caddy site label, so they verify like
 * any other host; an sslip box that fails verification is unreachable either
 * way during issuance, and a permanently unverifiable one is broken, not
 * something to silently MITM-proxy forever.
 */
function shouldAllowInsecureGatewayTls(): boolean {
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
    !shouldAllowInsecureGatewayTls()
  ) {
    return fetch(url, options);
  }

  return fetch(url, {
    ...(options as RequestInitWithDispatcher),
    dispatcher:
      (options as RequestInitWithDispatcher).dispatcher ?? insecureAgent,
  } as RequestInitWithDispatcher);
}
