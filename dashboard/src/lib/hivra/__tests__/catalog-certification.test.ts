import type { Frame } from '@playwright/test';

import {
  completeConsolePassword,
  isOpenHandsUsageConsent,
  type SweepConsolePasswordState,
} from '../../../../e2e/launch-sweep/chat';

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

function fakePasswordFrame(text: string, fieldCount: number) {
  const fills: string[] = [];
  let clicks = 0;
  const field = {
    isVisible: async () => true,
    fill: async (value: string) => {
      fills.push(value);
    },
    press: async () => undefined,
  };
  const fields = {
    count: async () => fieldCount,
    nth: () => field,
    first: () => field,
    last: () => field,
  };
  const submit = {
    isVisible: async () => true,
    click: async () => {
      clicks += 1;
    },
  };
  const frame = {
    locator: (selector: string) => {
      if (selector === 'input[type="password"]:not([readonly]):not([disabled])') return fields;
      throw new Error(`unexpected selector ${selector}`);
    },
    evaluate: async () => text,
    getByRole: () => ({ first: () => submit }),
  } as unknown as Frame;
  return { frame, fills, clicks: () => clicks };
}

describe('agent console password completion', () => {
  test('reuses the password chosen during setup when the agent then asks for sign-in', async () => {
    const state: SweepConsolePasswordState = {};
    const setup = fakePasswordFrame('Set password Choose the password that protects this console Password Confirm password', 2);

    await expect(completeConsolePassword(setup.frame, state)).resolves.toBe(true);

    expect(setup.fills).toHaveLength(2);
    const chosen = setup.fills[0];
    expect(chosen).toMatch(/^Sweep-.+!/);
    expect(setup.fills[1]).toBe(chosen);
    expect(setup.clicks()).toBe(1);

    const login = fakePasswordFrame('Sign in Enter the dashboard password to continue. Password Sign in', 1);
    await expect(completeConsolePassword(login.frame, state)).resolves.toBe(true);

    expect(login.fills).toEqual([chosen]);
    expect(login.clicks()).toBe(1);
  });
});
