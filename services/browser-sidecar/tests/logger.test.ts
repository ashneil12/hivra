import { describe, expect, it } from "vitest";
import { redactArgs } from "../src/logger.js";

describe("redactArgs", () => {
  it("redacts password keys", () => {
    expect(redactArgs({ password: "p@ss" })).toEqual({ password: "[REDACTED]" });
  });

  it("redacts the value field on /fill payloads", () => {
    expect(redactArgs({ selector: "input", value: "pa55word" })).toEqual({
      selector: "input",
      value: "[REDACTED]",
    });
  });

  it("redacts secrets and tokens by name", () => {
    expect(redactArgs({ api_secret: "x", auth_token: "y", regular_field: "ok" })).toEqual({
      api_secret: "[REDACTED]",
      auth_token: "[REDACTED]",
      regular_field: "ok",
    });
  });

  it("recurses into nested objects", () => {
    expect(
      redactArgs({ outer: { inner: { password: "p" } } }),
    ).toEqual({ outer: { inner: { password: "[REDACTED]" } } });
  });

  it("passes primitives through untouched", () => {
    expect(redactArgs("hello")).toBe("hello");
    expect(redactArgs(42)).toBe(42);
    expect(redactArgs(null)).toBe(null);
  });

  it("redacts the cookie-import file, which is the user's whole session export", () => {
    expect(
      redactArgs({ identity: "vex", file: "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tsid\tabc", dryRun: false }),
    ).toEqual({ identity: "vex", file: "[REDACTED]", dryRun: false });
  });

  it("redacts cookie and storage-state fields by name", () => {
    expect(redactArgs({ cookies: [{ name: "sid", value: "abc" }], storageState: { origins: [] } })).toEqual({
      cookies: "[REDACTED]",
      storageState: "[REDACTED]",
    });
  });

  it("keeps only the origin and path of a logged url, so a one-time ticket in the query is not written", () => {
    const logged = redactArgs({
      session_id: "s",
      url: "https://login.example.test/cb?ticket=CANARYTICKET#frag-CANARYFRAG",
    });
    expect(logged).toEqual({ session_id: "s", url: "https://login.example.test/cb" });
  });

  it("redacts a logged url that does not parse", () => {
    expect(redactArgs({ url: "not a url?ticket=CANARYTICKET" })).toEqual({ url: "[REDACTED]" });
  });
});
