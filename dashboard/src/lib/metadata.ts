import type { Metadata } from "next";

import { SITE_URL } from "@/lib/seo-urls";
import { OG_IMAGE, OG_IMAGE_BY_PATH } from "@/lib/og-meta";

const HERMES_SITE_NAME = "Hivra";
const DEFAULT_SOCIAL_IMAGE = {
  ...OG_IMAGE.home,
  url: `${SITE_URL}${OG_IMAGE.home.url}`,
} as const;

type SocialImage = string | {
  url: string;
  width?: number;
  height?: number;
  alt?: string;
  type?: string;
};

interface WebsiteMetadataInput {
  path: string;
  title: string;
  description: string;
  twitterTitle?: string;
  twitterDescription?: string;
  images?: readonly SocialImage[];
}

interface ArticleMetadataInput extends WebsiteMetadataInput {
  publishedTime: string;
  modifiedTime?: string;
  authors?: string[];
}

export function buildAbsoluteSiteUrl(path: string): string {
  if (!path || path === "/") {
    return SITE_URL;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalizedPath, SITE_URL).toString();
}

function defaultSocialImage(path: string): SocialImage {
  return OG_IMAGE_BY_PATH[path] ?? DEFAULT_SOCIAL_IMAGE;
}

function normalizeSocialImages(path: string, images?: readonly SocialImage[]): SocialImage[] {
  const sourceImages = images && images.length > 0 ? images : [defaultSocialImage(path)];

  return sourceImages.map((image) => {
    if (typeof image === "string") {
      return buildAbsoluteSiteUrl(image);
    }

    return {
      ...image,
      url: image.url.startsWith("http") ? image.url : buildAbsoluteSiteUrl(image.url),
    };
  });
}

function toTwitterImages(images: readonly SocialImage[]): string[] {
  return images.map((image) => (typeof image === "string" ? image : image.url));
}

export function buildWebsiteMetadata({
  path,
  title,
  description,
  twitterTitle,
  twitterDescription,
  images,
}: WebsiteMetadataInput): Pick<Metadata, "alternates" | "openGraph" | "twitter"> {
  const canonicalUrl = buildAbsoluteSiteUrl(path);
  const normalizedImages = normalizeSocialImages(path, images);

  return {
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      type: "website",
      locale: "en_US",
      url: canonicalUrl,
      siteName: HERMES_SITE_NAME,
      title,
      description,
      images: normalizedImages,
    },
    twitter: {
      card: "summary_large_image",
      title: twitterTitle ?? title,
      description: twitterDescription ?? description,
      images: toTwitterImages(normalizedImages),
    },
  };
}

export function buildArticleMetadata({
  path,
  title,
  description,
  twitterTitle,
  twitterDescription,
  images,
  publishedTime,
  modifiedTime,
  authors,
}: ArticleMetadataInput): Pick<Metadata, "alternates" | "openGraph" | "twitter"> {
  const canonicalUrl = buildAbsoluteSiteUrl(path);
  const normalizedImages = normalizeSocialImages(path, images);

  return {
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      type: "article",
      locale: "en_US",
      url: canonicalUrl,
      siteName: HERMES_SITE_NAME,
      title,
      description,
      publishedTime,
      modifiedTime,
      authors,
      images: normalizedImages,
    },
    twitter: {
      card: "summary_large_image",
      title: twitterTitle ?? title,
      description: twitterDescription ?? description,
      images: toTwitterImages(normalizedImages),
    },
  };
}
