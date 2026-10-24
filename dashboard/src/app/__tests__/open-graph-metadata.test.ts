import type { Metadata } from 'next';

import { metadata as homeMetadata } from '../page';
import { metadata as downloadMetadata } from '../download/page';
import { generateMetadata as generateTokenomicsMetadata } from '../tokenomics/page';
import { metadata as roadmapMetadata } from '../roadmap/page';
import { generateMetadata as generateTokenMetadata } from '../token/page';
import { metadata as blogIndexMetadata } from '../blog/page';
import { metadata as featuresIndexMetadata } from '../features/page';
import { metadata as compareIndexMetadata } from '../compare/page';
import { buildBlogArticleMetadata } from '@/lib/blog/metadata';
import { generateMetadata as generateFeatureMetadata } from '../features/[slug]/page';
import { generateMetadata as generateCompareMetadata } from '../compare/[slug]/page';

// Both token pages generate their metadata from the $HIVRA phase; dormant here.
let tokenomicsMetadata: Metadata;
let tokenMetadata: Metadata;
beforeAll(async () => {
  tokenomicsMetadata = await generateTokenomicsMetadata();
  tokenMetadata = await generateTokenMetadata();
});

function getObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function getOpenGraphValue(metadataValue: unknown, key: string): unknown {
  return getObject(metadataValue)?.[key];
}

function getTwitterValue(metadataValue: unknown, key: string): unknown {
  return getObject(metadataValue)?.[key];
}

