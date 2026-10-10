/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import ConfigurationTab from '@/app/dashboard/instances/[id]/console/tabs/ConfigurationTab';
import '@testing-library/jest-dom';

describe('ConfigurationTab Component', () => {
  function mockFetch({
    instanceData = {},
    tailscaleData,
  }: {
    instanceData?: Record<string, unknown>;
    tailscaleData?: Record<string, unknown> | undefined;
  } = {}) {
    global.fetch = jest.fn((url) => {
      if (url === '/api/instances/test-inst-123/private-access/tailscale') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { tailscale: tailscaleData } })
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { id: 'test-inst-123', ...instanceData } })
      });
    }) as jest.Mock;
  }

  beforeEach(() => {
    mockFetch();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('renders loading state initially by firing fetch requests', async () => {
    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });
    
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/instances/test-inst-123',
      expect.objectContaining({ cache: 'no-store', signal: expect.anything() })
    );
  });

  it('renders the tailscale panel inside the existing configuration tab with plain-English guidance', async () => {
    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByRole('heading', { name: /private access with tailscale/i })).toBeInTheDocument();
    expect(screen.getByText(/customer-owned private access/i)).toBeInTheDocument();
    expect(screen.getByText(/your normal public dashboard url stays exactly the same/i)).toBeInTheDocument();
    expect(screen.queryByText(/managed venice/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enable managed venice/i })).not.toBeInTheDocument();
  });

  it('renders the Hermes Desktop backend guidance with a Connect Desktop entry point', async () => {
    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByRole('heading', { name: /hermes desktop backend/i })).toBeInTheDocument();
    expect(screen.getByText(/run the native hermes desktop app on this agent’s computer/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect desktop/i })).toBeInTheDocument();
  });

  it('lets an isolated-VM owner opt in to root and Docker access, then redeploys the runtime', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    global.fetch = jest.fn((url, init) => {
      if (url === '/api/instances/test-inst-123/private-access/tailscale') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: {} }),
        });
      }
      if (url === '/api/instances/test-inst-123' && (!init || !init.method)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: {
              id: 'test-inst-123',
              advanced_cloud_access_eligible: true,
              config: { agentSettings: { enableRootAccess: false } },
            },
          }),
        });
      }
      if (url === '/api/instances/test-inst-123' && init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: {} }),
        });
      }
      if (url === '/api/instances/test-inst-123' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: {} }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    const toggle = await screen.findByRole('checkbox', { name: /advanced cloud access/i });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/instances/test-inst-123',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            agentSettings: {
              enableRootAccess: true,
              terminalBackend: 'docker',
            },
          }),
        })
      );
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/instances/test-inst-123',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ action: 'redeploy', applyTerminalBackend: true }),
        })
      );
    });
    expect(await screen.findByText(/advanced cloud access saved as enabled\. restart requested/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /terminal execution backend/i })).toHaveValue('docker');
    confirmSpy.mockRestore();
  });

  it.each(['http', 'network'])('keeps the saved access settings when the restart request fails (%s)', async (failure) => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    mockFetch({
      instanceData: {
        advanced_cloud_access_eligible: true,
        config: { agentSettings: { enableRootAccess: false, terminalBackend: 'local' } },
      },
    });
    const successfulFetch = global.fetch;
    global.fetch = jest.fn((url, options) => {
      if (options?.method === 'POST') {
        return failure === 'network'
          ? Promise.reject(new Error('connection interrupted'))
          : Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false }) });
      }
      return successfulFetch(url, options);
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: /advanced cloud access/i }));

    expect(await screen.findByText('Access setting saved. Restart was not confirmed.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /advanced cloud access/i })).toBeChecked();
    expect(screen.getByRole('combobox', { name: /terminal execution backend/i })).toHaveValue('docker');
    expect(screen.getByText(/Use Save & apply under Terminal Execution to retry/)).toBeInTheDocument();
    expect(screen.queryByText(/Advanced cloud access saved as enabled\. Restart requested/)).not.toBeInTheDocument();

    const terminalCard = within(screen.getByTestId('terminal-execution-card'));
    const retryApply = terminalCard.getByRole('button', { name: /save & apply/i });
    expect(retryApply).not.toBeDisabled();
    fireEvent.click(retryApply);
    expect(await terminalCard.findByText('Settings saved. Restart was not confirmed.')).toBeInTheDocument();
    const posts = (global.fetch as jest.Mock).mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const [, options] of posts) {
      expect(JSON.parse(options.body)).toEqual({ action: 'redeploy', applyTerminalBackend: true });
    }
    confirmSpy.mockRestore();
  });

  it('fails closed on legacy shared-host layouts', async () => {
    mockFetch({ instanceData: { advanced_cloud_access_eligible: false } });

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByRole('heading', { name: /advanced cloud access/i })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /advanced cloud access/i })).not.toBeInTheDocument();
    expect(screen.getByText(/unavailable on legacy shared-host deployments/i)).toBeInTheDocument();
  });

  it('opens a short setup form with a visible auth key field and collapsed advanced options', async () => {
    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    fireEvent.click(await screen.findByRole('button', { name: /connect tailscale/i }));

    const authKeyInput = await screen.findByLabelText(/tailscale auth key/i);
    expect(authKeyInput).toHaveAttribute('type', 'text');
    expect(screen.queryByLabelText(/machine name override/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /advanced options/i }));

    expect(screen.getByLabelText(/machine name override/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tags/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /enable tailscale ssh/i })).toBeInTheDocument();
  });

  it('shows connected status details and action buttons when tailscale is already enabled', async () => {
    mockFetch({
      instanceData: {
        config: {
          privateAccess: {
            tailscale: {
              enabled: true,
              hostScoped: true,
              state: 'connected',
              machineName: 'atlas-agent',
              magicDnsName: 'atlas-agent.tail.ts.net',
              tailnetName: 'acme.tailnet',
            },
          },
        },
      },
      tailscaleData: {
        enabled: true,
        hostScoped: true,
        state: 'connected',
        machineName: 'atlas-agent',
        magicDnsName: 'atlas-agent.tail.ts.net',
        tailnetName: 'acme.tailnet',
      },
    });

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByText(/connected to your tailnet/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('atlas-agent.tail.ts.net')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh status/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect tailscale/i })).toBeInTheDocument();
  });

  it('keeps keyboard focus through the inline disconnect confirm', async () => {
    const connected = {
      enabled: true,
      hostScoped: true,
      state: 'connected',
      machineName: 'atlas-agent',
      magicDnsName: 'atlas-agent.tail.ts.net',
      tailnetName: 'acme.tailnet',
    };
    mockFetch({
      instanceData: { config: { privateAccess: { tailscale: connected } } },
      tailscaleData: connected,
    });

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    const trigger = await screen.findByRole('button', { name: /disconnect tailscale/i });
    trigger.focus();
    fireEvent.click(trigger);
    const strip = screen.getByRole('alertdialog', { name: /disconnect this host from your tailnet/i });
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(strip).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    fireEvent.click(within(strip).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(global.fetch).not.toHaveBeenCalledWith(
      '/api/instances/test-inst-123/private-access/tailscale',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('opens update settings without clearing the current values or asking for a new auth key', async () => {
    mockFetch({
      instanceData: {
        config: {
          privateAccess: {
            tailscale: {
              enabled: true,
              hostScoped: true,
              state: 'connected',
              machineName: 'atlas-agent',
              magicDnsName: 'atlas-agent.tail.ts.net',
              tailnetName: 'acme.tailnet',
              sshEnabled: true,
              tags: ['tag:prod'],
            },
          },
        },
      },
      tailscaleData: {
        enabled: true,
        hostScoped: true,
        state: 'connected',
        machineName: 'atlas-agent',
        magicDnsName: 'atlas-agent.tail.ts.net',
        tailnetName: 'acme.tailnet',
        sshEnabled: true,
        tags: ['tag:prod'],
      },
    });

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    fireEvent.click(await screen.findByRole('button', { name: /update settings/i }));

    expect(screen.queryByLabelText(/tailscale auth key/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/machine name override/i)).toHaveValue('atlas-agent');
    expect(screen.getByLabelText(/tags/i)).toHaveValue('tag:prod');
    expect(screen.getByLabelText(/tags/i)).toBeDisabled();
    expect(screen.getByRole('switch', { name: /enable tailscale ssh/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: /enable tailscale ssh/i })).toHaveTextContent('SSH: On');
    expect(screen.getByRole('button', { name: /save settings/i })).toBeInTheDocument();
  });

  it('shows a shared-host warning when the instance is attached to a shared host', async () => {
    mockFetch({
      instanceData: {
        host_id: 'host-123',
      },
    });

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/this agent is running on a shared host/i)).toBeInTheDocument();
    });
  });

  it('submits the setup form to the tailscale api and surfaces the connected state', async () => {
    global.fetch = jest.fn((url, options) => {
      if (url === '/api/instances/test-inst-123/private-access/tailscale' && options?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: {
              tailscale: {
                enabled: true,
                hostScoped: true,
                state: 'connected',
                magicDnsName: 'atlas-agent.tail.ts.net',
              },
            },
          }),
        });
      }

      if (url === '/api/instances/test-inst-123/private-access/tailscale') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { tailscale: undefined } })
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { id: 'test-inst-123' } })
      });
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    fireEvent.click(await screen.findByRole('button', { name: /connect tailscale/i }));
    fireEvent.change(screen.getByLabelText(/tailscale auth key/i), {
      target: { value: 'tskey-auth-test-123' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /enable tailscale/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/instances/test-inst-123/private-access/tailscale',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    expect(await screen.findByText(/tailscale is connected/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('atlas-agent.tail.ts.net')).toBeInTheDocument();
  });

  it('saves connected tailscale settings through the update api without requiring a new auth key', async () => {
    global.fetch = jest.fn((url, options) => {
      if (url === '/api/instances/test-inst-123/private-access/tailscale' && options?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: {
              tailscale: {
                enabled: true,
                hostScoped: true,
                state: 'connected',
                machineName: 'atlas-agent-updated',
                magicDnsName: 'atlas-agent-updated.tail.ts.net',
                sshEnabled: true,
              },
            },
          }),
        });
      }

      if (url === '/api/instances/test-inst-123/private-access/tailscale') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: {
              tailscale: {
                enabled: true,
                hostScoped: true,
                state: 'connected',
                machineName: 'atlas-agent',
                magicDnsName: 'atlas-agent.tail.ts.net',
                sshEnabled: false,
                tags: ['tag:prod'],
              },
            },
          })
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: {
            id: 'test-inst-123',
            config: {
              privateAccess: {
                tailscale: {
                  enabled: true,
                  hostScoped: true,
                  state: 'connected',
                  machineName: 'atlas-agent',
                  magicDnsName: 'atlas-agent.tail.ts.net',
                  sshEnabled: false,
                  tags: ['tag:prod'],
                },
              },
            },
          },
        })
      });
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    fireEvent.click(await screen.findByRole('button', { name: /update settings/i }));
    fireEvent.change(screen.getByLabelText(/machine name override/i), {
      target: { value: 'atlas-agent-updated' },
    });
    fireEvent.click(screen.getByRole('switch', { name: /enable tailscale ssh/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/instances/test-inst-123/private-access/tailscale',
        expect.objectContaining({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    const patchCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, options]) =>
        url === '/api/instances/test-inst-123/private-access/tailscale' && options?.method === 'PATCH'
    );

    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      machineName: 'atlas-agent-updated',
      enableSsh: true,
    });

    expect(await screen.findByText(/tailscale settings were updated/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('atlas-agent-updated.tail.ts.net')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Enabled')).toBeInTheDocument();
  });

  it('disconnects tailscale from the same panel without leaving the configuration screen', async () => {
    global.fetch = jest.fn((url, options) => {
      if (url === '/api/instances/test-inst-123/private-access/tailscale' && options?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { tailscale: undefined } })
        });
      }

      if (url === '/api/instances/test-inst-123/private-access/tailscale') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: {
              tailscale: {
                enabled: true,
                hostScoped: true,
                state: 'connected',
                magicDnsName: 'atlas-agent.tail.ts.net',
              },
            },
          })
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: {
            id: 'test-inst-123',
            config: {
              privateAccess: {
                tailscale: {
                  enabled: true,
                  hostScoped: true,
                  state: 'connected',
                  magicDnsName: 'atlas-agent.tail.ts.net',
                },
              },
            },
          },
        })
      });
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    fireEvent.click(await screen.findByRole('button', { name: /disconnect tailscale/i }));

    // The first tap only asks; nothing is sent until the inline confirm.
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/disconnect this host from your tailnet/i);
    expect(global.fetch).not.toHaveBeenCalledWith(
      '/api/instances/test-inst-123/private-access/tailscale',
      expect.objectContaining({ method: 'DELETE' })
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^disconnect$/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/instances/test-inst-123/private-access/tailscale',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });

    expect(await screen.findByText(/tailscale has been disconnected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect tailscale/i })).toBeInTheDocument();
  });

  it('does not render managed Venice controls in Advanced Console settings', async () => {
    mockFetch({
      instanceData: {
        id: 'test-inst-123',
        backend: 'webui',
        provider: 'venice',
        config: {
          managedVenice: {
            enabled: true,
            walletType: 'card',
          },
        },
      },
    });

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByRole('heading', { name: /private access with tailscale/i })).toBeInTheDocument();
    expect(screen.queryByText(/managed venice/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /managed venice enabled/i })).not.toBeInTheDocument();
  });

  it('locks settings when the instance fetch fails instead of exposing defaults (Safari "Load failed")', async () => {
    global.fetch = jest.fn((url) => {
      if (url === '/api/instances/test-inst-123') {
        return Promise.reject(new TypeError('Load failed'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load settings/i);
    expect(screen.getByRole('button', { name: /retry settings/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /terminal execution backend/i })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /save & apply/i })).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: /private access with tailscale/i })).not.toBeInTheDocument();
  });

  it('locks settings when the instance endpoint returns a non-JSON body (Safari DOMException)', async () => {
    global.fetch = jest.fn((url) => {
      if (url === '/api/instances/test-inst-123') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.reject(new DOMException('The string did not match the expected pattern.', 'SyntaxError')),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load settings/i);
    expect(screen.getByRole('button', { name: /retry settings/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /terminal execution backend/i })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /save & apply/i })).toHaveLength(0);
  });

  it.each([
    {
      name: 'an HTTP error even if its JSON claims success',
      response: { ok: false, status: 503, json: async () => ({ success: true, data: {} }) },
    },
    {
      name: 'an unsuccessful JSON response',
      response: { ok: true, json: async () => ({ success: false, error: 'Unavailable' }) },
    },
    {
      name: 'a response without instance data',
      response: { ok: true, json: async () => ({ success: true }) },
    },
    {
      name: 'array-shaped instance data',
      response: { ok: true, json: async () => ({ success: true, data: [] }) },
    },
    {
      name: 'instance data without an identity',
      response: { ok: true, json: async () => ({ success: true, data: {} }) },
    },
    {
      name: 'settings for a different instance',
      response: { ok: true, json: async () => ({ success: true, data: { id: 'other-instance' } }) },
    },
    {
      name: 'malformed config data',
      response: { ok: true, json: async () => ({ success: true, data: { id: 'test-inst-123', config: 'not settings' } }) },
    },
    {
      name: 'an unknown terminal backend',
      response: { ok: true, json: async () => ({ success: true, data: { id: 'test-inst-123', config: { agentSettings: { terminalBackend: 'unknown' } } } }) },
    },
  ])('keeps all settings controls locked after $name', async ({ response }) => {
    global.fetch = jest.fn().mockResolvedValue(response);

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load settings/i);
    expect(screen.getByRole('button', { name: /retry settings/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /terminal execution backend/i })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /save & apply/i })).toHaveLength(0);
    expect((global.fetch as jest.Mock).mock.calls
      .filter(([url]) => url === '/api/instances/test-inst-123')
      .every(([, options]) => !options?.method)).toBe(true);
  });

  it('retries a failed read and only enables editing after the saved settings load', async () => {
    let instanceReads = 0;
    global.fetch = jest.fn((url) => {
      if (url === '/api/instances/test-inst-123') {
        instanceReads += 1;
        if (instanceReads === 1) {
          return Promise.resolve({ ok: false, status: 503 });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              id: 'test-inst-123',
              advanced_cloud_access_eligible: true,
              config: { agentSettings: { enableRootAccess: true, terminalBackend: 'docker' } },
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) });
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load settings/i);
    expect(screen.queryAllByRole('button', { name: /save & apply/i })).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /retry settings/i }));

    expect(await screen.findByRole('combobox', { name: /terminal execution backend/i })).toHaveValue('docker');
    expect(screen.getByRole('checkbox', { name: /advanced cloud access/i })).toBeChecked();
    expect(within(screen.getByTestId('terminal-execution-card')).getByRole('button', { name: /save & apply/i })).toBeEnabled();
    expect(instanceReads).toBe(2);
    expect(screen.queryByRole('button', { name: /retry settings/i })).not.toBeInTheDocument();
  });

  it('aborts stale reads when the instance changes and ignores late responses after cleanup', async () => {
    let resolveFirst!: (response: unknown) => void;
    let resolveSecond!: (response: unknown) => void;
    const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
    const secondResponse = new Promise((resolve) => { resolveSecond = resolve; });
    global.fetch = jest.fn((url) => {
      if (url === '/api/instances/first-instance') return firstResponse;
      if (url === '/api/instances/second-instance') return secondResponse;
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) });
    }) as jest.Mock;

    const view = render(<ConfigurationTab instanceId="first-instance" />);
    const firstSignal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal;
    expect(screen.getByRole('status', { name: /loading settings/i })).toBeInTheDocument();

    view.rerender(<ConfigurationTab instanceId="second-instance" />);
    const secondCall = (global.fetch as jest.Mock).mock.calls.find(([url]) => url === '/api/instances/second-instance');
    const secondSignal = secondCall?.[1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    expect(screen.queryAllByRole('button', { name: /save & apply/i })).toHaveLength(0);

    await act(async () => {
      resolveSecond({
        ok: true,
        json: async () => ({ success: true, data: { id: 'second-instance', config: { agentSettings: { terminalBackend: 'modal' } } } }),
      });
    });
    expect(await screen.findByRole('combobox', { name: /terminal execution backend/i })).toHaveValue('modal');

    await act(async () => {
      resolveFirst({
        ok: true,
        json: async () => ({ success: true, data: { id: 'first-instance', config: { agentSettings: { terminalBackend: 'local' } } } }),
      });
    });
    expect(screen.getByRole('combobox', { name: /terminal execution backend/i })).toHaveValue('modal');

    view.unmount();
    expect(secondSignal.aborted).toBe(true);
  });

  it('blocks Docker Save & apply while Advanced Cloud Access is off without sending a mutation', async () => {
    mockFetch({
      instanceData: {
        advanced_cloud_access_eligible: true,
        config: { agentSettings: { enableRootAccess: false, terminalBackend: 'local' } },
      },
    });

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });
    fireEvent.change(await screen.findByRole('combobox', { name: /terminal execution backend/i }), {
      target: { value: 'docker' },
    });

    const terminalCard = within(screen.getByTestId('terminal-execution-card'));
    expect(terminalCard.getByRole('alert')).toHaveTextContent(/enable it above before saving Docker execution/i);
    const saveButton = terminalCard.getByRole('button', { name: /save & apply/i });
    expect(saveButton).toBeDisabled();
    fireEvent.click(saveButton);
    expect((global.fetch as jest.Mock).mock.calls.some(([, options]) => options?.method === 'PATCH' || options?.method === 'POST')).toBe(false);
  });

  it.each(['terminal-execution-card', 'context-engine-card'])('reports only a requested restart after saving %s', async (cardId) => {
    mockFetch({ instanceData: { config: { agentSettings: { enableRootAccess: true, terminalBackend: 'docker' } } } });
    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    const card = within(await screen.findByTestId(cardId));
    fireEvent.click(card.getByRole('button', { name: /save & apply/i }));

    await waitFor(() => {
      expect(card.getByRole('status')).toHaveTextContent('Settings saved. Restart requested — wait for the agent to reconnect.');
    });
    expect(card.queryByText(/Applied\.|~90s/)).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/instances/test-inst-123', expect.objectContaining({ method: 'PATCH' }));
    expect(global.fetch).toHaveBeenCalledWith('/api/instances/test-inst-123', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'redeploy', ...(cardId === 'terminal-execution-card' ? { applyTerminalBackend: true } : {}) }),
    }));
  });

  it('opens the Hermes WebUI in a new browser tab from the configuration action', async () => {
    const openedTab = { opener: {}, location: { href: '' }, close: jest.fn() };
    const openSpy = jest.spyOn(window, 'open').mockReturnValue(openedTab as unknown as Window);

    global.fetch = jest.fn((url) => {
      if (typeof url === 'string' && url.includes('/webui-login-url')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(''),
          json: () => Promise.resolve({ url: 'https://agent.example.com/_sidecar/webui-login?tab=1' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { id: 'test-inst-123' } }) });
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    await act(async () => {
      fireEvent.click(await screen.findByTestId('webui-open-workspace-action'));
    });

    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => {
      expect(openedTab.location.href).toBe('https://agent.example.com/_sidecar/webui-login?tab=1');
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/instances/test-inst-123/webui-login-url',
      expect.objectContaining({ cache: 'no-store' }),
    );

    openSpy.mockRestore();
  });

  it('surfaces a pending notice when the workspace is still starting up', async () => {
    const openedTab = { opener: {}, location: { href: '' }, close: jest.fn() };
    const openSpy = jest.spyOn(window, 'open').mockReturnValue(openedTab as unknown as Window);

    global.fetch = jest.fn((url) => {
      if (typeof url === 'string' && url.includes('/webui-login-url')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(''),
          json: () => Promise.resolve({ kind: 'pending', message: 'Workspace is still booting.' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { id: 'test-inst-123' } }) });
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    await act(async () => {
      fireEvent.click(await screen.findByTestId('webui-open-workspace-action'));
    });

    expect(await screen.findByText(/workspace is still booting/i)).toBeInTheDocument();
    expect(openedTab.close).toHaveBeenCalled();

    openSpy.mockRestore();
  });

  it('deletes after a phone keyboard capitalises the typed id, sending the exact id to the server', async () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    const baseFetch = global.fetch as jest.Mock;
    global.fetch = jest.fn((url, init) => {
      if (url === '/api/instances/test-inst-123' && init?.method === 'DELETE') {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false, error: 'kept for test' }) });
      }
      return baseFetch(url, init);
    }) as jest.Mock;

    await act(async () => {
      render(<ConfigurationTab instanceId="test-inst-123" />);
    });

    fireEvent.click(await screen.findByRole('button', { name: /delete instance/i }));
    const dialog = screen.getByRole('dialog', { name: /delete instance/i });
    const input = within(dialog).getByLabelText(/type the instance id to confirm/i);
    expect(input).toHaveAttribute('autocapitalize', 'none');
    fireEvent.change(input, { target: { value: 'Test-inst-123' } });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /confirm delete/i }));
    });

    const deleteCall = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(deleteCall).toBeDefined();
    expect(JSON.parse(deleteCall![1].body)).toMatchObject({ confirmation: 'test-inst-123' });
    alertSpy.mockRestore();
  });
});
