import type { Page } from '@playwright/test';
import { proveAppOpen } from '../e2e/launch-sweep/app-open';

jest.mock('../e2e/first-run-audit/instances', () => ({
  sleep: async (ms: number) => { jest.advanceTimersByTime(ms); },
}));

function appPage(text: string, url = 'https://box.example.test/') {
  const frame = { url: () => url, evaluate: async () => text };
  const handle = { contentFrame: async () => frame };
  const locator = { first: () => locator, elementHandle: async () => handle };
  return { locator: () => locator } as unknown as Page;
}

const dufs = { profileId: 'dufs', tile: 'Dufs', kind: 'agent', proof: 'app-open' } as const;
const chroma = { ...dufs, profileId: 'chroma', tile: 'Chroma' } as const;

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('accepts the Dufs file browser when its new persistent folder is empty', async () => {
  await expect(proveAppOpen(appPage('  Empty\n folder  '), dufs, 1000)).resolves.toMatchObject({
    surface: 'Dufs web app',
    textSample: 'Empty folder',
  });
});

it('does not treat empty or short error iframe content as Dufs', async () => {
  for (const body of ['', 'Not Found', 'Empty folder — bad gateway']) {
    await expect(proveAppOpen(appPage(body), dufs, 1000)).rejects.toMatchObject({ category: 'product' });
  }
});

it('does not accept the Dufs empty state for other apps or on loopback', async () => {
  await expect(proveAppOpen(appPage('Empty folder'), { ...dufs, profileId: 'other', tile: 'Other' }, 1000))
    .rejects.toMatchObject({ category: 'product' });
  await expect(proveAppOpen(appPage('Empty folder', 'http://127.0.0.1:5000/'), dufs, 1000))
    .rejects.toMatchObject({ category: 'product' });
});

it('requires the Chroma API reference to render its operations', async () => {
  const docs = 'chroma-frontend System GET /api/v2/heartbeat Heartbeat';
  await expect(proveAppOpen(appPage(docs, 'https://box.example.test/docs/'), chroma, 1000))
    .resolves.toMatchObject({ surface: 'Chroma web app', textSample: docs });
  await expect(proveAppOpen(appPage(docs), chroma, 1000))
    .rejects.toMatchObject({ stage: 'open', category: 'product' });
  await expect(proveAppOpen(appPage('Failed to load API definition.', 'https://box.example.test/docs/'), chroma, 1000))
    .rejects.toMatchObject({ stage: 'open', category: 'product' });
});
