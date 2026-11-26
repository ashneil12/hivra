/**
 * Deterministic browser coverage for the invitation signup driver. Every
 * request is intercepted before navigation; this never touches Canary, Clerk,
 * or any network. The fixture is Clerk-shaped but deliberately small.
 */
import { expect, test } from '@playwright/test';

import { completeClerkSignupUi } from './first-run-audit/signup';

const EMAIL = 'qa-browser+clerk_test@example.test';
const REDIRECT = '/dashboard/launch?agent=hermes&inference=venice&ref=venice&code=VENICE';

function fixture(autoComplete: boolean): string {
  return `<!doctype html><html><body><script>
    window.Clerk = { client: { signUp: { status: 'missing_requirements', createdSessionId: null } } };
    setTimeout(() => {
      document.body.innerHTML = '<form>' +
        '<input name="emailAddress" value="${EMAIL}" disabled>' +
        '<input name="firstName"><input name="lastName">' +
        '<button class="cl-formButtonPrimary" type="submit">Continue</button>' +
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
    }, 40);
  </script></body></html>`;
}

function invitationStepFixture(): string {
  return `<!doctype html><html><body><script>
    window.Clerk = { client: { signUp: { status: 'missing_requirements', createdSessionId: null } } };
    document.body.innerHTML = '<button type="button">Accept invitation</button>';
    document.querySelector('button').addEventListener('click', () => {
      document.body.innerHTML = '<form><input name="emailAddress" value="${EMAIL}" disabled>' +
        '<button class="cl-formButtonPrimary" type="submit">Continue</button></form>';
      document.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const otp = document.createElement('input');
        otp.setAttribute('data-input-otp', '');
        document.body.innerHTML = '';
        document.body.appendChild(otp);
        otp.addEventListener('input', () => {
          if (otp.value.length === 6) {
            window.history.pushState({}, '', '/dashboard/launch');
            window.Clerk = { user: { id: 'user_invitation_fixture' }, session: { id: 'sess_invitation_fixture' }, client: { signUp: { status: 'complete', createdSessionId: 'sess_invitation_fixture' } } };
          }
        });
      });
    });
  </script></body></html>`;
}

async function installFixture(page: import('@playwright/test').Page, autoComplete = false): Promise<void> {
  await page.route('**/*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: fixture(autoComplete),
  }));
  await page.goto(`https://canary.hermesos.cloud/sign-up?redirect_url=${encodeURIComponent(REDIRECT)}`);
}

async function installInvitationStepFixture(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: invitationStepFixture() }));
  await page.goto('https://canary.hermesos.cloud/sign-up');
}

test.describe('Clerk invitation signup UI driver (offline)', () => {
  test('fills required fields, uses the fixed OTP, and returns the final deep link', async ({ page }) => {
    await installFixture(page);

    const result = await completeClerkSignupUi(page, { email: EMAIL, timeoutMs: 8_000, requireOtpStep: true });

    expect(result).toMatchObject({ userId: 'user_browser_fixture', otpUsed: true });
    const finalUrl = new URL(result.finalUrl);
    expect(`${finalUrl.pathname}${finalUrl.search}`).toBe(REDIRECT);
  });

  test('fails closed if the form completes without proving the OTP step', async ({ page }) => {
    await installFixture(page, true);

    await expect(completeClerkSignupUi(page, { email: EMAIL, timeoutMs: 8_000, requireOtpStep: true }))
      .rejects.toThrow(/without the Clerk test OTP step/);
  });

  test('accepts Clerk invitation acknowledgement before the signup form', async ({ page }) => {
    await installInvitationStepFixture(page);

    const result = await completeClerkSignupUi(page, { email: EMAIL, timeoutMs: 8_000, requireOtpStep: true });

    expect(result).toMatchObject({ userId: 'user_invitation_fixture', otpUsed: true });
  });
});
