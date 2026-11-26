import { expect, test } from '@playwright/test';
import { establishAuditSession } from './first-run-audit/session';

const origin = 'https://canary.hermesos.cloud';
const fixtureEmail = 'browser-fixture+clerk_test@example.test';

test('standing audit auth uses only Clerk sign-in and verifies the dashboard session', async ({ browser }) => {
  const previous = process.env.HIVRA_LIVE_AUDIT_AUTH;
  process.env.HIVRA_LIVE_AUDIT_AUTH = 'clerk-test-otp';
  const paths: string[] = [];
  try {
    const { context, userId } = await establishAuditSession(browser, {
      baseUrl: origin,
      email: fixtureEmail,
      onContext: async (context) => { await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/favicon.ico') return route.fulfill({ status: 404 });
        paths.push(url.pathname);
        if (url.pathname === '/sign-in') {
          return route.fulfill({ contentType: 'text/html', body: `
            <script>
              window.Clerk = {
                loaded: true,
                client: { signIn: {
                  async create({ identifier }) {
                    if (identifier !== ${JSON.stringify(fixtureEmail)}) throw Error('wrong fixture');
                    let prepared = false;
                    return {
                      supportedFirstFactors: [{ strategy: 'email_code', emailAddressId: 'fixture' }],
                      async prepareFirstFactor({ strategy, emailAddressId }) {
                        prepared = strategy === 'email_code' && emailAddressId === 'fixture';
                      },
                      async attemptFirstFactor({ strategy, code }) {
                        if (!prepared || strategy !== 'email_code' || code !== '424242') throw Error('wrong factor');
                        return { createdSessionId: 'fixture-session' };
                      },
                    };
                  },
                } },
                async setActive({ session }) {
                  if (session !== 'fixture-session') throw Error('wrong session');
                  sessionStorage.setItem('signed-in', 'yes');
                }
              };
            </script>` });
        }
        if (url.pathname === '/dashboard') {
          return route.fulfill({ contentType: 'text/html', body: `
            <script>
              if (sessionStorage.getItem('signed-in') === 'yes') {
                window.Clerk = { loaded: true, user: { id: 'fixture-user' } };
              }
            </script>` });
        }
        return route.abort();
      }); },
    });
    try {
      expect(userId).toBe('fixture-user');
      expect(paths).toEqual(['/sign-in', '/dashboard']);
    } finally {
      await context.close();
    }
  } finally {
    if (previous === undefined) delete process.env.HIVRA_LIVE_AUDIT_AUTH;
    else process.env.HIVRA_LIVE_AUDIT_AUTH = previous;
  }
});
