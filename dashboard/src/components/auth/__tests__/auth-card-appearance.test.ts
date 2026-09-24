import { AUTH_CARD_ELEMENTS, CLERK_UI_COLOR_VARIABLES, authCardAppearance } from "../auth-card-appearance";
import { HIVRA_CLERK_LOCALIZATION } from "../clerk-localization";

const NON_COLOR_VARIABLES = ["borderRadius", "fontFamily"];

describe("Clerk auth card appearance", () => {
  it("only sets variables @clerk/ui 1.x reads, never the renamed ones it silently ignores", () => {
    const { variables } = authCardAppearance();
    for (const key of Object.keys(variables)) {
      expect([...CLERK_UI_COLOR_VARIABLES, ...NON_COLOR_VARIABLES]).toContain(key);
    }
    for (const legacy of ["colorText", "colorTextSecondary", "colorTextOnPrimaryBackground", "colorInputText", "colorInputBackground"]) {
      expect(variables).not.toHaveProperty(legacy);
    }
  });

  it("binds the card, its text, inputs and primary button to theme tokens, so dark mode stays legible", () => {
    const { variables } = authCardAppearance();
    expect(variables).toMatchObject({
      colorBackground: "var(--bg-surface)",
      colorForeground: "var(--ink-black)",
      colorPrimary: "var(--ink-black)",
      // Text on the primary fill is the page colour: dark on light ink, light on dark ink.
      colorPrimaryForeground: "var(--vellum-bg)",
      colorInputForeground: "var(--ink-black)",
      colorNeutral: "var(--ink-black)",
    });
    // Every colour is a token or transparent, never a fixed light-theme colour.
    for (const key of CLERK_UI_COLOR_VARIABLES) {
      const value = (variables as Record<string, unknown>)[key];
      if (value !== undefined) expect(value).toMatch(/^(?:var\(--[a-z-]+\)|transparent)$/);
    }
  });

  it("uses no fixed white or black colour classes on any element", () => {
    const { elements } = authCardAppearance();
    for (const [element, classes] of Object.entries(elements)) {
      expect({ element, classes }).toEqual({ element, classes: expect.not.stringMatching(/(?:^|\s|:)(?:bg|text)-(?:white|black)(?:\/\d+)?(?:\s|$)/) });
    }
    expect(AUTH_CARD_ELEMENTS.card).toContain("bg-[var(--bg-surface)]");
    expect(AUTH_CARD_ELEMENTS.formButtonPrimary).toContain("text-[var(--vellum-bg)]");
  });

  it("lets a page restyle its own elements without dropping the shared card", () => {
    const { elements } = authCardAppearance({ headerTitle: "serif text-[2rem]" });
    expect(elements.headerTitle).toBe("serif text-[2rem]");
    expect(elements.card).toBe(AUTH_CARD_ELEMENTS.card);
  });
});

describe("Clerk localization", () => {
  const strings = (value: unknown): string[] =>
    typeof value === "string" ? [value] : Object.values(value as Record<string, unknown>).flatMap(strings);

  it("names Hivra wherever Clerk would print the instance's application name", () => {
    expect(HIVRA_CLERK_LOCALIZATION.signIn?.start?.title).toBe("Sign in to Hivra");
    expect(HIVRA_CLERK_LOCALIZATION.signUp?.start?.title).toBe("Create your Hivra account");
    for (const text of strings(HIVRA_CLERK_LOCALIZATION)) {
      expect(text).not.toContain("{{applicationName}}");
      expect(text).toMatch(/Hivra/);
      expect(text).not.toMatch(/hermes/i);
    }
  });

  it("covers every sign-in and sign-up string that names the application in @clerk/ui 1.7.0", () => {
    // Listed from the pinned bundle's English resource (keys whose default text
    // contains {{applicationName}}), plus the sign-up title, whose default
    // ("Create your account") names nothing; see clerk-localization.ts.
    const flatten = (value: unknown, prefix = ""): string[] =>
      typeof value === "string" ? [prefix] : Object.entries(value as Record<string, unknown>)
        .flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));
    expect(flatten(HIVRA_CLERK_LOCALIZATION).sort()).toEqual([
      "signIn.alternativePhoneCodeProvider.subtitle",
      "signIn.emailCode.subtitle",
      "signIn.emailCodeMfa.subtitle",
      "signIn.emailLink.subtitle",
      "signIn.emailLinkMfa.subtitle",
      "signIn.phoneCode.subtitle",
      "signIn.start.alternativePhoneCodeProvider.title",
      "signIn.start.title",
      "signIn.start.titleCombined",
      "signUp.emailLink.subtitle",
      "signUp.start.alternativePhoneCodeProvider.title",
      "signUp.start.title",
    ]);
  });
});
