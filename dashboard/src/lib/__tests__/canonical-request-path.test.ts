import { canonicalRequestPath } from "@/lib/canonical-request-path";

describe("canonicalRequestPath", () => {
  it.each([
    ["an encoded letter in an app route", "/%70ricing", "/pricing"],
    ["an encoded letter in the middle of a word", "/pric%69ng", "/pricing"],
    ["every letter encoded", "/%70%72%69%63%69%6e%67", "/pricing"],
    ["an encoded upper-case letter", "/docs/%4cITEPAPER.md", "/docs/LITEPAPER.md"],
    ["an encoded letter in an api route", "/api/%68ealth", "/api/health"],
    ["an encoded letter in a static document", "/docs/litepaper/%69ndex.html", "/docs/litepaper/index.html"],
    ["an encoded period", "/docs/litepaper/index%2ehtml", "/docs/litepaper/index.html"],
    ["an encoded hyphen and underscore", "/a%2Db%5Fc", "/a-b_c"],
    ["an encoded digit", "/v%31/status", "/v1/status"],
    ["an encoded tilde", "/%7ezzz", "/~zzz"],
    ["lower-case hex digits", "/%7a", "/z"],
  ])("decodes %s", (_label, input, expected) => {
    expect(canonicalRequestPath(input)).toBe(expected);
  });

  it.each([
    ["a plain path", "/pricing"],
    ["the root", "/"],
    ["an encoded slash", "/a%2Fb"],
    ["an encoded percent sign", "/%2570ricing"],
    ["an encoded question mark", "/a%3Fb"],
    ["an encoded hash", "/a%23b"],
    ["an encoded space", "/my%20file"],
    ["an encoded backslash", "/%5Cevil"],
    ["an encoded multi-byte character", "/caf%C3%A9"],
    ["an encoded bracket", "/%5Bid%5D"],
  ])("leaves %s alone", (_label, input) => {
    expect(canonicalRequestPath(input)).toBeNull();
  });

  it("decodes only the unreserved escapes in a mixed path and keeps the rest as written", () => {
    expect(canonicalRequestPath("/%70ricing/a%2Fb/caf%C3%A9/%2570")).toBe("/pricing/a%2Fb/caf%C3%A9/%2570");
    expect(canonicalRequestPath("/a%2fb/%61")).toBe("/a%2fb/a");
  });

  it("never touches build assets", () => {
    expect(canonicalRequestPath("/_next/static/chunks/%5Bturbopack%5D_runtime.js")).toBeNull();
    expect(canonicalRequestPath("/_next/static/chunks/%61bc.js")).toBeNull();
  });

  // %2e%2e would decode to `..`, a segment a browser or server collapses, which
  // could land the request on a different path than the one named.
  it.each(["/%2e%2e/admin", "/a/%2E%2E/b", "/a/%2e/b", "/%2e%2e", "/docs/%2e%2e/%61bout"])(
    "refuses a path that would turn into a dot segment: %s",
    (input) => {
      expect(canonicalRequestPath(input)).toBeNull();
    },
  );

  // A stray % that starts no escape is malformed. Decoding beside it could join
  // pieces into a new escape, so the path is left as it came.
  it.each(["/%%370ricing", "/100%", "/a%zz", "/%7", "/%70ricing%"])("leaves a malformed escape alone: %s", (input) => {
    expect(canonicalRequestPath(input)).toBeNull();
  });

  it("does not turn a decoded path into a protocol-relative one", () => {
    // The result is a path, and the proxy writes it into a URL on its own origin
    // with the pathname setter, so a leading double slash stays a path.
    expect(canonicalRequestPath("//%65vil.com")).toBe("//evil.com");
  });

  it("gives a result that needs no further change", () => {
    for (const input of ["/%70ricing", "/%70%72%69%63%69%6e%67/%61/%2Fb", "/docs/litepaper/index%2ehtml"]) {
      const once = canonicalRequestPath(input);
      expect(once).not.toBeNull();
      expect(canonicalRequestPath(once as string)).toBeNull();
    }
  });
});
