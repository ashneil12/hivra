/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";

import Footer from "@/components/landing/Footer";
import PublicSite from "@/components/public-site/PublicSite";
import OpenSource from "@/components/landing/home/OpenSource";
import Fit from "@/components/landing/home/Fit";

const original = process.env.HIVRA_NEW_TOKEN_SURFACES;
afterEach(() => {
  if (original === undefined) delete process.env.HIVRA_NEW_TOKEN_SURFACES;
  else process.env.HIVRA_NEW_TOKEN_SURFACES = original;
});

const hrefs = (container: HTMLElement) => Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
const HELD = /litepaper|\/token\b|tokenomics|evolution|convert/i;

describe("site chrome while the new token surfaces are off", () => {
  it("the footer links none of the held-back pages", () => {
    const { container } = render(<Footer />);
    expect(hrefs(container).filter((h) => HELD.test(h ?? ""))).toEqual([]);
    expect(screen.getByText("Formerly HermesOS")).toBeTruthy();
    expect(screen.getByText("Pricing")).toBeTruthy();
  });

  it("the footer links them when on", () => {
    const { container } = render(<Footer tokenSurfaces />);
    expect(hrefs(container)).toEqual(expect.arrayContaining(["/token", "/docs/litepaper/index.html", "/why-hivra/evolution"]));
  });

  it("PublicSite follows the switch (header and footer)", () => {
    delete process.env.HIVRA_NEW_TOKEN_SURFACES;
    const off = render(<PublicSite isSignedIn={false}><main>x</main></PublicSite>);
    expect(hrefs(off.container).filter((h) => HELD.test(h ?? ""))).toEqual([]);
    off.unmount();
    process.env.HIVRA_NEW_TOKEN_SURFACES = "true";
    const on = render(<PublicSite isSignedIn={false}><main>x</main></PublicSite>);
    expect(hrefs(on.container).filter((h) => HELD.test(h ?? "")).length).toBeGreaterThan(0);
  });

  it("the homepage sections do not point at the litepaper", () => {
    delete process.env.HIVRA_NEW_TOKEN_SURFACES;
    const fit = render(<Fit />);
    const open = render(<OpenSource />);
    expect([...hrefs(fit.container), ...hrefs(open.container)].filter((h) => HELD.test(h ?? ""))).toEqual([]);
    expect(hrefs(fit.container)).toContain("/compare");
  });
});
