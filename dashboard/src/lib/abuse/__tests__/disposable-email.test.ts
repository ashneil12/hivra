import {
  checkEmail,
  _getDisposableDomainsSnapshot,
} from "@/lib/abuse/disposable-email";

describe("checkEmail", () => {
  it.each([
    ["null input", null],
    ["undefined input", undefined],
    ["empty string", ""],
    ["non-string input", 123],
    ["input with no @", "notanemail"],
    ["input ending with @ (no domain)", "user@"],
    ["input starting with @ (no local)", "@example.com"],
    ["domain without a dot", "user@localhost"],
  ])("returns null for %s", (_label, input) => {
    // @ts-expect-error — testing runtime defensiveness against bad input
    expect(checkEmail(input)).toBeNull();
  });

  it.each([
    ["flags mailinator.com as disposable", "user@mailinator.com", "mailinator.com", true],
    ["flags 10minutemail.com as disposable", "foo@10minutemail.com", undefined, true],
    ["flags guerrillamail.com as disposable", "foo@guerrillamail.com", undefined, true],
    ["flags trashmail.com as disposable", "foo@trashmail.com", undefined, true],
    ["does NOT flag gmail.com", "user@gmail.com", "gmail.com", false],
    ["does NOT flag fastmail.com (legit privacy-focused provider)", "user@fastmail.com", undefined, false],
    ["does NOT flag protonmail.com", "user@protonmail.com", undefined, false],
    ["normalizes case (uppercase domain still flagged)", "user@MAILINATOR.COM", undefined, true],
    ["trims whitespace", "  user@mailinator.com  ", undefined, true],
  ] as const)("%s", (_label, input, domain, isDisposable) => {
    const result = checkEmail(input);
    expect(result?.isDisposable).toBe(isDisposable);
    if (domain !== undefined) expect(result?.domain).toBe(domain);
  });

  it("handles multiple @ symbols (uses last @ as separator)", () => {
    // Edge case — RFC technically allows quoted local parts with @, but in
    // practice no email provider accepts these. We split on last @.
    expect(checkEmail("weird@local@mailinator.com")?.domain).toBe(
      "mailinator.com"
    );
  });

  it("handles plus addressing in local part", () => {
    const result = checkEmail("user+filter@gmail.com");
    expect(result?.domain).toBe("gmail.com");
    expect(result?.isDisposable).toBe(false);
  });
});

describe("_getDisposableDomainsSnapshot", () => {
  it("contains the major disposable domains", () => {
    const snapshot = _getDisposableDomainsSnapshot();
    expect(snapshot.has("mailinator.com")).toBe(true);
    expect(snapshot.has("10minutemail.com")).toBe(true);
    expect(snapshot.has("guerrillamail.com")).toBe(true);
    expect(snapshot.has("yopmail.com")).toBe(true);
  });

  it("does NOT contain legit providers", () => {
    const snapshot = _getDisposableDomainsSnapshot();
    expect(snapshot.has("gmail.com")).toBe(false);
    expect(snapshot.has("outlook.com")).toBe(false);
    expect(snapshot.has("yahoo.com")).toBe(false);
    expect(snapshot.has("protonmail.com")).toBe(false);
  });

  it("has a non-trivial size (sanity check the embedded list)", () => {
    const snapshot = _getDisposableDomainsSnapshot();
    expect(snapshot.size).toBeGreaterThan(50);
  });
});
