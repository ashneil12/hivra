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
});
