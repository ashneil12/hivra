/** @jest-environment node */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PricingSection from "../PricingSection";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { SUPPORTED_LOCALES } from "@/lib/i18n";

// Real React, Next links and dependencies: no motion or visibility mocks.
describe("PricingSection before hydration", () => {
  it.each(SUPPORTED_LOCALES)("ships visible platform and capacity offers without JavaScript in %s", (locale) => {
    const markup = renderToStaticMarkup(<LocaleProvider initialLocale={locale}><PricingSection /></LocaleProvider>);

    expect(markup.match(/<article\b/g)).toHaveLength(2);
    expect(markup.match(/href="\/dashboard\/infrastructure"/g)).toHaveLength(2);
    for (const offer of ["own", "hosted"]) expect(markup).toContain(`id="pricing-${offer}-cta"`);
    expect(markup).toContain("$0");
    expect(markup).toContain("Hivra Cloud");
    expect(markup).not.toMatch(/style="[^"]*(?:opacity:\s*0(?:;|")|visibility:\s*hidden|display:\s*none)/);
    expect(markup).not.toMatch(/<article[^>]*(?:hidden|aria-hidden="true")/);
    expect(markup).not.toMatch(/\$9\.99|\$19\.99|plan=(?:free|operator|fleet)/);
  });
});
