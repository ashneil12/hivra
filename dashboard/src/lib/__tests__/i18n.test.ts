import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  MARKETING_COPY,
  SUPPORTED_LOCALES,
  appendWebUILocaleSearchParams,
  localeToHtmlLang,
  resolveRequestLocale,
} from "../i18n";

describe("i18n locale support", () => {
  const expandedLocales = ["es", "pt-BR", "fr", "de", "ja", "ko"] as const;

  it("prefers an explicit supported locale over browser language", () => {
    expect(
      resolveRequestLocale({
        explicitLocale: "zh-CN",
        cookieLocale: "en",
        acceptLanguage: "en-US,en;q=0.9",
      }),
    ).toBe("zh-CN");
  });

  it("detects Chinese browser languages early for first paint", () => {
    expect(
      resolveRequestLocale({
        cookieLocale: undefined,
        acceptLanguage: "zh-Hans-CN,zh;q=0.9,en;q=0.6",
      }),
    ).toBe("zh-CN");
  });

  it("detects the next supported browser languages early for first paint", () => {
    expect(
      resolveRequestLocale({
        cookieLocale: undefined,
        acceptLanguage: "es-MX,es;q=0.9,en;q=0.6",
      }),
    ).toBe("es");

    expect(
      resolveRequestLocale({
        cookieLocale: undefined,
        acceptLanguage: "pt-BR,pt;q=0.9,en;q=0.6",
      }),
    ).toBe("pt-BR");

    expect(
      resolveRequestLocale({
        cookieLocale: undefined,
        acceptLanguage: "ja-JP,ja;q=0.9,en;q=0.6",
      }),
    ).toBe("ja");

    expect(
      resolveRequestLocale({
        cookieLocale: undefined,
        acceptLanguage: "fr-CA,fr;q=0.9,en;q=0.6",
      }),
    ).toBe("fr");

    expect(
      resolveRequestLocale({
        cookieLocale: undefined,
        acceptLanguage: "de-DE,de;q=0.9,en;q=0.6",
      }),
    ).toBe("de");

    expect(
      resolveRequestLocale({
        cookieLocale: undefined,
        acceptLanguage: "ko-KR,ko;q=0.9,en;q=0.6",
      }),
    ).toBe("ko");
  });

  it("ignores unsupported locale values instead of persisting a broken scope", () => {
    expect(
      resolveRequestLocale({
        explicitLocale: "klingon",
        cookieLocale: "also-bad",
        acceptLanguage: "it-IT,it;q=0.9",
      }),
    ).toBe("en");
  });

  it("uses the same cookie name across server and client locale persistence", () => {
    expect(LOCALE_COOKIE_NAME).toBe("hermes_locale");
  });

  it("maps supported locales to valid html lang values", () => {
    expect(localeToHtmlLang("en")).toBe("en");
    expect(localeToHtmlLang("zh-CN")).toBe("zh-CN");
    expect(localeToHtmlLang("es")).toBe("es");
    expect(localeToHtmlLang("pt-BR")).toBe("pt-BR");
    expect(localeToHtmlLang("fr")).toBe("fr");
    expect(localeToHtmlLang("de")).toBe("de");
    expect(localeToHtmlLang("ja")).toBe("ja");
    expect(localeToHtmlLang("ko")).toBe("ko");
  });

  it("keeps the core app surfaces translated for every expanded locale", () => {
    const english = MARKETING_COPY.en;

    for (const locale of expandedLocales) {
      const copy = MARKETING_COPY[locale];

      expect(copy.localeLabel).not.toBe(english.localeLabel);
      expect(copy.nav.pricing).not.toBe(english.nav.pricing);
      expect(copy.hero.primaryCta).not.toBe(english.hero.primaryCta);
      expect(copy.dashboard.library.returnToCommandCenter).not.toBe(
        english.dashboard.library.returnToCommandCenter,
      );
      expect(copy.dashboard.wallet.verification.connectWallet).not.toBe(
        english.dashboard.wallet.verification.connectWallet,
      );
      expect(copy.dashboard.billing.eyebrow).not.toBe(english.dashboard.billing.eyebrow);
      expect(copy.dashboard.settings.language.label).not.toBe(
        english.dashboard.settings.language.label,
      );
    }
  });

  it("adds locale hints to WebUI URLs without moving the bearer out of the hash", () => {
    const url = appendWebUILocaleSearchParams(
      "https://agent.example.com/#iframe_token=secret",
      "zh-CN",
    );
    const parsed = new URL(url);

    expect(parsed.searchParams.get("locale")).toBe("zh-CN");
    expect(parsed.searchParams.get("lang")).toBe("zh-CN");
    expect(parsed.hash).toBe("#iframe_token=secret");
  });
});

