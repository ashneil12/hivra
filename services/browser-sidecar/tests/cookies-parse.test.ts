import { describe, expect, it } from "vitest";
import { parseCookies, CookieParseError, cookieHost } from "../src/cookies/parse.js";

describe("parseCookies", () => {
  it("parses Netscape cookies.txt (Get cookies.txt LOCALLY / yt-dlp)", () => {
    const txt = [
      "# Netscape HTTP Cookie File",
      "# comment line",
      "#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1893456000\tsession\tabc123",
      ".example.com\tTRUE\t/app\tFALSE\t0\tpref\tdark",
      "", // blank line ignored
    ].join("\n");
    const r = parseCookies(txt);
    expect(r.format).toBe("netscape");
    expect(r.domains).toEqual(["example.com"]);
    const session = r.cookies.find((c) => c.name === "session")!;
    expect(session).toMatchObject({
      value: "abc123",
      domain: ".example.com",
      path: "/",
      httpOnly: true,
      secure: true,
      expires: 1893456000,
    });
    // expiry 0 => session cookie, no `expires`
    expect(r.cookies.find((c) => c.name === "pref")!.expires).toBeUndefined();
  });

  it("parses Cookie-Editor JSON (expirationDate seconds, sameSite no_restriction)", () => {
    const json = JSON.stringify([
      {
        name: "auth",
        value: "tok",
        domain: ".site.com",
        path: "/",
        expirationDate: 1893456000.7,
        httpOnly: true,
        secure: true,
        sameSite: "no_restriction",
      },
    ]);
    const r = parseCookies(json);
    expect(r.format).toBe("cookie-editor-json");
    expect(r.cookies[0]).toMatchObject({
      name: "auth",
      domain: ".site.com",
      expires: 1893456000,
      sameSite: "None",
      secure: true, // forced secure because sameSite None
    });
  });

  it("parses Playwright storageState ({cookies,origins})", () => {
    const json = JSON.stringify({
      cookies: [{ name: "sid", value: "x", domain: "app.io", path: "/", sameSite: "Lax" }],
      origins: [],
    });
    const r = parseCookies(json);
    expect(r.format).toBe("storage-state");
    expect(r.cookies[0]).toMatchObject({ name: "sid", domain: "app.io", sameSite: "Lax" });
  });

  it("forces secure when sameSite is None (else the browser drops it)", () => {
    const r = parseCookies(JSON.stringify([{ name: "a", value: "b", domain: "x.com", sameSite: "no_restriction", secure: false }]));
    expect(r.cookies[0].secure).toBe(true);
  });

  it("converts expirationDate given in milliseconds to seconds", () => {
    const r = parseCookies(JSON.stringify([{ name: "a", value: "b", domain: "x.com", expirationDate: 1893456000000 }]));
    expect(r.cookies[0].expires).toBe(1893456000);
  });

  it("throws on empty / invalid / no-cookie input", () => {
    expect(() => parseCookies("")).toThrow(CookieParseError);
    expect(() => parseCookies("{not json")).toThrow(CookieParseError);
    expect(() => parseCookies(JSON.stringify([{ nope: 1 }]))).toThrow(/no valid cookies/);
    expect(() => parseCookies("# only a comment\n")).toThrow(/no valid cookies/);
  });

  it("__Host- cookies become host-only (url, no domain, secure, path /)", () => {
    // Netscape always carries a domain; a __Host- cookie WITH a Domain attribute
    // is rejected by Chromium and (because addCookies is atomic) sinks the whole
    // batch. We must address it by url instead.
    const txt = "#HttpOnly_mail.google.com\tFALSE\t/\tTRUE\t1893456000\t__Host-GAPS\tsecret";
    const r = parseCookies(txt);
    const c = r.cookies.find((x) => x.name === "__Host-GAPS")!;
    expect(c.url).toBe("https://mail.google.com/");
    expect(c.domain).toBeUndefined();
    expect(c.secure).toBe(true);
    expect(cookieHost(c)).toBe("mail.google.com");
    expect(r.domains).toContain("mail.google.com");
  });

  it("__Secure- cookies are forced secure (even if exported as not-secure)", () => {
    const r = parseCookies(
      JSON.stringify([{ name: "__Secure-1PSID", value: "v", domain: ".google.com", secure: false }]),
    );
    expect(r.cookies[0]).toMatchObject({ name: "__Secure-1PSID", domain: ".google.com", secure: true });
  });

  it("dedupes and sorts domains (strips leading dot)", () => {
    const r = parseCookies(
      JSON.stringify([
        { name: "a", value: "1", domain: ".b.com" },
        { name: "c", value: "2", domain: "a.com" },
        { name: "d", value: "3", domain: "b.com" },
      ]),
    );
    expect(r.domains).toEqual(["a.com", "b.com"]);
  });
});
