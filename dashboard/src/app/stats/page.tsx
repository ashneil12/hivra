import PublicSite from "@/components/public-site/PublicSite";
import styles from "../../components/public-editorial/secondary-site.module.css";
import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { cookies, headers } from "next/headers";

import StructuredData from "@/components/StructuredData";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { LOCALE_COOKIE_NAME, resolveRequestLocale } from "@/lib/i18n";

import StatsPageContent from "@/components/stats/StatsPageContent.client";
import { getAgentsDeployedStats } from "@/lib/agents-deployed-stats";
import { getPublicStats, type PublicStats } from "@/lib/public-stats";
import { log } from "@/lib/logger";

const PATH = "/stats";

export const metadata: Metadata = {
  title: "Agents deployed — Hivra live counter",
  description:
    "Live count of every agent successfully deployed on Hivra. Updated as people deploy.",
  ...buildWebsiteMetadata({
    path: PATH,
    title: "Agents deployed — Hivra live counter",
    description:
      "Live count of every agent successfully deployed on Hivra. Updated as people deploy.",
  }),
};

const schema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Stats", item: `${SITE_URL}${PATH}` },
      ],
    },
  ],
};

async function getLandingLocale() {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveRequestLocale({
    cookieLocale: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
}

export default async function StatsPage() {
  const { userId } = await auth();
  const locale = await getLandingLocale();

  let initial: Awaited<ReturnType<typeof getAgentsDeployedStats>> | null = null;
  let platform: PublicStats | null = null;
  try {
    [initial, platform] = await Promise.all([
      getAgentsDeployedStats({ series: true, firstDeploy: true }),
      getPublicStats(),
    ]);
  } catch (err) {
    log.error("/stats initial fetch failed", err as Error, {
      source: "stats-page",
      route: "/stats",
    });
  }

  return (
    <LocaleProvider initialLocale={locale}>
      <PublicSite className={styles.livePage} data-page="stats" isSignedIn={Boolean(userId)}>
        <StructuredData schema={schema} />


        <div className={styles.liveContent}>
          <StatsPageContent
            initial={
              initial
                ? {
                    total: initial.total,
                    last24h: initial.last24h,
                    last7d: initial.last7d,
                    series: initial.series,
                    generatedAt: initial.generatedAt,
                  }
                : null
            }
            firstDeployIso={initial?.firstDeployAt ?? null}
            platform={platform}
          />
        </div>

      </PublicSite>
    </LocaleProvider>
  );
}
