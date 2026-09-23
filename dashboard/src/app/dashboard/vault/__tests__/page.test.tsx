/**
 * @jest-environment jsdom
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import VaultPage from '../page';
import { copyTextToClipboard } from '@/lib/client/clipboard';
import '@testing-library/jest-dom';

jest.mock('framer-motion', () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...rest }, ref) => (
      <div ref={ref} {...rest}>
        {children}
      </div>
    )
  );
  MotionDiv.displayName = 'MotionDiv';

  const MotionSection = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
    ({ children, ...rest }, ref) => (
      <section ref={ref} {...rest}>
        {children}
      </section>
    )
  );
  MotionSection.displayName = 'MotionSection';

  const MotionHeader = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
    ({ children, ...rest }, ref) => (
      <header ref={ref} {...rest}>
        {children}
      </header>
    )
  );
  MotionHeader.displayName = 'MotionHeader';

  return {
    motion: {
      div: MotionDiv,
      header: MotionHeader,
      section: MotionSection,
    },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  };
});

jest.mock('@/lib/client/clipboard', () => ({
  copyTextToClipboard: jest.fn(),
}));

const defaultFetchImplementation = (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/api/vault')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] })
    });
  }

  if (url.includes('/api/instances?summary=true')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: [{ id: 'inst-1', name: 'Agent One', provider: 'openrouter', status: 'running', config: { model: 'openai/gpt-5.4' } }]
      })
    });
  }

  if (url.includes('/api/instances/inst-1/profiles')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: [
          { name: 'default', display_name: 'Agent One' },
          { name: 'strategy', display_name: 'Strategist' },
        ],
      })
    });
  }

  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: true, data: {} })
  });
};

describe('Vault Page', () => {
  const mockedCopyTextToClipboard = copyTextToClipboard as jest.MockedFunction<
    typeof copyTextToClipboard
  >;

  beforeEach(() => {
    Object.defineProperty(global, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn(defaultFetchImplementation),
    });
    mockedCopyTextToClipboard.mockResolvedValue(true);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('renders the Global Vault keys header', async () => {
    // Basic safety test rendering check handling async effects gracefully
    render(<VaultPage />);
    const heading = await screen.findByText(/Global Keys/i);
    expect(heading).toBeInTheDocument();
  });

  it('calls the page API keys so it cannot be mistaken for the future Vault product', async () => {
    render(<VaultPage />);
    expect(await screen.findByRole('heading', { level: 2, name: /^API\s*keys\s*\.$/ })).toBeInTheDocument();
    expect(screen.queryByText(/API Key Vault/i)).not.toBeInTheDocument();
  });

  it('renders the Bind Keys to Active Instances header', async () => {
    render(<VaultPage />);
    const heading = await screen.findByText(/Bind Keys to Core Instance/i);
    expect(heading).toBeInTheDocument();
  });

  it('shows Codex as an automated Vault auth option', async () => {
    render(<VaultPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add new key/i }));
    fireEvent.click(screen.getByLabelText(/automated device auth/i));
    fireEvent.click(screen.getByRole('radio', { name: /chatgpt plus \(codex\)/i }));

    expect(await screen.findByText(/chatgpt plus \(codex\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect codex/i })).toBeInTheDocument();
  });

  it('uses a custom modal picker for auth target selection', async () => {
    render(<VaultPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add new key/i }));
    fireEvent.click(screen.getByLabelText(/automated device auth/i));

    fireEvent.click(screen.getByRole('button', { name: /host instance to run auth flow/i }));
    const hostDialog = await screen.findByRole('dialog', { name: /choose host instance/i });
    expect(within(hostDialog).getByRole('button', { name: /agent one/i })).toBeInTheDocument();
    fireEvent.click(within(hostDialog).getByRole('button', { name: /agent one/i }));

    fireEvent.click(screen.getByRole('button', { name: /target agent profile/i }));
    const profileDialog = await screen.findByRole('dialog', { name: /choose target agent profile/i });
    fireEvent.click(within(profileDialog).getByRole('button', { name: /strategist \(strategy\)/i }));

    expect(screen.getByRole('button', { name: /target agent profile/i })).toHaveTextContent(/strategist \(strategy\)/i);
  });

  it('loads sub-agent profiles for Codex auth targets and polls the selected profile', async () => {
    jest.useFakeTimers();
    try {
      const fetchMock = jest.fn((input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('/api/instances/inst-1/oauth/codex/start')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: {
                url: 'https://auth.openai.com/device',
                code: 'ABCD-EFGH',
              },
            }),
          });
        }

        if (url.includes('/api/instances/inst-1/oauth/codex/status?profile=strategy')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: {
                authenticated: true,
              },
            }),
          });
        }

        return defaultFetchImplementation(input);
      });

      Object.defineProperty(global, 'fetch', {
        configurable: true,
        writable: true,
        value: fetchMock,
      });

      render(<VaultPage />);

      fireEvent.click(await screen.findByRole('button', { name: /add new key/i }));
      fireEvent.click(screen.getByLabelText(/automated device auth/i));

      fireEvent.click(await screen.findByRole('button', { name: /target agent profile/i }));
      const profileDialog = await screen.findByRole('dialog', { name: /choose target agent profile/i });
      fireEvent.click(within(profileDialog).getByRole('button', { name: /strategist \(strategy\)/i }));
      fireEvent.click(screen.getByRole('button', { name: /connect codex/i }));

      await screen.findByText(/step 1 — open this url/i);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('/api/instances/inst-1/oauth/codex/start?profile=strategy')
        )
      ).toBe(true);

      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([url]) =>
            String(url).includes('/api/instances/inst-1/oauth/codex/status?profile=strategy')
          )
        ).toBe(true);
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels delayed Codex success refreshes when the page unmounts early', async () => {
    jest.useFakeTimers();
    try {
      const fetchMock = jest.fn((input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('/api/instances/inst-1/oauth/codex/start')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: {
                url: 'https://auth.openai.com/device',
                code: 'ABCD-EFGH',
              },
            }),
          });
        }

        if (url.includes('/api/instances/inst-1/oauth/codex/status?profile=strategy')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: {
                authenticated: true,
              },
            }),
          });
        }

        return defaultFetchImplementation(input);
      });

      Object.defineProperty(global, 'fetch', {
        configurable: true,
        writable: true,
        value: fetchMock,
      });

      const { unmount } = render(<VaultPage />);

      fireEvent.click(await screen.findByRole('button', { name: /add new key/i }));
      fireEvent.click(screen.getByLabelText(/automated device auth/i));
      fireEvent.click(await screen.findByRole('button', { name: /target agent profile/i }));
      const profileDialog = await screen.findByRole('dialog', { name: /choose target agent profile/i });
      fireEvent.click(within(profileDialog).getByRole('button', { name: /strategist \(strategy\)/i }));
      fireEvent.click(screen.getByRole('button', { name: /connect codex/i }));

      await screen.findByText(/step 1 — open this url/i);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('/api/instances/inst-1/oauth/codex/start?profile=strategy')
        )
      ).toBe(true);

      await act(async () => {
        jest.advanceTimersByTime(4_000);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([url]) =>
            String(url).includes('/api/instances/inst-1/oauth/codex/status?profile=strategy')
          )
        ).toBe(true);
      });

      const refreshFetchCount = fetchMock.mock.calls.filter(([url]) => {
        const value = String(url);
        return value.includes('/api/vault') || value.includes('/api/instances?summary=true');
      }).length;

      unmount();

      await act(async () => {
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
      });

      const refreshFetchCountAfterUnmount = fetchMock.mock.calls.filter(([url]) => {
        const value = String(url);
        return value.includes('/api/vault') || value.includes('/api/instances?summary=true');
      }).length;

      expect(refreshFetchCountAfterUnmount).toBe(refreshFetchCount);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the codex copy button unchanged when copying the device code fails', async () => {
    mockedCopyTextToClipboard.mockResolvedValue(false);

    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/api/instances/inst-1/oauth/codex/start')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              url: 'https://auth.openai.com/device',
              code: 'ABCD-EFGH',
            },
          }),
        });
      }

      return defaultFetchImplementation(input);
    });

    Object.defineProperty(global, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(<VaultPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add new key/i }));
    fireEvent.click(screen.getByLabelText(/automated device auth/i));
    fireEvent.click(screen.getByRole('button', { name: /connect codex/i }));

    const copyButton = await screen.findByRole('button', { name: /copy/i });

    await act(async () => {
      fireEvent.click(copyButton);
    });

    expect(mockedCopyTextToClipboard).toHaveBeenCalledWith('ABCD-EFGH');
    expect(screen.getByRole('button', { name: /^copy$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copied!/i })).not.toBeInTheDocument();
  });
  it('shows Nous Portal as an automated Vault auth option', async () => {
    render(<VaultPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add new key/i }));
    fireEvent.click(screen.getByLabelText(/automated device auth/i));
    fireEvent.click(screen.getByRole('radio', { name: /nous portal/i }));

    expect(
      await screen.findByText(/save a reusable encrypted session for future nous deployments/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect nous portal/i })).toBeInTheDocument();
  });

  it('lists Bankr as a manual vault provider option', async () => {
    render(<VaultPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add new key/i }));

    expect(screen.getByText(/bankr llm gateway/i)).toBeInTheDocument();
  });

  it('syncs openai-codex Vault sessions as Codex OAuth payloads for active agents', async () => {
    const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/api/vault')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: [{
              id: 'vault-codex',
              name: 'Codex Session',
              provider: 'openai-codex',
              key_preview: 'OAuth session (reusable)',
              created_at: '2026-05-06T00:00:00.000Z',
            }],
          }),
        });
      }

      if (url.includes('/api/instances?summary=true')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: [{
              id: 'inst-codex',
              name: 'Codex Agent',
              provider: 'openai-codex',
              status: 'running',
              config: {},
            }],
          }),
        });
      }

      if (url.includes('/api/instances/inst-codex/profiles')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: [] }),
        });
      }

      if (url.includes('/api/instances/inst-codex') && init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: {} }),
        });
      }

      return defaultFetchImplementation(input);
    });

    Object.defineProperty(global, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    render(<VaultPage />);

    const providerSelect = await waitFor(() => screen.getAllByDisplayValue('Leave current')[0]);
    fireEvent.change(providerSelect, { target: { value: 'vault-codex' } });
    fireEvent.click(screen.getByRole('button', { name: /apply changes/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/instances/inst-codex',
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    const patchCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('/api/instances/inst-codex') && init?.method === 'PATCH'
    );
    const body = JSON.parse(String(patchCall?.[1]?.body));

    expect(body).toEqual(expect.objectContaining({
      apply: true,
      vaultKeyId: 'vault-codex',
      provider: 'codex',
    }));
    expect(body.model).toBeTruthy();
  });

  it('shows a clear success confirmation after saving a key', async () => {
    render(<VaultPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add new key/i }));
    fireEvent.change(screen.getByPlaceholderText(/e.g. my anthropic key/i), {
      target: { value: 'Primary Anthropic' },
    });
    fireEvent.change(screen.getByPlaceholderText(/sk-\.\.\./i), {
      target: { value: 'sk-test-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save key$/i }));

    await waitFor(() => {
      expect(screen.getByText(/primary anthropic saved securely/i)).toBeInTheDocument();
    });
  });

  it('clears pending success timers when the page unmounts after saving a key', async () => {
    jest.useFakeTimers();
    try {
      const setTimeoutSpy = jest.spyOn(window, 'setTimeout');
      const clearTimeoutSpy = jest.spyOn(window, 'clearTimeout');
      const { unmount } = render(<VaultPage />);

      fireEvent.click(await screen.findByRole('button', { name: /add new key/i }));
      fireEvent.change(screen.getByPlaceholderText(/e.g. my anthropic key/i), {
        target: { value: 'Primary Anthropic' },
      });
      fireEvent.change(screen.getByPlaceholderText(/sk-\.\.\./i), {
        target: { value: 'sk-test-123' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^save key$/i }));

      await waitFor(() => {
        expect(screen.getByText(/primary anthropic saved securely/i)).toBeInTheDocument();
      });

      const successTimeoutCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5000);
      expect(successTimeoutCallIndex).toBeGreaterThanOrEqual(0);
      const successTimeoutId = setTimeoutSpy.mock.results[successTimeoutCallIndex]?.value;

      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(successTimeoutId);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('clears the codex copy reset timer when the page unmounts early', async () => {
    jest.useFakeTimers();
    try {
      const setTimeoutSpy = jest.spyOn(window, 'setTimeout');
      const clearTimeoutSpy = jest.spyOn(window, 'clearTimeout');
      const fetchMock = jest.fn((input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('/api/instances/inst-1/oauth/codex/start')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: {
                url: 'https://auth.openai.com/device',
                code: 'ABCD-EFGH',
              },
            }),
          });
        }

        return defaultFetchImplementation(input);
      });

      Object.defineProperty(global, 'fetch', {
        configurable: true,
        writable: true,
        value: fetchMock,
      });

      const { unmount } = render(<VaultPage />);

      fireEvent.click(await screen.findByRole('button', { name: /add new key/i }));
      fireEvent.click(screen.getByLabelText(/automated device auth/i));
      fireEvent.click(screen.getByRole('button', { name: /connect codex/i }));

      const copyButton = await screen.findByRole('button', { name: /copy/i });

      await act(async () => {
        fireEvent.click(copyButton);
      });

      const copyTimeoutCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2000);
      expect(copyTimeoutCallIndex).toBeGreaterThanOrEqual(0);
      const copyTimeoutId = setTimeoutSpy.mock.results[copyTimeoutCallIndex]?.value;

      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(copyTimeoutId);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});
