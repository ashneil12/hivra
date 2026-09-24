import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import PublicSite from "@/components/public-site/PublicSite";
import styles from "@/components/landing/home.module.css";
import StructuredData from "@/components/StructuredData";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { OG_IMAGE } from "@/lib/og-meta";
import { SITE_URL } from "@/lib/seo-urls";
import { LOCALE_COOKIE_NAME, resolveRequestLocale } from "@/lib/i18n";

import HeroSection from "@/components/landing/HeroSection";
import TickerStrip from "@/components/landing/TickerStrip";
import ComputerScene from "@/components/landing/ComputerScene";
import ComputersSection from "@/components/landing/ComputersSection";
import HostingSection from "@/components/landing/HostingSection";
import { HOMEPAGE_FAQ } from "@/components/landing/public-home-content";
import AgentsDeployedStat from "@/components/landing/AgentsDeployedStat";
import LaunchSection from "@/components/landing/LaunchSection";
import OpenSourceSection from "@/components/landing/OpenSourceSection";
import ChooseAgentSection from "@/components/landing/ChooseAgentSection";
import DashboardShowcaseSection from "@/components/landing/DashboardShowcaseSection";
import PricingSection from "@/components/landing/PricingSection";
import WhatsComingSection from "@/components/landing/WhatsComingSection";
import FounderSection from "@/components/landing/FounderSection";
import FAQSection from "@/components/landing/FAQSection";

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
      // Official profiles — keep in sync with twitter.site in layout.tsx.
      sameAs: ["https://x.com/HivraOS", "https://github.com/ashneil12/hivra"],
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
      offers: {
        "@type": "Offer",
        name: "Free platform with your own infrastructure",
        price: "0",
        priceCurrency: "USD",
        description: "Use Hivra with your own server or cloud. Hosted compute and model-provider usage are paid separately.",
        url: `${SITE_URL}/#pricing`,
      },
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

async function getLandingLocale(explicitLocale: string | null, headerStore: Pick<Headers, "get">) {
  const cookieStore = await cookies();
  return resolveRequestLocale({
    explicitLocale,
    cookieLocale: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
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

export default async function LandingPage({
  searchParams,
}: {
  searchParams?: Promise<{ lang?: string | string[]; locale?: string | string[] }>;
}) {
  const { userId } = await auth();
  const resolvedSearchParams = await searchParams;
  const explicitLocale =
    typeof resolvedSearchParams?.lang === "string"
      ? resolvedSearchParams.lang
      : typeof resolvedSearchParams?.locale === "string"
        ? resolvedSearchParams.locale
        : null;
  const headerStore = await headers();
  const locale = await getLandingLocale(explicitLocale, headerStore);

  if (userId && !isSameSiteNavigation(headerStore)) {
    redirect("/dashboard");
  }

  return (
    <LocaleProvider initialLocale={locale}>
      {/* No ClerkProvider refreshes the session here: an expired token reads as
          signed out, so leave that case to the header's session hint. */}
      <PublicSite variant="home" isSignedIn={userId ? true : undefined}>
        <StructuredData schema={homepageSchema} />
        <main id="main-content" className={styles.home}>
          <HeroSection agentsCounter={<ComputerScene />} liveStat={<AgentsDeployedStat />} />
          <TickerStrip />
          <LaunchSection agents={<ChooseAgentSection embedded />} computers={<ComputersSection embedded />} />
          <DashboardShowcaseSection />
          <HostingSection />
          <div className={styles.pricingWrap}><PricingSection /></div>
          <OpenSourceSection />
          <div className={styles.comingWrap}><WhatsComingSection /></div>
          <FounderSection />
          <FAQSection />
        </main>
      </PublicSite>
    </LocaleProvider>
  );
}
