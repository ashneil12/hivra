import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import PublicSite from "@/components/public-site/PublicSite";
import StructuredData from "@/components/StructuredData";
import { SITE_DESCRIPTION } from "@/lib/brand-description";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { getTokenSurfaceView, tokenSurfacesVisible } from "@/lib/compliance/token-surface-view";
import { OG_IMAGE } from "@/lib/og-meta";
import { officialProfileLinks } from "@/lib/public-project-links";
import { SITE_URL } from "@/lib/seo-urls";
import { ENTRY_PLAN_PRICE, LARGER_PLAN_PRICE } from "@/lib/blog/plan-facts";
import { HOSTED_SIZES } from "@/app/pricing/pricing-content";

import { HomeMotion } from "@/components/landing/home/motion";
import Hero from "@/components/landing/home/Hero";
import Reach from "@/components/landing/home/Reach";
import Fit from "@/components/landing/home/Fit";
import Agents from "@/components/landing/home/Agents";
import How from "@/components/landing/home/How";
import OpenSource from "@/components/landing/home/OpenSource";
import Pricing from "@/components/landing/home/Pricing";
import Founder from "@/components/landing/home/Founder";
import Faq from "@/components/landing/home/Faq";
import Closing from "@/components/landing/home/Closing";
import StickyCta from "@/components/landing/home/StickyCta";
import HomeAnalytics from "@/components/landing/home/HomeAnalytics";
import { getHomeAgentsDeployed } from "@/components/landing/home/agents-deployed";
import { AGENT_LAUNCH_HREF, SHOW_FOUNDER_SECTION, STICKY, homepageFaq } from "@/components/landing/home/content";
import styles from "@/components/landing/home/home.module.css";

// "Hermes OS" stays at the front of the homepage title: in Search Console
// (Jun-Sep 2026) about three quarters of hivra.cloud's clicks came from
// "hermes os" / "hermes agent os" / "hermesos" searches landing here, and the
// retired site's "Hermes OS is now Hivra" title earned 20-26% CTR at positions
// 1-3. The tagline and description are the website pack's (01-homepage.md);
// the description leaves out its keep-running sentence, which is not true of
// every run (lib/blog/runtime-facts.ts). The title is written finished, so
// the root layout's " | Hivra" template is not added a second time.
const HOME_TITLE = "Hermes OS is now Hivra | Give your AI agent a computer of its own";
const HOME_DESCRIPTION = `Run Claude Code, Codex, Hermes and other AI agents on separate computers. Open-source Hivra, hosted from ${ENTRY_PLAN_PRICE} a month or self-hosted.`;

export const metadata: Metadata = {
  title: absoluteTitle(HOME_TITLE),
  description: HOME_DESCRIPTION,
  ...buildWebsiteMetadata({
    path: "/",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    twitterTitle: HOME_TITLE,
    twitterDescription: HOME_DESCRIPTION,
    images: [OG_IMAGE.home],
  }),
};

