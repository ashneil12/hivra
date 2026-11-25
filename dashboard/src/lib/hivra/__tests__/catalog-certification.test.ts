import { isOpenHandsUsageConsent } from '../../../../e2e/launch-sweep/chat';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('OpenHands first-run consent', () => {
  test('recognizes the consent screen that blocks the composer', () => {
    expect(isOpenHandsUsageConsent(
      'Help improve OpenHands We collect anonymous usage data to improve the product. Confirm',
    )).toBe(true);
  });

  test('does not treat unrelated setup copy as OpenHands consent', () => {
    expect(isOpenHandsUsageConsent('Choose a workspace to start')).toBe(false);
  });
});

describe('universal catalog launch admission', () => {
  test('routes catalog manifests through durable launch operations', () => {
    const source = readFileSync(path.resolve(__dirname, '../launch-agent.ts'), 'utf8');
    expect(source).toMatch(
      /const launchOperations = .*Boolean\(catalogManifest\)/s,
    );
  });
});