describe('route Open Graph metadata', () => {
  it('words the homepage description as the website pack does, with no keep-running claim and no token', () => {
    // Ash's website pack (20 Oct 2026) minus its "Keep them running when your laptop closes."
    // sentence, which is not true of every run (lib/blog/runtime-facts.ts). The old tests that
    // required "launch Ubuntu, Windows or Omarchy for yourself" here are retired: the pack's
    // description does not name an operating system, and the ones the page names carry their
    // conditions in the page copy, the JSON-LD feature list and llms.txt.
    expect(homeMetadata.description).toBe(
      'Run Claude Code, Codex, Hermes and other AI agents on separate computers. Open-source Hivra, hosted from $9.99 a month or self-hosted.',
    );
    expect(String(homeMetadata.description).length).toBeLessThanOrEqual(160);
    expect(String(homeMetadata.description)).not.toMatch(/keep(?:s)? (?:them )?running|\$HIVRA|\$HermesOS|launching now|preview/i);
    expect(getTwitterValue(homeMetadata.twitter, 'description')).toBe(homeMetadata.description);
    expect(getOpenGraphValue(homeMetadata.openGraph, 'description')).toBe(homeMetadata.description);
  });

  it('keeps the Hermes OS brand bridge on the homepage title, where most search clicks come from', () => {
    // ~75% of hivra.cloud's Search Console clicks (Jun-Sep 2026) were "hermes os" searches.
    // The title is written finished (absoluteTitle), so the layout does not add " | Hivra" after it.
    const title = (homeMetadata.title as { absolute: string }).absolute;
    expect(title).toBe('Hermes OS is now Hivra | Give your AI agent a computer of its own');
    expect(title).toMatch(/^Hermes OS is now Hivra \| /);
    expect(getOpenGraphValue(homeMetadata.openGraph, 'title')).toBe(title);
    expect(getTwitterValue(homeMetadata.twitter, 'title')).toBe(title);
  });

  it('labels the /tokenomics title as proposed and sets its own description', () => {
    expect(tokenomicsMetadata.title).toBe('Proposed $HIVRA tokenomics');
    expect(String(tokenomicsMetadata.description)).toMatch(/proposed migration/);
  });

  it('gives /download its own title and description, not the site defaults', () => {
    expect(downloadMetadata.title).toEqual({ absolute: 'Download Hivra | Desktop Availability' });
    expect(getOpenGraphValue(downloadMetadata.openGraph, 'title')).toBe('Download Hivra | Desktop Availability');
    expect(getTwitterValue(downloadMetadata.twitter, 'title')).toBe('Download Hivra | Desktop Availability');
    expect(downloadMetadata.description).toBe('The Hivra desktop app for macOS is coming soon. Open Hivra in your browser today.');
    expect(String(downloadMetadata.description)).not.toMatch(/Windows/);
  });

  it('keeps the shared website Open Graph defaults on every static route that overrides openGraph metadata', () => {
    // The homepage now carries its own branded dynamic OG card (#public-og-images),
    // so it is asserted separately below — these routes still use the shared default.
    for (const pageMetadata of [
      roadmapMetadata,
      blogIndexMetadata,
      featuresIndexMetadata,
      compareIndexMetadata,
    ]) {
      expect(getOpenGraphValue(pageMetadata.openGraph, 'type')).toBe('website');
      expect(getOpenGraphValue(pageMetadata.openGraph, 'siteName')).toBe('Hivra');
      expect(getOpenGraphValue(pageMetadata.openGraph, 'locale')).toBe('en_US');
      expect(getTwitterValue(pageMetadata.twitter, 'card')).toBe('summary_large_image');
      expect(getTwitterValue(pageMetadata.twitter, 'images')).toContain('https://hivra.cloud/opengraph-image');
    }
  });

  it('gives /token and /tokenomics their own share cards on the real page metadata', () => {
    for (const [pageMetadata, card] of [
      [tokenMetadata, 'https://hivra.cloud/token/opengraph-image'],
      [tokenomicsMetadata, 'https://hivra.cloud/tokenomics/opengraph-image'],
    ] as const) {
      expect(getOpenGraphValue(pageMetadata.openGraph, 'type')).toBe('website');
      expect(getOpenGraphValue(pageMetadata.openGraph, 'siteName')).toBe('Hivra');
      const images = getOpenGraphValue(pageMetadata.openGraph, 'images') as Array<{ url: string }>;
      expect(images.map((image) => image.url)).toEqual([card]);
      expect(getTwitterValue(pageMetadata.twitter, 'card')).toBe('summary_large_image');
      expect(getTwitterValue(pageMetadata.twitter, 'images')).toEqual([card]);
    }
  });

  it('wires the branded dynamic OG card into the homepage Open Graph metadata (#public-og-images)', () => {
    // Homepage keeps the shared website OG shape...
    expect(getOpenGraphValue(homeMetadata.openGraph, 'type')).toBe('website');
    expect(getOpenGraphValue(homeMetadata.openGraph, 'siteName')).toBe('Hivra');
    expect(getOpenGraphValue(homeMetadata.openGraph, 'locale')).toBe('en_US');
    expect(getTwitterValue(homeMetadata.twitter, 'card')).toBe('summary_large_image');
    // ...and its social image uses the same generated /opengraph-image default.
    expect(getTwitterValue(homeMetadata.twitter, 'images')).toContain(
      'https://hivra.cloud/opengraph-image'
    );
  });

  it('keeps the shared website Open Graph defaults on generated feature and comparison route metadata', async () => {
    const featureMetadata = await generateFeatureMetadata({
      params: Promise.resolve({ slug: 'persistent-memory' }),
    });
    const compareMetadata = await generateCompareMetadata({
      params: Promise.resolve({ slug: 'vs-self-hosted' }),
    });

    expect(getOpenGraphValue(featureMetadata.openGraph, 'type')).toBe('website');
    expect(getOpenGraphValue(featureMetadata.openGraph, 'siteName')).toBe('Hivra');
    expect(getOpenGraphValue(featureMetadata.openGraph, 'url')).toBe('https://hivra.cloud/features/persistent-memory');
    expect(getOpenGraphValue(compareMetadata.openGraph, 'type')).toBe('website');
    expect(getOpenGraphValue(compareMetadata.openGraph, 'siteName')).toBe('Hivra');
    expect(getOpenGraphValue(compareMetadata.openGraph, 'url')).toBe('https://hivra.cloud/compare/vs-self-hosted');
    expect(getTwitterValue(featureMetadata.twitter, 'images')).toContain('https://hivra.cloud/opengraph-image');
    expect(getTwitterValue(compareMetadata.twitter, 'images')).toContain('https://hivra.cloud/opengraph-image');
  });

  it('keeps the article Open Graph shape and points blog articles at their own generated card', async () => {
    const articleMetadata = buildBlogArticleMetadata('what-is-hermes-agent');

    expect(getOpenGraphValue(articleMetadata.openGraph, 'type')).toBe('article');
    expect(getOpenGraphValue(articleMetadata.openGraph, 'siteName')).toBe('Hivra');
    expect(getOpenGraphValue(articleMetadata.openGraph, 'locale')).toBe('en_US');
    expect(getOpenGraphValue(articleMetadata.openGraph, 'url')).toBe('https://hivra.cloud/blog/what-is-hermes-agent');
    expect(getTwitterValue(articleMetadata.twitter, 'card')).toBe('summary_large_image');
    expect(getTwitterValue(articleMetadata.twitter, 'images')).toEqual(['https://hivra.cloud/blog/what-is-hermes-agent/opengraph-image']);
  });
});
