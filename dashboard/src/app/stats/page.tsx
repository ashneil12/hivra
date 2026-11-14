import PublicSite from "@/components/public-site/PublicSite";
import styles from "../../components/public-editorial/secondary-site.module.css";
import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { cookies, headers } from "next/headers";

import StructuredData from "@/components/StructuredData";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { LOCALE_COOKIE_NAME, resolveRequestLocale } from "@/lib/i18n";
import { getTokenSurfaceView } from "@/lib/compliance/token-surface-view";

import StatsPageContent from "@/components/stats/StatsPageContent.client";
import { getAgentsDeployedStats } from "@/lib/agents-deployed-stats";
import { getPublicStats, type PublicStats } from "@/lib/public-stats";
import { log } from "@/lib/logger";

const PATH = "/stats";
const TITLE = "Hivra Statistics | Platform Activity";
const DESCRIPTION =
  "Live count of every agent and computer launched on Hivra. Updated as people launch.";

export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: PATH, title: TITLE, description: DESCRIPTION }),
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

async function loadStats(): Promise<
  [Awaited<ReturnType<typeof getAgentsDeployedStats>> | null, PublicStats | null]
> {
  try {
    return await Promise.all([
      getAgentsDeployedStats({ series: true, firstDeploy: true }),
      getPublicStats(),
    ]);
  } catch (err) {
    log.error("/stats initial fetch failed", err as Error, {
      source: "stats-page",
      route: "/stats",
    });
    return [null, null];
  }
}

export default async function StatsPage() {
  const { userId } = await auth();
  const [locale, tokenView, [initial, platform]] = await Promise.all([
    getLandingLocale(),
    getTokenSurfaceView(userId),
    loadStats(),
  ]);

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
            tokenView={tokenView}
          />
        </div>
      </PublicSite>
    </LocaleProvider>
  );
}
