import { MAX_INTERNAL_PATH_LENGTH, safeInternalPath } from "../safe-internal-path";

describe("safeInternalPath", () => {
  it.each([
    ["a dashboard deep link", "/dashboard/computers?launch=1"],
    ["a wake page", "/wake/33333333-3333-4333-8333-333333333333"],
    ["a plan activation path", "/get-started/activate?plan=fleet&agentType=claude-code"],
    ["the root", "/"],
  ])("accepts %s and returns it canonically", (_label, value) => {
    expect(safeInternalPath(value)).toBe(value);
  });

  it.each([
    ["a protocol-relative URL", "//attacker.example"],
    ["a backslash after the leading slash", "/\\attacker.example"],
    ["two backslashes", "/\\\\attacker.example"],
    ["a literal tab after the leading slash", "/\t/attacker.example"],
    ["a literal newline after the leading slash", "/\n/attacker.example"],
    ["a literal carriage return after the leading slash", "/\r/attacker.example"],
    ["a NUL control character", "/\u0000/attacker.example"],
    ["an encoded backslash", "/%5Cattacker.example"],
    ["an encoded tab", "/%09/attacker.example"],
    ["an encoded newline", "/%0A/attacker.example"],
    ["an encoded protocol-relative prefix", "/%2F%2Fattacker.example"],
    ["an absolute URL", "https://attacker.example/dashboard"],
    ["a javascript scheme", "javascript:alert(1)"],
    ["a relative path", "dashboard/launch"],
    ["a malformed percent escape", "/dashboard/%E0%A4%A"],
    ["an empty string", ""],
    ["a non-string", 42],
    ["an array", ["/dashboard"]],
    ["undefined", undefined],
    ["a path over the length limit", `/${"a".repeat(MAX_INTERNAL_PATH_LENGTH)}`],
  ])("rejects %s", (_label, value) => {
    expect(safeInternalPath(value)).toBeNull();
  });
});