describe("i18n translation parity", () => {
  // Paths whose value is intentionally identical to English across locales:
  // brand/product names, plan tiers, units, prices, separators, proper nouns,
  // and tech loanwords that are genuinely the same word in the target language.
  // Anything NOT listed here must be translated in every non-English locale —
  // a new untranslated string (English falling through) will fail the test below.
  const INTENTIONALLY_IDENTICAL = new Set<string>([
    "dashboard.billing.activePlan.agents",
    "dashboard.billing.activity.llm",
    "dashboard.billing.switcher.agents",
    "dashboard.billing.titlePrefix",
    "dashboard.billing.titleSuffix",
    "dashboard.billing.tokenAccess.minimum",
    "dashboard.billing.tokenAccess.title",
    "dashboard.billing.tokenAccess.wallet",
    "dashboard.commandCenter.alerts.activeFailurePlural",
    "dashboard.commandCenter.alerts.activeFailureSingular",
    "dashboard.commandCenter.alerts.updateSummaryPlural",
    "dashboard.commandCenter.alerts.updateSummarySingular",
    "dashboard.commandCenter.instance.idPrefix",
    "dashboard.commandCenter.labelSeparator",
    "dashboard.commandCenter.status.error",
    "dashboard.commandCenter.telemetry.limitPrefix",
    "dashboard.commandCenter.titleSuffix",
    "dashboard.library.categories.Design",
    "dashboard.library.categories.Finance",
    "dashboard.library.categories.Marketing",
    "dashboard.library.sourceLinkLabel",
    "dashboard.library.sourceSuffix",
    "dashboard.library.titleSuffix",
    "dashboard.nav.chat",
    "dashboard.nav.ops",
    "dashboard.nav.wallet",
    "dashboard.sections.support",
    "dashboard.settings.theme.system",
    "dashboard.settings.titleSuffix",
    "dashboard.support.discord",
    "dashboard.support.xTwitter",
    "dashboard.userModeSuffix",
    "dashboard.versionLabel",
    "dashboard.wallet.buyToken.warningLink",
    "dashboard.wallet.titleEmphasis",
    "footer.links.blog",
    "footer.links.roadmap",
    "getStarted.specs.agents",
    "getStarted.specs.cpu",
    "getStarted.specs.ram",
    "howItWorks.steps[0].step",
    "howItWorks.steps[1].step",
    "howItWorks.steps[2].step",
    "nav.roadmap",
    "pricing.tiers[0].name",
    "pricing.tiers[0].price",
    "pricing.tiers[0].specs[0].label",
    "pricing.tiers[0].specs[0].value",
    "pricing.tiers[0].specs[1].label",
    "pricing.tiers[0].specs[1].value",
    "pricing.tiers[0].specs[2].value",
    "pricing.tiers[1].name",
    "pricing.tiers[1].paymentPaths[0].detail",
    "pricing.tiers[1].price",
    "pricing.tiers[1].specs[0].label",
    "pricing.tiers[1].specs[0].value",
    "pricing.tiers[1].specs[1].label",
    "pricing.tiers[1].specs[1].value",
    "pricing.tiers[1].specs[2].value",
    "pricing.tiers[2].name",
    "pricing.tiers[2].paymentPaths[0].detail",
    "pricing.tiers[2].price",
    "pricing.tiers[2].specs[0].label",
    "pricing.tiers[2].specs[0].value",
    "pricing.tiers[2].specs[1].label",
    "pricing.tiers[2].specs[1].value",
    "stats.page.headlinePrefix",
    "useCases.items[0].headline",
    "whatsComing.items[0].title",
    "whatsComing.items[1].title",
    "whatsComing.items[2].title",
    "whatsComing.items[3].title",
  ]);

  function collectLeaves(value: unknown, prefix: string, out: Array<[string, string]>) {
    if (typeof value === "string") {
      out.push([prefix, value]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => collectLeaves(item, `${prefix}[${index}]`, out));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        collectLeaves(child, prefix ? `${prefix}.${key}` : key, out);
      }
    }
  }

  const englishLeaves: Array<[string, string]> = [];
  collectLeaves(MARKETING_COPY[DEFAULT_LOCALE], "", englishLeaves);
  const englishByPath = new Map(englishLeaves);

  it("translates every non-English locale string (no silent English fallback)", () => {
    const offenders: string[] = [];

    for (const locale of SUPPORTED_LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      const leaves: Array<[string, string]> = [];
      collectLeaves(MARKETING_COPY[locale], "", leaves);

      for (const [path, value] of leaves) {
        const englishValue = englishByPath.get(path);
        if (englishValue === undefined) continue;
        if (englishValue.trim().length === 0) continue;
        if (value === englishValue && !INTENTIONALLY_IDENTICAL.has(path)) {
          offenders.push(`${locale}: ${path} = ${JSON.stringify(englishValue)}`);
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `Found ${offenders.length} untranslated string(s) still showing English. ` +
          `Translate them in LOCALE_COPY_OVERRIDES, or add the path to ` +
          `INTENTIONALLY_IDENTICAL if it is a brand name / unit / loanword:\n` +
          offenders.join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the intentionally-identical allowlist free of dead entries", () => {
    const validPaths = new Set(englishLeaves.map(([path]) => path));
    const stale = [...INTENTIONALLY_IDENTICAL].filter((path) => !validPaths.has(path));
    expect(stale).toEqual([]);
  });
});
