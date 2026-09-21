import "server-only";

import { z } from "zod";

const Uuid = z.string().uuid();
function canonicalHostname(value: string) {
  return value.length <= 253 && value.includes(".") && /^[a-z]{2,63}$/.test(value.split(".").at(-1)!)
    && value.split(".").every(label => !label.startsWith("xn--") && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
const Hostname = z.string().refine(canonicalHostname);
const Origin = z.string().refine(value => value.startsWith("https://") && canonicalHostname(value.slice(8)));
const DirectHostname = z.string().regex(/^(?:[0-9]{1,3}-){3}[0-9]{1,3}\.sslip\.io$/).refine(value =>
  value.slice(0, -".sslip.io".length).split("-").every(octet => Number(octet) <= 255 && String(Number(octet)) === octet));
const Access = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("cloudflare-named"), hostname: Hostname, tunnelId: Uuid }).strict(),
  z.object({ mode: z.literal("direct-https"), hostname: DirectHostname, tunnelId: z.null() }).strict(),
]);
const Authority = z.object({ computerId: Uuid, controlOrigin: Origin, access: Access }).strict();
export type ProviderDesktopLaunchAuthority = z.infer<typeof Authority>;
export type ProviderDesktopAccess = z.infer<typeof Access>;
export function parseProviderDesktopControlOrigin(input: unknown): string {
  try { return Origin.parse(input); }
  catch { throw new Error("Provider desktop control origin could not be verified"); }
}
export function parseProviderDesktopAccess(input: unknown): ProviderDesktopAccess {
  try { return Access.parse(input); }
  catch { throw new Error("Provider desktop access binding could not be verified"); }
}

const Launch = z.object({
  version: z.literal(3), computerSubstrate: z.literal("provider-vm"), agentKind: z.literal("linux-desktop"),
  computerId: Uuid, controlOrigin: Origin, publicOrigin: Origin,
  wantBrowser: z.null(), modelKey: z.literal(""), modelBaseUrl: z.literal(""), model: z.literal(""),
  tunnelToken: z.string().regex(/^[A-Za-z0-9._=-]{1,8192}$/).nullable(),
  accessHostname: DirectHostname.nullable(),
}).strict();
export type ProviderDesktopLaunch = z.infer<typeof Launch>;

/** Staged payload contract, NOT dispatch or admission authority. The caller must
 * supply the original reserved computer, canonical browser/control origin and
 * journaled access record from the server, never from the launch request.
 *
 * A dedicated desktop worker identity and grant-bound cleanup are still required.
 * Neither legacy v1 nor DeepSeek v2 may execute this payload. Public launch stays
 * closed until those fences and provider capability/session acceptance exist.
 *
 * No deployment-protection bypass credential is accepted: an owner-root provider
 * VM must reach the authenticated callbacks at the same canonical browser origin.
 * A successful unauthenticated ingress probe is not session authorization.
 */
export function parseProviderDesktopLaunch(input: unknown, authority: ProviderDesktopLaunchAuthority): ProviderDesktopLaunch {
  try {
    const expected = Authority.parse(authority), launch = Launch.parse(input);
    if (launch.computerId !== expected.computerId || launch.controlOrigin !== expected.controlOrigin
      || launch.publicOrigin !== `https://${expected.access.hostname}`) throw new Error();
    if (expected.access.mode === "direct-https") {
      if (launch.tunnelToken !== null || launch.accessHostname !== expected.access.hostname) throw new Error();
    } else {
      if (launch.accessHostname !== null || launch.tunnelToken === null) throw new Error();
      const token = JSON.parse(Buffer.from(launch.tunnelToken, "base64").toString("utf8"));
      if (token === null || typeof token !== "object" || Array.isArray(token) || token.t !== expected.access.tunnelId) throw new Error();
    }
    return launch;
  } catch {
    // Do not expose Zod/parser diagnostics containing launch credentials.
    throw new Error("Provider desktop launch binding could not be verified");
  }
}
