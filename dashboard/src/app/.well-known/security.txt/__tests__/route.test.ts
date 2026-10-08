import { GET } from "../route";
import {
  GITHUB_PRIVATE_REPORT_URL,
  SECURITY_EMAIL,
  SECURITY_TXT_EXPIRES,
  buildSecurityTxt,
} from "@/lib/security-contact";
import { SITE_URL } from "@/lib/seo-urls";

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("GET /.well-known/security.txt", () => {
  it("returns 200 text/plain in a cacheable response", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("s-maxage=3600");
    expect(await response.text()).toBe(buildSecurityTxt(SITE_URL));
  });

  it("has the RFC 9116 fields: Contact, a future Expires under a year out, and Canonical and Policy on hivra.cloud", async () => {
    const body = await GET().text();
    const lines = body.split("\n").filter((line) => line && !line.startsWith("#"));
    const field = (name: string) => lines.filter((line) => line.startsWith(`${name}: `)).map((line) => line.slice(name.length + 2));

    expect(field("Contact")).toEqual([`mailto:${SECURITY_EMAIL}`, GITHUB_PRIVATE_REPORT_URL]);
    expect(field("Canonical")).toEqual(["https://hivra.cloud/.well-known/security.txt"]);
    expect(field("Policy")).toEqual(["https://hivra.cloud/security"]);
    expect(field("Preferred-Languages")).toEqual(["en"]);
    expect(field("Expires")).toEqual([SECURITY_TXT_EXPIRES]);
    // Plain LF text with one trailing newline and no other addresses.
    expect(body.endsWith("\n")).toBe(true);
    expect(body).not.toContain("\r");
    expect([...new Set(body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g))]).toEqual([SECURITY_EMAIL]);
  });

  it("expires in the future and less than a year ahead: renew SECURITY_TXT_EXPIRES before it lapses", () => {
    // This test fails on purpose once the date passes, so the file cannot go
    // stale unnoticed (RFC 9116 treats an expired file as stale).
    const expires = new Date(SECURITY_TXT_EXPIRES).getTime();
    const now = Date.now();
    expect(Number.isNaN(expires)).toBe(false);
    expect(expires).toBeGreaterThan(now);
    expect(expires - now).toBeLessThanOrEqual(366 * 24 * 60 * 60 * 1000);
    expect(SECURITY_TXT_EXPIRES).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("is not served from a self-hosted installation, whose security contact is the operator's", async () => {
    process.env.HIVRA_AUTH_MODE = "local";
    const response = GET();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(SECURITY_EMAIL);
  });
});
