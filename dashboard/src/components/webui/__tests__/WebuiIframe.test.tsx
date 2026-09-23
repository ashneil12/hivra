/** @jest-environment jsdom */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { WebuiIframe } from '../WebuiIframe';

jest.mock('@/lib/telemetry/iframe-events', () => ({
  trackIframeLoaded: jest.fn(),
  trackIframeError: jest.fn(),
  trackIframeStopped: jest.fn(),
  trackHandoffUrlMint: jest.fn(),
}));

import {
  trackIframeError,
  trackIframeLoaded,
  trackIframeStopped,
} from '@/lib/telemetry/iframe-events';

let mockResolvedTheme: 'dark' | 'light' | undefined = 'dark';

jest.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}));

describe('WebuiIframe', () => {
  const originalFetch = global.fetch;
  const originalOpen = window.open;
  const originalMatchMedia = window.matchMedia;

  // Real Responses always carry headers; the handoff reads x-vercel-id off them
  // for the support breadcrumb. Mock them so these stay faithful to fetch.
  const TEST_REQUEST_ID = 'sin1::testid-1784000000000-abcdef123456';
  const mockHeaders = (requestId: string | null = TEST_REQUEST_ID) => ({
    get: (name: string) => (name.toLowerCase() === 'x-vercel-id' ? requestId : null),
  });

  function mockSuccessfulFetch(url = 'https://agent.example.com/_sidecar/webui-login?exp=1&nonce=abc&next=%2F&sig=def') {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: mockHeaders(),
      json: async () => ({ url, expiresAt: Date.now() + 30_000 }),
    } as unknown as Response);
  }

  function mockFailingFetch(status = 500, body = 'oops') {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status,
      headers: mockHeaders(),
      text: async () => body,
    } as unknown as Response);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolvedTheme = 'dark';
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: jest.fn(),
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn().mockReturnValue({
        matches: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    document.cookie = 'hermes_locale=; Max-Age=0; path=/';
    global.fetch = originalFetch;
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: originalOpen,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it('shows a loading state, then renders the iframe with the fetched URL', async () => {
    mockSuccessfulFetch('https://agent.example.com/_sidecar/webui-login?test=1');
    render(<WebuiIframe instanceId="inst_xyz" />);
    expect(screen.getByRole('status', { name: /connecting/i })).toBeInTheDocument();

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute('src', 'https://agent.example.com/_sidecar/webui-login?test=1');
    expect(iframe).toHaveAttribute('sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads',
    );
    expect(iframe).toHaveAttribute('allow', expect.stringContaining('clipboard-write'));
    expect(screen.getByTestId('webui-frame-shell')).toHaveStyle({
      overflow: 'hidden',
    });
  });

  it('keeps Hermes Desktop Web embedded on compact screens', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn().mockReturnValue({
        matches: true,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }),
    });
    mockSuccessfulFetch('https://agent.example.com/_sidecar/webui-login?mobile=1');
    render(<WebuiIframe instanceId="inst_mobile" />);

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute(
      'src',
      'https://agent.example.com/_sidecar/webui-login?mobile=1',
    );
    expect(screen.queryByRole('button', { name: /open workspace/i })).not.toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('uses dashboard-native square chrome for handoff loading instead of teal/purple glass styling', async () => {
    mockSuccessfulFetch();
    render(<WebuiIframe instanceId="inst_theme" />);

    const status = screen.getByRole('status', { name: /connecting/i });
    expect(status).toHaveStyle({
      borderRadius: '0',
    });

    const shellMarkup = status.outerHTML;
    expect(shellMarkup).not.toContain('45, 212, 191');
    expect(shellMarkup).not.toContain('22, 20, 31');
    expect(shellMarkup).not.toContain('border-radius: 8px');
    expect(shellMarkup).not.toContain('linear-gradient');
    expect(shellMarkup).not.toContain('backdrop-filter');

    await waitFor(() => screen.getByTitle('Workspace'));
  });

  it('renders an error state with retry when the URL fetch fails', async () => {
    mockFailingFetch(500, 'server crashed');
    render(<WebuiIframe instanceId="inst_xyz" />);
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByText(/couldn't open your workspace/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(trackIframeError).toHaveBeenCalledWith('inst_xyz', 'fetch_url_failed', expect.any(Object));
  });

  it('shows the scoped preparation shell while the handoff endpoint is pending, then renders the iframe when the gateway is ready', async () => {
    jest.useFakeTimers();
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({
          kind: 'pending',
          reason: 'instance_not_ready',
          message: 'Hermes is waiting for the workspace tunnel to report ready.',
          retryAfterMs: 4000,
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          url: 'https://agent.example.com/_sidecar/webui-login?ready=1',
          expiresAt: Date.now() + 30_000,
        }),
      } as unknown as Response) as unknown as typeof fetch;

    render(<WebuiIframe instanceId="inst_pending" />);

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /preparing your workspace/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Hermes is waiting for the workspace tunnel to report ready/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(trackIframeError).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(4000);
    });

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute('src', 'https://agent.example.com/_sidecar/webui-login?ready=1');
    expect(global.fetch).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('silently keeps the preparation shell up across multiple pending polls without dropping to error', async () => {
    // Pending responses must not transition through the error screen or back
    // to the initial loading copy. A fresh provision can spend many polls in
    // pending; the visual shell should stay settled while the silent retry
    // loop keeps checking readiness.
    jest.useFakeTimers();
    global.fetch = jest
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 202,
        json: async () => ({
          kind: 'pending',
          reason: 'instance_not_ready',
          retryAfterMs: 4000,
        }),
      } as unknown as Response) as unknown as typeof fetch;

    render(<WebuiIframe instanceId="inst_blink" />);

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /preparing your workspace/i })).toBeInTheDocument();
    });

    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      expect(screen.getByRole('status', { name: /preparing your workspace/i })).toBeInTheDocument();
      expect(screen.queryByRole('status', { name: /^connecting$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    }

    expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(1);
    expect(trackIframeError).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('retry button re-attempts and recovers when fetch succeeds the second time', async () => {
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500, text: async () => 'first call fails' };
      return {
        ok: true,
        json: async () => ({ url: 'https://agent.example.com/_sidecar/webui-login?retry=1', expiresAt: Date.now() + 30_000 }),
      };
    }) as unknown as typeof fetch;

    render(<WebuiIframe instanceId="inst_retry" />);
    const retry = await waitFor(() => screen.getByRole('button', { name: /retry/i }));
    // Wait past the debounce window before retrying
    await new Promise((r) => setTimeout(r, 800));
    await act(async () => {
      fireEvent.click(retry);
    });
    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute('src', 'https://agent.example.com/_sidecar/webui-login?retry=1');
  });

  it('captures iframe load via telemetry as document_loaded, NOT as a success', async () => {
    mockSuccessfulFetch();
    render(<WebuiIframe instanceId="inst_load" />);
    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    fireEvent.load(iframe);
    expect(trackIframeLoaded).toHaveBeenCalledWith(
      'inst_load',
      'document_loaded',
      expect.objectContaining({ loadAttempt: 1 }),
    );
    // A painted document is not a working chat — nothing may claim chat_alive
    // until the box (or the gateway probe) actually vouches for it.
    expect(trackIframeLoaded).not.toHaveBeenCalledWith(
      'inst_load',
      'chat_alive',
      expect.anything(),
    );
  });

  it('forces a new handoff attempt and iframe remount after an iframe load error', async () => {
    const url = 'https://agent.example.com/_sidecar/webui-login?same-url=1';
    mockSuccessfulFetch(url);
    render(<WebuiIframe instanceId="inst_recover" />);

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute('data-load-attempt', '1');

    fireEvent.error(iframe);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    const refreshedIframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(refreshedIframe).toHaveAttribute('data-load-attempt', '2');
    expect(trackIframeError).toHaveBeenCalledWith(
      'inst_recover',
      'load',
      expect.objectContaining({ url, loadAttempt: 1 }),
    );
  });

  it('requests a dashboard-appearance-scoped handoff URL and posts it to WebUI', async () => {
    mockResolvedTheme = 'light';
    mockSuccessfulFetch('https://agent.example.com/#iframe_token=secret');
    render(<WebuiIframe instanceId="inst_theme_sync" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/instances/inst_theme_sync/webui-login-url?theme=hermesos-light&skin=hivra',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
      }),
    );

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    const postMessage = jest.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: { postMessage },
    });

    fireEvent.load(iframe);

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'hermes-dashboard:appearance',
        source: 'hermes-dashboard',
        appearance: {
          theme: 'hermesos-light',
          skin: 'hivra',
          colorScheme: 'light',
        },
      },
      'https://agent.example.com',
    );
  });

  it('registers a starter-prompt sender that posts a send-message into the iframe', async () => {
    mockSuccessfulFetch('https://agent.example.com/#iframe_token=secret');
    let sender: ((text: string) => boolean) | null = null;
    const onStarterSenderReady = jest.fn((send: ((text: string) => boolean) | null) => {
      sender = send;
    });
    render(<WebuiIframe instanceId="inst_starter" onStarterSenderReady={onStarterSenderReady} />);

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    const postMessage = jest.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: { postMessage },
    });

    // The sender is registered once the handoff URL is ready.
    await waitFor(() => expect(sender).toEqual(expect.any(Function)));

    const ok = sender!('Help me draft a professional email.');
    expect(ok).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'hermes-dashboard:send-message',
        source: 'hermes-dashboard',
        text: 'Help me draft a professional email.',
      },
      'https://agent.example.com',
    );
  });

  it('iframe keeps the expected security and permission posture', async () => {
    mockSuccessfulFetch();
    render(<WebuiIframe instanceId="inst_handlers" />);
    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe.getAttribute('sandbox')).toContain('allow-downloads');
    expect(iframe.getAttribute('allow')).toContain('microphone');
  });

  it('requests a Chinese-scoped handoff URL when the saved site locale is Chinese', async () => {
    document.cookie = 'hermes_locale=zh-CN; path=/';
    mockSuccessfulFetch('https://agent.example.com/#iframe_token=secret');

    render(<WebuiIframe instanceId="inst_zh" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/instances/inst_zh/webui-login-url?locale=zh-CN&theme=dark&skin=hivra',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
      }),
    );

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute('src', 'https://agent.example.com/?locale=zh-CN&lang=zh-CN#iframe_token=secret');
  });

  it('ignores a malformed saved locale cookie instead of failing the handoff locally', async () => {
    document.cookie = 'hermes_locale=%E0%A4%A; path=/';
    mockSuccessfulFetch('https://agent.example.com/#iframe_token=secret');

    render(<WebuiIframe instanceId="inst_bad_locale" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/instances/inst_bad_locale/webui-login-url?theme=dark&skin=hivra',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
      }),
    );
    expect(await screen.findByTitle('Workspace')).toBeInTheDocument();
    expect(trackIframeError).not.toHaveBeenCalled();
  });

  it('reports non-JSON handoff responses without exposing an opaque parser error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    } as unknown as Response);

    render(<WebuiIframe instanceId="inst_non_json" />);

    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByText('Login URL response was not JSON')).toBeInTheDocument();
    expect(trackIframeError).toHaveBeenCalledWith(
      'inst_non_json',
      'fetch_url_failed',
      { message: 'Login URL response was not JSON' },
    );
  });

  it('keeps polling when open-in-new-tab receives a pending handoff after an error', async () => {
    jest.useFakeTimers();
    const openedWindow = {
      close: jest.fn(),
      location: { href: '' },
    } as unknown as Window;
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => openedWindow);
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 500, text: async () => 'gateway failed' };
      }
      if (calls === 2) {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            kind: 'pending',
            reason: 'gateway_unreachable',
            message: 'Hermes is still reconnecting the workspace.',
            retryAfterMs: 1000,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          url: 'https://agent.example.com/_sidecar/webui-login?ready-from-pending=1',
          expiresAt: Date.now() + 30_000,
        }),
      };
    }) as unknown as typeof fetch;

    render(<WebuiIframe instanceId="inst_open_pending" />);

    const openInNewTab = await waitFor(() => screen.getByRole('button', { name: /^Open in new tab$/i }));
    await act(async () => {
      fireEvent.click(openInNewTab);
    });

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /preparing your workspace/i })).toBeInTheDocument();
    });
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
    expect(openedWindow.close).toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute(
      'src',
      'https://agent.example.com/_sidecar/webui-login?ready-from-pending=1',
    );
    expect(global.fetch).toHaveBeenCalledTimes(3);
    openSpy.mockRestore();
    jest.useRealTimers();
  });

  it('opens the new tab synchronously without noopener features and navigates it once the URL resolves', async () => {
    const openedWindow = {
      close: jest.fn(),
      location: { href: '' },
      opener: {},
    } as unknown as Window;
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => openedWindow);
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 500, text: async () => 'gateway failed' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          url: 'https://agent.example.com/_sidecar/webui-login?fresh=1',
          expiresAt: Date.now() + 30_000,
        }),
      };
    }) as unknown as typeof fetch;

    render(<WebuiIframe instanceId="inst_open_ok" />);

    const openInNewTab = await waitFor(() => screen.getByRole('button', { name: /^Open in new tab$/i }));
    await act(async () => {
      fireEvent.click(openInNewTab);
    });

    // The 'noopener'/'noreferrer' window features make window.open() return
    // null by spec, which the handler treated as a popup-blocker hit. The
    // window must be opened without them, then navigated after the mint.
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => {
      expect((openedWindow as unknown as { location: { href: string } }).location.href).toBe(
        'https://agent.example.com/_sidecar/webui-login?fresh=1',
      );
    });
    expect((openedWindow as unknown as { opener: unknown }).opener).toBeNull();
    expect(openedWindow.close).not.toHaveBeenCalled();
    expect(trackIframeError).not.toHaveBeenCalledWith(
      'inst_open_ok',
      'open_new_tab_blocked',
      expect.anything(),
    );
    openSpy.mockRestore();
  });

  it('falls back to an inline direct link when the popup is genuinely blocked', async () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 500, text: async () => 'gateway failed' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          url: 'https://agent.example.com/_sidecar/webui-login?blocked=1',
          expiresAt: Date.now() + 30_000,
        }),
      };
    }) as unknown as typeof fetch;

    render(<WebuiIframe instanceId="inst_blocked" />);

    const openInNewTab = await waitFor(() => screen.getByRole('button', { name: /^Open in new tab$/i }));
    await act(async () => {
      fireEvent.click(openInNewTab);
    });

    expect(trackIframeError).toHaveBeenCalledWith(
      'inst_blocked',
      'open_new_tab_blocked',
      expect.objectContaining({ source: 'open_new_tab' }),
    );

    const link = await waitFor(() => screen.getByRole('link', { name: /open it here/i }));
    expect(link).toHaveAttribute('href', 'https://agent.example.com/_sidecar/webui-login?blocked=1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    openSpy.mockRestore();
  });

  it('renders a stopped state with the expected-state event (not an error) when the instance is parked', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: 'Instance is not currently running',
          reason: 'instance_stopped',
          instanceStatus: 'stopped',
        }),
    } as unknown as Response);

    render(<WebuiIframe instanceId="inst_stopped" />);

    await waitFor(() => {
      expect(screen.getByTestId('webui-stopped-state')).toBeInTheDocument();
    });
    expect(screen.getByText(/isn't running right now/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    // A parked box is a NORMAL state: it emits webui_iframe_stopped and never
    // pollutes the webui_iframe_error dashboards.
    expect(trackIframeStopped).toHaveBeenCalledWith(
      'inst_stopped',
      expect.objectContaining({ instanceStatus: 'stopped' }),
    );
    expect(trackIframeError).not.toHaveBeenCalled();
  });

  it('treats a paused box without the machine reason as the expected parked state (legacy server body)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: 'Instance is not currently running', instanceStatus: 'paused' }),
    } as unknown as Response);

    render(<WebuiIframe instanceId="inst_paused" />);

    await waitFor(() => screen.getByTestId('webui-stopped-state'));
    expect(screen.getByTestId('webui-stopped-state')).toHaveAttribute('data-variant', 'stopped');
    expect(trackIframeStopped).toHaveBeenCalledWith(
      'inst_paused',
      expect.objectContaining({ instanceStatus: 'paused' }),
    );
    expect(trackIframeError).not.toHaveBeenCalled();
  });

  it("maps the 'failed' status to a redeploy/support dead-end with no Start button (still an error event)", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: 'Instance is not currently running',
          reason: 'instance_failed',
          instanceStatus: 'failed',
        }),
    } as unknown as Response);

    const onRequestStart = jest.fn();
    render(
      <WebuiIframe
        instanceId="inst_failed"
        instanceStatus="failed"
        onRequestStart={onRequestStart}
      />,
    );

    await waitFor(() => screen.getByTestId('webui-stopped-state'));
    expect(screen.getByTestId('webui-stopped-state')).toHaveAttribute('data-variant', 'failed');
    expect(screen.getByText(/deployment failed/i)).toBeInTheDocument();
    expect(screen.getByText(/redeploy it from the agent console, or contact support/i)).toBeInTheDocument();
    // Start would be a lie on a dead deployment.
    expect(screen.queryByTestId('webui-stopped-start')).not.toBeInTheDocument();
    // A failed deployment is NOT the expected parked state — it stays an error.
    expect(trackIframeError).toHaveBeenCalledWith(
      'inst_failed',
      'instance_not_running',
      expect.objectContaining({ instanceStatus: 'failed', panel_variant: 'failed' }),
    );
    expect(trackIframeStopped).not.toHaveBeenCalled();
  });

  it("maps the 'error' status to restart/repair guidance with a Restart affordance", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: 'Instance is not currently running',
          reason: 'instance_error',
          instanceStatus: 'error',
        }),
    } as unknown as Response);

    const onRequestStart = jest.fn();
    render(
      <WebuiIframe
        instanceId="inst_error_status"
        instanceStatus="error"
        onRequestStart={onRequestStart}
      />,
    );

    await waitFor(() => screen.getByTestId('webui-stopped-state'));
    expect(screen.getByTestId('webui-stopped-state')).toHaveAttribute('data-variant', 'error');
    expect(screen.getByText(/hit an error/i)).toBeInTheDocument();
    expect(screen.getByText(/restart it to recover/i)).toBeInTheDocument();

    const restartButton = screen.getByTestId('webui-stopped-start');
    expect(restartButton).toHaveTextContent(/restart/i);
    fireEvent.click(restartButton);
    expect(onRequestStart).toHaveBeenCalledTimes(1);

    expect(trackIframeError).toHaveBeenCalledWith(
      'inst_error_status',
      'instance_not_running',
      expect.objectContaining({ instanceStatus: 'error', panel_variant: 'error' }),
    );
    expect(trackIframeStopped).not.toHaveBeenCalled();
  });

  it('auto-reconnects when instanceStatus flips to running after a wake', async () => {
    // Mount while stopped: first handoff fetch 400s with instanceStatus=stopped.
    // The parent (which polls status) then re-renders with instanceStatus=running
    // once the auto-wake completes; the iframe must re-fetch and render without
    // the user touching anything.
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({ error: 'Instance is not currently running', instanceStatus: 'stopped' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          url: 'https://agent.example.com/_sidecar/webui-login?woke=1',
          expiresAt: Date.now() + 30_000,
        }),
      };
    }) as unknown as typeof fetch;

    const { rerender } = render(
      <WebuiIframe instanceId="inst_wake" instanceStatus="stopped" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('webui-stopped-state')).toBeInTheDocument();
    });

    // Auto-wake completes; parent's status poll flips to running.
    await act(async () => {
      rerender(<WebuiIframe instanceId="inst_wake" instanceStatus="running" />);
    });

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute('src', 'https://agent.example.com/_sidecar/webui-login?woke=1');
  });

  it('does not re-fetch when instanceStatus stays running (no spurious reloads)', async () => {
    mockSuccessfulFetch('https://agent.example.com/_sidecar/webui-login?stable=1');
    const { rerender } = render(
      <WebuiIframe instanceId="inst_stable" instanceStatus="running" />,
    );

    await waitFor(() => screen.getByTitle('Workspace'));
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // A no-op status re-render (still running) must not trigger another handoff.
    await act(async () => {
      rerender(<WebuiIframe instanceId="inst_stable" instanceStatus="running" />);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('renders a Start affordance in the stopped state and invokes onRequestStart', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: 'Instance is not currently running', instanceStatus: 'stopped' }),
    } as unknown as Response);

    const onRequestStart = jest.fn();
    render(
      <WebuiIframe
        instanceId="inst_start_btn"
        instanceStatus="stopped"
        onRequestStart={onRequestStart}
      />,
    );

    const startButton = await waitFor(() => screen.getByTestId('webui-stopped-start'));
    await act(async () => {
      fireEvent.click(startButton);
    });
    expect(onRequestStart).toHaveBeenCalledTimes(1);
  });

  it('hides the Start affordance when onRequestStart is not provided', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: 'Instance is not currently running', instanceStatus: 'stopped' }),
    } as unknown as Response);

    render(<WebuiIframe instanceId="inst_no_start" />);

    await waitFor(() => screen.getByTestId('webui-stopped-state'));
    expect(screen.queryByTestId('webui-stopped-start')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });

  it('stopped-state refresh re-attempts the handoff and recovers once the instance runs', async () => {
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({ error: 'Instance is not currently running', instanceStatus: 'stopped' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          url: 'https://agent.example.com/_sidecar/webui-login?started=1',
          expiresAt: Date.now() + 30_000,
        }),
      };
    }) as unknown as typeof fetch;

    render(<WebuiIframe instanceId="inst_stopped_refresh" />);

    const refreshButton = await waitFor(() => screen.getByRole('button', { name: /refresh/i }));
    await act(async () => {
      fireEvent.click(refreshButton);
    });

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute('src', 'https://agent.example.com/_sidecar/webui-login?started=1');
  });

  it('retries transient network failures with backoff before surfacing an error', async () => {
    jest.useFakeTimers();
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: 'https://agent.example.com/_sidecar/webui-login?recovered=1',
          expiresAt: Date.now() + 30_000,
        }),
      } as unknown as Response) as unknown as typeof fetch;

    render(<WebuiIframe instanceId="inst_net_retry" />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500);
    });

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute('src', 'https://agent.example.com/_sidecar/webui-login?recovered=1');
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(trackIframeError).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('surfaces the error state after exhausting bounded network retries', async () => {
    jest.useFakeTimers();
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    render(<WebuiIframe instanceId="inst_net_dead" />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });

    await waitFor(() => screen.getByRole('alert'));
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument();
    expect(trackIframeError).toHaveBeenCalledWith('inst_net_dead', 'fetch_url_failed', {
      message: 'Failed to fetch',
    });
    jest.useRealTimers();
  });

  it('does not retry HTTP error responses from the handoff endpoint', async () => {
    mockFailingFetch(500, 'server crashed');
    render(<WebuiIframe instanceId="inst_no_http_retry" />);
    await waitFor(() => screen.getByRole('alert'));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('forces a fresh handoff when the iframe load errors immediately', async () => {
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          url: `https://agent.example.com/_sidecar/webui-login?frame=${calls}`,
          expiresAt: Date.now() + 30_000,
        }),
      };
    }) as unknown as typeof fetch;

    render(<WebuiIframe instanceId="inst_frame_error" />);

    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute('src', 'https://agent.example.com/_sidecar/webui-login?frame=1');

    fireEvent(iframe, new window.Event('error', { bubbles: true, cancelable: true }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByTitle('Workspace')).toHaveAttribute(
        'src',
        'https://agent.example.com/_sidecar/webui-login?frame=2',
      );
    });
    expect(trackIframeError).toHaveBeenCalledWith(
      'inst_frame_error',
      'load',
      {
        url: 'https://agent.example.com/_sidecar/webui-login?frame=1',
        loadAttempt: 1,
      },
    );
  });

  it('does not let a stale handoff response from a previous instance replace the current iframe', async () => {
    let resolveOld!: () => void;
    let resolveNew!: () => void;

    function readyResponse(url: string): Response {
      return {
        ok: true,
        status: 200,
        json: async () => ({ url, expiresAt: Date.now() + 30_000 }),
      } as unknown as Response;
    }

    global.fetch = jest.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      return new Promise<Response>((resolve) => {
        if (url.includes('/inst_old/')) {
          resolveOld = () => resolve(readyResponse('https://agent.example.com/_sidecar/webui-login?instance=old'));
          return;
        }
        if (url.includes('/inst_new/')) {
          resolveNew = () => resolve(readyResponse('https://agent.example.com/_sidecar/webui-login?instance=new'));
          return;
        }
        resolve(readyResponse('https://agent.example.com/_sidecar/webui-login?instance=unexpected'));
      });
    }) as unknown as typeof fetch;

    const { rerender } = render(<WebuiIframe instanceId="inst_old" />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/instances/inst_old/webui-login-url'),
        expect.any(Object),
      );
    });

    rerender(<WebuiIframe instanceId="inst_new" />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/instances/inst_new/webui-login-url'),
        expect.any(Object),
      );
    });

    await act(async () => {
      resolveNew();
    });
    const iframe = await waitFor(() => screen.getByTitle('Workspace'));
    expect(iframe).toHaveAttribute('src', 'https://agent.example.com/_sidecar/webui-login?instance=new');

    await act(async () => {
      resolveOld();
    });
    expect(screen.getByTitle('Workspace')).toHaveAttribute(
      'src',
      'https://agent.example.com/_sidecar/webui-login?instance=new',
    );
  });

  // Regression: the stopped / error / repairing panels replace the iframe over a
  // TRANSPARENT parent, so each must paint its own background. They used to
  // hardcode the dark-theme cream palette (rgba(244, 238, 229, …)) and set no
  // background at all; against the light theme's #ffffff surface that renders
  // cream-on-white — invisible. A broken agent therefore looked like an empty
  // chat with no message and no Retry button, which is exactly how it reached
  // users: the failure was unreportable because nothing was legible.
  //
  // These are SOURCE-level assertions on purpose. jsdom's CSS parser discards
  // `var()` outright — an inline `background: var(--bg-surface)` reads back as
  // "" and the style attribute is null (verified) — so a rendered-DOM assertion
  // cannot distinguish the fixed component from the broken one. Guarding the
  // source is the only check at this tier that actually goes red on regression.
  // True rendered contrast needs a real browser (Playwright), not jsdom.
  describe('fallback panels stay legible in both themes', () => {
    const source = readFileSync(
      join(__dirname, '..', 'WebuiIframe.tsx'),
      'utf8',
    );

    it('never hardcodes the dark-theme cream palette', () => {
      expect(source).not.toMatch(/rgba\(244,\s*238,\s*229/);
    });

    it('drives the fallback panels off theme tokens that flip with :root.dark', () => {
      expect(source).toMatch(/const PANEL_SURFACE_STYLE[\s\S]*?background: 'var\(--bg-surface\)'/);
      expect(source).toMatch(/const PANEL_SURFACE_STYLE[\s\S]*?color: 'var\(--text-primary\)'/);
      expect(source).toMatch(/const PANEL_BUTTON_STYLE[\s\S]*?background: 'var\(--btn-bg\)'/);
      expect(source).toMatch(/const PANEL_BUTTON_STYLE[\s\S]*?color: 'var\(--btn-text\)'/);
    });

    it('applies that shared surface to every fallback panel', () => {
      // stopped / error / repairing — each replaces the iframe entirely.
      expect(source.match(/style=\{PANEL_SURFACE_STYLE\}/g)).toHaveLength(3);
      // No panel button may fall back to the white-on-white hairline.
      expect(source).not.toMatch(/background: '#fff'/);
    });

    // A dead-end panel that says "we've been notified" and nothing else gives
    // the user nothing to report and us nothing to grep. Every dead end must
    // carry the failure code and the x-vercel-id that pins the server log line.
    it('surfaces the request id and failure code on the error panel', async () => {
      mockFailingFetch(500, 'gateway exploded');
      render(<WebuiIframe instanceId="inst_diag" />);

      await waitFor(() => screen.getByTestId('webui-error-state'));
      const diag = screen.getByTestId('webui-panel-diagnostics');
      expect(diag).toHaveTextContent(TEST_REQUEST_ID);
      expect(diag).toHaveTextContent('http_500');
    });

    it('copies a support-ready blob containing instance, code and request id', async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });

      mockFailingFetch(500, 'gateway exploded');
      render(<WebuiIframe instanceId="inst_copy" />);
      await waitFor(() => screen.getByTestId('webui-error-state'));

      await act(async () => {
        fireEvent.click(screen.getByTestId('webui-copy-diagnostics'));
      });

      expect(writeText).toHaveBeenCalledTimes(1);
      const blob = writeText.mock.calls[0][0] as string;
      expect(blob).toContain('instance: inst_copy');
      expect(blob).toContain('code: http_500');
      expect(blob).toContain(`request: ${TEST_REQUEST_ID}`);
      expect(blob).toMatch(/at: \d{4}-\d{2}-\d{2}T/);
    });

    it('shows the server pending reason on the repairing panel, not a generic tag', async () => {
      jest.useFakeTimers();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 202,
        headers: mockHeaders(),
        json: async () => ({
          kind: 'pending',
          reason: 'gateway_unreachable',
          instanceStatus: 'running',
          retryAfterMs: 1000,
        }),
      } as unknown as Response) as unknown as typeof fetch;

      render(<WebuiIframe instanceId="inst_repair" />);
      await waitFor(() => screen.getByRole('status', { name: /preparing your workspace/i }));

      // Bracket PENDING_REPAIR_THRESHOLD_MS (150s). This is also the regression
      // guard for the streak-reset bug: the silent poll runs with force:true,
      // and when it cleared gatewayUnreachableSinceRef every tick the 150s
      // threshold could never elapse — a dead gateway silently fell through to
      // the 300s absolute ceiling. If that returns, the 140s check below still
      // passes but the escalation never arrives and this test times out.
      const tick = async (seconds: number) => {
        for (let i = 0; i < seconds; i += 1) {
          await act(async () => {
            jest.advanceTimersByTime(1000);
          });
        }
      };

      await tick(140);
      expect(screen.queryByTestId('webui-repairing-state')).not.toBeInTheDocument();

      await tick(20);
      await waitFor(() => screen.getByTestId('webui-repairing-state'));
      const diag = screen.getByTestId('webui-panel-diagnostics');
      // The box's actual complaint, not "pending_repair_threshold_exceeded".
      expect(diag).toHaveTextContent('gateway_unreachable');
      expect(diag).toHaveTextContent(TEST_REQUEST_ID);
      jest.useRealTimers();
    });

    it('still renders the stopped panel with a usable action', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: 'Instance is not currently running',
            reason: 'instance_stopped',
            instanceStatus: 'stopped',
          }),
      } as unknown as Response);
      render(<WebuiIframe instanceId="inst_contrast" />);

      await waitFor(() => screen.getByTestId('webui-stopped-state'));
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    });
  });

  describe('chat liveness watchdog', () => {
    const GATEWAY = 'https://agent.example.com';
    const HANDOFF_URL = `${GATEWAY}/_sidecar/webui-login?live=1`;

    // Handoff mint succeeds; the subsequent /health probe answers with
    // `health`. Mirrors the real two-call sequence the component makes.
    function mockHandoffThenHealth(
      health: { isReady: boolean; error?: string; status?: string },
    ) {
      global.fetch = jest.fn().mockImplementation((input: string) => {
        if (input.includes('/health')) {
          return Promise.resolve({
            ok: true,
            headers: mockHeaders('sin1::probe-1784000000000-deadbeef'),
            json: async () => health,
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          headers: mockHeaders(),
          json: async () => ({ url: HANDOFF_URL, expiresAt: Date.now() + 30_000 }),
        } as unknown as Response);
      }) as unknown as typeof fetch;
    }

    async function renderLoadedIframe(instanceId: string) {
      render(<WebuiIframe instanceId={instanceId} />);
      const iframe = await waitFor(() => screen.getByTitle('Workspace'));
      // postMessage source-pinning compares against contentWindow; jsdom
      // leaves it null, so give the frame an identity the test can post as.
      const contentWindow = { postMessage: jest.fn() };
      Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        value: contentWindow,
      });
      await act(async () => {
        fireEvent.load(iframe);
      });
      return { iframe, contentWindow };
    }

    function postReady(source: unknown, origin = GATEWAY, type = 'HERMES_WEBUI_READY') {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type }, origin, source: source as Window }),
      );
    }

    it('records chat_alive and never errors when the box confirms readiness', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      mockHandoffThenHealth({ isReady: false, error: 'should never be probed' });
      const { contentWindow } = await renderLoadedIframe('inst_ready_msg');

      await act(async () => {
        postReady(contentWindow);
      });

      expect(trackIframeLoaded).toHaveBeenCalledWith(
        'inst_ready_msg',
        'chat_alive',
        expect.objectContaining({ loadAttempt: 1, source: 'postmessage' }),
      );

      // Watchdog was disarmed — expiry must not resurrect it.
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(screen.getByTitle('Workspace')).toBeInTheDocument();
      expect(trackIframeError).not.toHaveBeenCalledWith(
        'inst_ready_msg',
        'liveness_timeout',
        expect.anything(),
      );
    });

    // THE fleet-safety case. Every box on an image older than the
    // HERMES_WEBUI_READY emit is silent by design; if silence alone tripped
    // the error panel, shipping this would fake a fleet-wide outage.
    it('keeps a silent-but-healthy box on the chat (probe vouches for it)', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      mockHandoffThenHealth({ isReady: true });
      await renderLoadedIframe('inst_old_image');

      await act(async () => {
        jest.advanceTimersByTime(21_000);
      });

      expect(screen.getByTitle('Workspace')).toBeInTheDocument();
      expect(screen.queryByTestId('webui-error-state')).not.toBeInTheDocument();
      expect(trackIframeLoaded).toHaveBeenCalledWith(
        'inst_old_image',
        'chat_alive',
        expect.objectContaining({ source: 'probe' }),
      );
    });

    it('surfaces the error panel when the frame is silent AND the gateway is unhealthy', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      mockHandoffThenHealth({ isReady: false, error: 'Gateway status: 502', status: 'running' });
      await renderLoadedIframe('inst_blank');

      await act(async () => {
        jest.advanceTimersByTime(21_000);
      });

      const panel = await waitFor(() => screen.getByTestId('webui-error-state'));
      expect(panel).toHaveTextContent(/couldn't open your workspace/i);
      // The affordance the blank-chat user never got.
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /open in new tab/i })).toBeInTheDocument();
      expect(trackIframeError).toHaveBeenCalledWith(
        'inst_blank',
        'liveness_timeout',
        expect.objectContaining({ loadAttempt: 1, message: 'Gateway status: 502' }),
      );

      // The reportable breadcrumb has to survive this path too — a blank chat
      // is exactly the case where the user has nothing else to hand support.
      expect(screen.getByTestId('webui-panel-diagnostics')).toHaveTextContent('liveness_timeout');
      expect(screen.getByTestId('webui-panel-diagnostics')).toHaveTextContent('probe-1784000000000');
    });

    it('ignores a READY message from a foreign origin', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      mockHandoffThenHealth({ isReady: false, error: 'unhealthy' });
      const { contentWindow } = await renderLoadedIframe('inst_spoof_origin');

      await act(async () => {
        postReady(contentWindow, 'https://evil.example.com');
      });
      await act(async () => {
        jest.advanceTimersByTime(21_000);
      });

      // The spoofed confirm was discarded, so the watchdog still ran and the
      // probe still had the final word.
      await waitFor(() => screen.getByTestId('webui-error-state'));
      expect(trackIframeLoaded).not.toHaveBeenCalledWith(
        'inst_spoof_origin',
        'chat_alive',
        expect.anything(),
      );
    });

    it('ignores a right-origin READY posted by a window that is not the iframe', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      mockHandoffThenHealth({ isReady: false, error: 'unhealthy' });
      await renderLoadedIframe('inst_spoof_source');

      await act(async () => {
        // e.g. the "Open in new tab" popup: same gateway origin, wrong frame.
        postReady({ postMessage: jest.fn() });
      });
      await act(async () => {
        jest.advanceTimersByTime(21_000);
      });

      await waitFor(() => screen.getByTestId('webui-error-state'));
      expect(trackIframeLoaded).not.toHaveBeenCalledWith(
        'inst_spoof_source',
        'chat_alive',
        expect.anything(),
      );
    });

    it('does not re-arm the watchdog on a later load in a confirmed session', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      mockHandoffThenHealth({ isReady: false, error: 'unhealthy' });
      const { iframe, contentWindow } = await renderLoadedIframe('inst_renav');

      await act(async () => {
        postReady(contentWindow);
      });
      // In-box navigation fires load again; the SPA emits READY only once per
      // session, so a re-armed watchdog could never be satisfied.
      await act(async () => {
        fireEvent.load(iframe);
      });
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });

      expect(screen.getByTitle('Workspace')).toBeInTheDocument();
      expect(screen.queryByTestId('webui-error-state')).not.toBeInTheDocument();
    });
  });
});