// Identity markup (owner decision 2026-09-30, checklist E1 to E3):
// - Organization carries the one-line description and the FORMER names only
//   ("HermesOS", "Hermes OS"). Never another company's product name: "Hermes
//   Cloud" and "Hermes Agent OS" are Nous Research's, and Google's structured
//   data policy bars markup that misrepresents affiliation.
// - WebSite.name is "Hivra" with the lowercase domain as the fallback site name,
//   because hivra.ai, hivra.app and hivra.space also call themselves Hivra. Old
//   names stay out of WebSite and SoftwareApplication.
// - The logo is the square 512x512 brand mark, not the 1200x630 social banner.
// - sameAs lists only profiles Hivra controls (officialProfileLinks()).
// homepage-structured-data.test.tsx scans this graph for forbidden strings.
// The FAQPage node is built from the same list the page shows, so the visible
// answers and the structured ones are the same strings.
function buildHomepageSchema(faq: readonly { q: string; a: string }[]) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: "Hivra",
        alternateName: ["HermesOS", "Hermes OS"],
        description: SITE_DESCRIPTION,
        url: SITE_URL,
        logo: {
          "@type": "ImageObject",
          url: `${SITE_URL}/brand/hivra-icon-512.png`,
          width: 512,
          height: 512,
        },
        sameAs: officialProfileLinks(),
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: SITE_URL,
        name: "Hivra",
        alternateName: ["hivra.cloud"],
        description: SITE_DESCRIPTION,
        publisher: { "@id": `${SITE_URL}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/#softwareapp`,
        name: "Hivra",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Ubuntu",
        description: SITE_DESCRIPTION,
        url: SITE_URL,
        offers: [
          {
            "@type": "Offer",
            name: "Self-host Hivra",
            price: "0",
            priceCurrency: "USD",
            description: "Run the whole platform yourself from the open source code. You provide the server and pay for it and for your AI usage.",
            url: `${SITE_URL}/#pricing`,
          },
          ...HOSTED_SIZES.map(size => ({
            "@type": "Offer",
            name: `Hivra Cloud, ${size.cpu} vCPU and ${size.ramGb} GB`,
            price: (size.price === ENTRY_PLAN_PRICE ? ENTRY_PLAN_PRICE : LARGER_PLAN_PRICE).replace("$", ""),
            priceCurrency: "USD",
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: size.price.replace("$", ""),
              priceCurrency: "USD",
              billingDuration: "P1M",
            },
            url: `${SITE_URL}/#pricing`,
          })),
        ],
        featureList: [
          "Launch a computer with or without an agent",
          "Ubuntu, Omarchy (prepared computer) or Windows on your own server with a licensed image",
          "Terminal and graphical interfaces",
          "Persistent files, tools and settings",
          "Use Hivra Cloud or your own infrastructure",
          "Bring your own AI key",
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: faq.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Home",
            item: SITE_URL,
          },
        ],
      },
    ],
  };
}

/**
 * Header and footer links such as /#pricing come from this site. A signed-in
 * visitor following one wants that section, not the dashboard; direct visits
 * (typed URL, external link, bookmark) still land on the dashboard.
 * "same-site" covers an internal link whose request passed through Clerk's
 * handshake on the clerk.<domain> subdomain; direct visits stay "none".
 */
function isSameSiteNavigation(headerStore: Pick<Headers, "get">): boolean {
  const fetchSite = headerStore.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "same-site";
  const referer = headerStore.get("referer");
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  if (!referer || !host) return false;
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

// English only, like /pricing, /blog and /agents: no LocaleProvider, which
// would also rewrite a visitor's saved language for the rest of the site.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default async function LandingPage(_props: { searchParams?: Promise<{ lang?: string | string[]; locale?: string | string[] }> }) {
  const { userId } = await auth();
  const headerStore = await headers();

  if (userId && !isSameSiteNavigation(headerStore)) {
    redirect("/dashboard");
  }

  // Both reads come after the redirect, so a signed-in direct visit does no
  // extra work. The count is cached and comes back null when it cannot be read.
  const [tokenView, agentsDeployed] = await Promise.all([getTokenSurfaceView(userId), getHomeAgentsDeployed()]);
  // The visible questions and the FAQPage JSON-LD are one list. The only
  // sentence on the page about tokens is in it, and only when the token
  // surfaces are on and this viewer is not geo-blocked.
  const faq = homepageFaq(tokenSurfacesVisible(tokenView));

  return (
    <PublicSite variant="home" isSignedIn={userId ? true : undefined} tokenSurfaces={tokenSurfacesVisible(tokenView)}>
      <StructuredData schema={buildHomepageSchema(faq)} />
      <main id="main-content" className={styles.home}>
        <HomeMotion>
          <Hero agentsDeployed={agentsDeployed} />
          <Reach />
          <Fit />
          <Agents />
          <How />
          <OpenSource />
          <Pricing />
          {SHOW_FOUNDER_SECTION ? <Founder /> : null}
          <Faq items={faq} />
          <Closing />
          <StickyCta href={AGENT_LAUNCH_HREF} label={STICKY.cta} note={STICKY.note} />
          <HomeAnalytics />
        </HomeMotion>
      </main>
    </PublicSite>
  );
}
