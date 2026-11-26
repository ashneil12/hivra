/**
 * Deterministic browser coverage for the invitation signup driver. Every
 * request is intercepted before navigation; this never touches Canary, Clerk,
 * or any network. The fixture is Clerk-shaped but deliberately small.
 */
import { expect, test } from '@playwright/test';

import { completeClerkSignupUi } from './first-run-audit/signup';

const EMAIL = 'qa-browser+clerk_test@example.test';
const REDIRECT = '/dashboard/launch?agent=hermes&inference=venice&ref=venice&code=VENICE';

type FixtureOptions = {
  autoComplete?: boolean;
  invitationButtonLabel?: string;
  bareContinueButton?: boolean;
};

function fixture({ autoComplete = false, invitationButtonLabel, bareContinueButton = false }: FixtureOptions = {}): string {
  const button = bareContinueButton
    ? '<button>Continue</button>'
    : '<button class="cl-formButtonPrimary" type="submit">Continue</button>';
  return `<!doctype html><html><body><script>
    window.Clerk = { client: { signUp: { status: 'missing_requirements', createdSessionId: null } } };
    const mountForm = () => {
      document.body.innerHTML = '<form>' +
        '<input name="emailAddress" value="${EMAIL}" disabled>' +
        '<input name="firstName"><input name="lastName">' +
        '${button}' +
      '</form>';
      document.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        document.body.innerHTML = '<input data-input-otp autocomplete="one-time-code" maxlength="6" style="width:120px;height:20px;opacity:0">';
        const otp = document.querySelector('input[data-input-otp]');
        const complete = () => {
          window.history.pushState({}, '', '${REDIRECT}');
          window.Clerk = {
            user: { id: 'user_browser_fixture' },
            session: { id: 'sess_browser_fixture' },
            client: { signUp: { status: 'complete', createdSessionId: 'sess_browser_fixture' } },
          };
          document.body.innerHTML = '<h1>Review and launch Hermes 1</h1>';
        };
        otp.addEventListener('input', () => { if (otp.value.length === 6) setTimeout(complete, 100); });
        ${autoComplete ? 'setTimeout(complete, 100);' : ''}
      });
      ${bareContinueButton ? `document.querySelector('button').addEventListener('click', () => {
        document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
      });` : ''}
    };
    ${invitationButtonLabel ? `
      document.body.innerHTML = '<button>${invitationButtonLabel}</button>';
      document.querySelector('button').addEventListener('click', mountForm);
    ` : 'setTimeout(mountForm, 40);'}
  </script></body></html>`;
}

async function installFixture(page: import('@playwright/test').Page, options: FixtureOptions = {}): Promise<void> {
  await page.route('**/*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: fixture(options),
  }));
  await page.goto(`https://canary.hermesos.cloud/sign-up?redirect_url=${encodeURIComponent(REDIRECT)}`);
}

test.describe('Clerk invitation signup UI driver (offline)', () => {
  test('fills required fields, uses the fixed OTP, and returns the final deep link', async ({ page }) => {
    await installFixture(page);

    const result = await completeClerkSignupUi(page, { email: EMAIL, timeoutMs: 8_000, requireOtpStep: true });

    expect(result).toMatchObject({ userId: 'user_browser_fixture', otpUsed: true });
    const finalUrl = new URL(result.finalUrl);
    expect(`${finalUrl.pathname}${finalUrl.search}`).toBe(REDIRECT);
  });

  test('accepts an invitation acknowledgement before the signup form mounts', async ({ page }) => {
    await installFixture(page, { invitationButtonLabel: 'Accept invitation' });

    const result = await completeClerkSignupUi(page, { email: EMAIL, timeoutMs: 8_000, requireOtpStep: true });

    expect(result).toMatchObject({ userId: 'user_browser_fixture', otpUsed: true });
  });

  test('uses a continue control that relies on the browser default submit type', async ({ page }) => {
    await installFixture(page, { bareContinueButton: true });

    const result = await completeClerkSignupUi(page, { email: EMAIL, timeoutMs: 8_000, requireOtpStep: true });

    expect(result).toMatchObject({ userId: 'user_browser_fixture', otpUsed: true });
  });

  test('fails closed if the form completes without proving the OTP step', async ({ page }) => {
    await installFixture(page, { autoComplete: true });

    await expect(completeClerkSignupUi(page, { email: EMAIL, timeoutMs: 8_000, requireOtpStep: true }))
      .rejects.toThrow(/without the Clerk test OTP step/);
  });
});
