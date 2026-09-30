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
      expect(copy.stats.page.cta.button).not.toBe(english.stats.page.cta.button);
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
    "dashboard.billing.plate.vcpu",
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
    "nav.roadmap",
    "stats.page.headlinePrefix",
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

describe("i18n public copy truth", () => {
  // These blocks were the pre-Hivra landing page ("Launch AI agents in one
  // click", a hosted free tier, the $HermesOS discount, Pro and Power). No
  // component reads them any more: the homepage, /pricing and the agent pages
  // carry their own reviewed copy. They were deleted from every locale so the
  // retired claims cannot reach a public page again; do not bring them back.
  const RETIRED_TOP_LEVEL_BLOCKS = [
    "hero",
    "ticker",
    "positioning",
    "features",
    "howItWorks",
    "useCases",
    "whatsComing",
    "pricing",
    "token",
    "faq",
    "finalCta",
  ];

  // Wording the owner retired (2026-09-30): one-click deploys, a hosted free
  // tier, a $HermesOS discount, and the old "Pro and Power" plan names. The
  // alternation covers the translations that used to sit next to the English.
  const RETIRED_CLAIMS =
    /one[- ]click|一键|free (tier|plan)|always free|免费(层|计划|方案|层级)|plan(o)? (gratis|grátis|gratuito)|niveau gratuit|free-tarif|kostenlos|無料プラン|무료 플랜|pro and power|\$hermesos|hermesos discount|save up to \d+%/i;

  function collectStrings(value: unknown, out: string[]) {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
    else if (value && typeof value === "object") {
      Object.values(value).forEach((child) => collectStrings(child, out));
    }
  }

  it("has none of the retired landing-page blocks in any locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const keys = Object.keys(MARKETING_COPY[locale]);
      for (const retired of RETIRED_TOP_LEVEL_BLOCKS) {
        expect({ locale, present: keys.includes(retired) }).toEqual({ locale, present: false });
      }
    }
  });

  it("keeps retired offer wording out of the copy that public pages render", () => {
    // nav is the landing header, stats is the public /stats page, footer is the
    // site footer. getStarted (the checkout step, noindex) and dashboard (signed
    // in) are product screens that describe what checkout really sells, so they
    // are deliberately not scanned here.
    const offenders: string[] = [];
    for (const locale of SUPPORTED_LOCALES) {
      const copy = MARKETING_COPY[locale];
      const strings: string[] = [];
      collectStrings({ nav: copy.nav, stats: copy.stats, footer: copy.footer }, strings);
      for (const text of strings) {
        if (RETIRED_CLAIMS.test(text)) offenders.push(`${locale}: ${text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("describes the Wallets row in settings without the token, in every language", () => {
    // The row is shown to every viewer, and the token geo-policy only gates the
    // wallet page behind it. It says what the page holds for everyone: agent wallets.
    const rows: Array<{ locale: string; title: string; description: string }> = [];
    const find = (locale: string, value: unknown, key: string) => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (key === "wallets" && typeof record.title === "string" && typeof record.description === "string") {
        rows.push({ locale, title: record.title, description: record.description });
      }
      for (const [childKey, child] of Object.entries(record)) find(locale, child, childKey);
    };
    for (const locale of SUPPORTED_LOCALES) find(locale, MARKETING_COPY[locale], "");

    expect(rows.map((row) => row.locale).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    for (const row of rows) {
      expect({ locale: row.locale, token: /\$HermesOS|\$HIVRA|\btokens?\b/i.test(row.description) }).toEqual({
        locale: row.locale,
        token: false,
      });
    }
    expect(rows.find((row) => row.locale === "en")?.description).toBe("Agent wallets");
  });

  it("describes the /stats call to action as open source on Hivra Cloud or your own server", () => {
    expect(MARKETING_COPY.en.stats.page.cta.subtitle).toBe(
      "Open source, on Hivra Cloud or your own server",
    );
  });
});
