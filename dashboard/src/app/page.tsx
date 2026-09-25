import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import PublicSite from "@/components/public-site/PublicSite";
import StructuredData from "@/components/StructuredData";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { OG_IMAGE } from "@/lib/og-meta";
import { officialProfileLinks } from "@/lib/public-project-links";
import { SITE_URL } from "@/lib/seo-urls";
import { ENTRY_PLAN_PRICE, LARGER_PLAN_PRICE } from "@/lib/blog/plan-facts";
import { HOSTED_SIZES } from "@/app/pricing/pricing-content";

import { HomeMotion } from "@/components/landing/home/motion";
import Hero from "@/components/landing/home/Hero";
import Reach from "@/components/landing/home/Reach";
import Agents from "@/components/landing/home/Agents";
import How from "@/components/landing/home/How";
import OpenSource from "@/components/landing/home/OpenSource";
import Pricing from "@/components/landing/home/Pricing";
import Founder from "@/components/landing/home/Founder";
import Faq from "@/components/landing/home/Faq";
import Closing from "@/components/landing/home/Closing";
import StickyCta from "@/components/landing/home/StickyCta";
import HomeAnalytics from "@/components/landing/home/HomeAnalytics";
import { AGENT_LAUNCH_HREF, HOMEPAGE_FAQ, STICKY } from "@/components/landing/home/content";
import styles from "@/components/landing/home/home.module.css";

// "Hermes OS" stays at the front of the homepage title and description: in
// Search Console (Jun-Sep 2026) about three quarters of hivra.cloud's clicks came
// from "hermes os" / "hermes agent os" / "hermesos" searches landing here, and
// the retired site's "Hermes OS is now Hivra" title earned 20-26% CTR at
// positions 1-3. Dropping the old name at the cutover would put that at risk.
const homepageTitle = "Hermes OS is now Hivra | A computer for you and your agents";
const homepageDescription = "Hermes OS is now Hivra. Launch Ubuntu, with Windows and Omarchy in private preview. Run Claude Code, Codex, Hermes and more on a computer of their own.";

export const metadata: Metadata = {
  title: homepageTitle,
  description: homepageDescription,
  ...buildWebsiteMetadata({
    path: "/",
    title: homepageTitle,
    description: homepageDescription,
    twitterTitle: homepageTitle,
    twitterDescription: homepageDescription,
    images: [OG_IMAGE.home],
  }),
};

const homepageSchema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "Hivra",
      alternateName: ["HermesOS", "Hermes Agent OS"],
      url: SITE_URL,
      logo: {
        "@type": "ImageObject",
        url: `${SITE_URL}/brand/hivra-token-512.png`,
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
      alternateName: "HermesOS",
      description:
        homepageDescription,
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#softwareapp`,
      name: "Hivra",
      alternateName: "HermesOS",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Ubuntu",
      description:
        homepageDescription,
      url: SITE_URL,
      offers: [
        {
          "@type": "Offer",
          name: "Self-host Hivra",
          price: "0",
          priceCurrency: "USD",
          description: "Run the platform yourself from the Apache 2.0 source. You provide the server and pay for it and your model usage.",
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
        "Ubuntu, with Windows and Omarchy in private preview",
        "Terminal and graphical interfaces",
        "Persistent files, tools and settings",
        "Use Hivra Cloud or your own infrastructure",
        "Bring your own model API key",
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: HOMEPAGE_FAQ.map(({ q, a }) => ({
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

  return (
    <PublicSite variant="home" isSignedIn={userId ? true : undefined}>
      <StructuredData schema={homepageSchema} />
      <main id="main-content" className={styles.home}>
        <HomeMotion>
          <Hero />
          <Reach />
          <Agents />
          <How />
          <OpenSource />
          <Pricing />
          <Founder />
          <Faq />
          <Closing />
          <StickyCta href={AGENT_LAUNCH_HREF} label={STICKY.cta} note={STICKY.note} />
          <HomeAnalytics />
        </HomeMotion>
      </main>
    </PublicSite>
  );
}
