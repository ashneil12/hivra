import type { Metadata, Viewport } from "next";

import { DeferredGTM } from "@/components/DeferredGTM";
import { Outfit, Playfair_Display, Space_Mono, Space_Grotesk } from "next/font/google";
import { cookies, headers } from "next/headers";
import Script from "next/script";
import { ThemeProvider } from "@/components/theme-provider";
import { PreloadHandler } from "@/components/PreloadHandler";
import { OpsTelemetryProvider } from "./providers/OpsTelemetryProvider";
import { PostHogProvider } from "./providers/PostHogProvider";
import { CookieConsentBanner } from "@/components/consent/CookieConsentBanner";
import { ServiceWorkerRegistration } from "@/components/pwa/ServiceWorkerRegistration";
import { HERMES_RUNTIME_CONFIG_BOOTSTRAP } from "@/lib/client/runtime-config-bootstrap";
import { LOCALE_COOKIE_NAME, localeToHtmlLang, resolveRequestLocale } from "@/lib/i18n";
import { SITE_URL } from "@/lib/seo-urls";
import { OG_IMAGE } from "@/lib/og-meta";
import { isLocalAuthMode } from "@/lib/self-host/config";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
});

const spaceMono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-mono",
});

// Hivra brand display typeface — technical, gridded, used for landing headlines.
const spaceGrotesk = Space_Grotesk({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-grotesk",
});

const GOOGLE_ANALYTICS_ID =
  process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID ||
  process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ||
  "G-ML3NFRHMYF";
const CLIENT_RELEASE_FINGERPRINT =
  process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || undefined;

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f0e8" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a18" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: "Hivra",
  title: {
    default: "Hivra | A computer for you and your agents",
    template: "%s | Hivra",
  },
  description:
    "Launch an agent on a computer of its own, or start with a computer and use it yourself. Use Hivra Cloud, your own infrastructure or self-hosting, with your own model key.",
  keywords: [
    "hivra",
    "hermesos",
    "hermes os",
    "hermes agent os",
    "hermes agent hosting",
    "managed ai agent",
    "deploy hermes agent",
    "persistent ai agent cloud",
    "ai agent hosting",
    "hermes nous research",
    "openclaw alternative",
    "ai agent without docker",
    "autonomous ai agent hosting",
    "self host hermes agent",
    "how to self host openclaw",
    "ai agent vps hosting",
    "hermes agent telegram",
    "one click ai agent deploy",
  ],
  authors: [{ name: "Hivra", url: SITE_URL }],
  creator: "Hivra",
  publisher: "Hivra",
  category: "technology",
  formatDetection: {
    telephone: false,
    address: false,
    email: false,
  },
  appleWebApp: {
    title: "Hivra",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: "Hivra",
    title: "Hivra | A computer for you and your agents",
    description:
      "Launch an agent on a computer of its own, or start with a computer and use it yourself. Use Hivra Cloud, your own infrastructure or self-hosting, with your own model key.",
    images: [
      {
        url: `${SITE_URL}${OG_IMAGE.home.url}`,
        width: 1200,
        height: 630,
        alt: "Hivra: a computer for you and your agents.",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@HivraOS",
    creator: "@HivraOS",
    title: "Hivra | A computer for you and your agents",
    description:
      "Launch an agent on a computer of its own, or start with a computer and use it yourself. Use Hivra Cloud, your own infrastructure or self-hosting, with your own model key.",
    images: [`${SITE_URL}${OG_IMAGE.home.url}`],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: SITE_URL,
  },
};

async function getRootLocale() {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveRequestLocale({
    cookieLocale: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getRootLocale();
  const selfHosted = isLocalAuthMode();

  return (
    <html lang={localeToHtmlLang(locale)} data-scroll-behavior="smooth" suppressHydrationWarning className={`${outfit.variable} ${playfair.variable} ${spaceMono.variable} ${spaceGrotesk.variable}`}>
      <head>
        {!selfHosted ? (
          <>
            <link rel="preconnect" href="https://clerk.hermesos.cloud" crossOrigin="anonymous" />
            <link rel="dns-prefetch" href="https://clerk.hermesos.cloud" />
          </>
        ) : null}
      </head>
      <body suppressHydrationWarning className="antialiased bg-[var(--vellum-bg)] text-[var(--ink-black)] preload">
        <Script
          id="hermes-runtime-config-bootstrap"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: HERMES_RUNTIME_CONFIG_BOOTSTRAP }}
        />
        {/* Registered from the root layout so the PWA offline shell works on
            public, signed-out routes too — not only inside the authenticated
            dashboard shell. Renders null; safe above the provider tree. */}
        <ServiceWorkerRegistration />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <PreloadHandler />
          <div className="vellum-texture"></div>
          {selfHosted ? children : (
            <PostHogProvider>
              <OpsTelemetryProvider releaseFingerprint={CLIENT_RELEASE_FINGERPRINT}>
                {children}
              </OpsTelemetryProvider>
              <CookieConsentBanner />
            </PostHogProvider>
          )}
        </ThemeProvider>
        {!selfHosted ? <DeferredGTM gtmId="GTM-T6GPHP4N" gaId={GOOGLE_ANALYTICS_ID} /> : null}
      </body>
    </html>
  );
}
