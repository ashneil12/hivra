import { metadata as homeMetadata } from '../page';
import { metadata as downloadMetadata } from '../download/page';
import { metadata as roadmapMetadata } from '../roadmap/page';
import { metadata as tokenMetadata } from '../token/page';
import { metadata as blogIndexMetadata } from '../blog/page';
import { metadata as featuresIndexMetadata } from '../features/page';
import { metadata as compareIndexMetadata } from '../compare/page';
import { buildBlogArticleMetadata } from '@/lib/blog/metadata';
import { generateMetadata as generateFeatureMetadata } from '../features/[slug]/page';
import { generateMetadata as generateCompareMetadata } from '../compare/[slug]/page';

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
  it('reflects the current homepage computer choices in metadata', () => {
    expect(homeMetadata.description).toContain('Launch Ubuntu, with Windows and Omarchy in private preview');
    expect(String(homeMetadata.description)).not.toMatch(/launching now/i);
    // Windows and Omarchy are private-preview templates in the computer catalog, not generally available.
    expect(String(homeMetadata.description)).not.toContain('Launch Ubuntu, Windows or Omarchy');
    expect(getTwitterValue(homeMetadata.twitter, 'description')).toContain('Launch Ubuntu, with Windows and Omarchy in private preview');
  });

  it('gives /download its own title and description, not the site defaults', () => {
    expect(downloadMetadata.title).toBe('Download Hivra');
    expect(downloadMetadata.description).toBe('The Hivra desktop app for macOS is coming soon. Open Hivra in your browser today.');
    expect(String(downloadMetadata.description)).not.toMatch(/Windows/);
  });

  it('keeps the shared website Open Graph defaults on every static route that overrides openGraph metadata', () => {
    // The homepage now carries its own branded dynamic OG card (#public-og-images),
    // so it is asserted separately below — these routes still use the shared default.
    for (const pageMetadata of [
      roadmapMetadata,
      tokenMetadata,
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

  it('keeps the shared article Open Graph defaults on generated blog article metadata', async () => {
    const articleMetadata = buildBlogArticleMetadata('what-is-hermes-agent');

    expect(getOpenGraphValue(articleMetadata.openGraph, 'type')).toBe('article');
    expect(getOpenGraphValue(articleMetadata.openGraph, 'siteName')).toBe('Hivra');
    expect(getOpenGraphValue(articleMetadata.openGraph, 'locale')).toBe('en_US');
    expect(getOpenGraphValue(articleMetadata.openGraph, 'url')).toBe('https://hivra.cloud/blog/what-is-hermes-agent');
    expect(getTwitterValue(articleMetadata.twitter, 'card')).toBe('summary_large_image');
    expect(getTwitterValue(articleMetadata.twitter, 'images')).toContain('https://hivra.cloud/opengraph-image');
  });
});
