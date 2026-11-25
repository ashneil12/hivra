import { isOpenHandsUsageConsent } from '../../../../e2e/launch-sweep/chat';

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
