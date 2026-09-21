/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import LogsTab from '@/app/dashboard/instances/[id]/console/tabs/LogsTab';
import '@testing-library/jest-dom';

describe('LogsTab Component', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  it('renders gateway logs from the console logs endpoint', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { logs: 'gateway booted', source: 'journal' } }),
      })
    ) as jest.Mock;

    await act(async () => {
      render(<LogsTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByText('gateway booted')).toBeInTheDocument();
    expect(screen.getByText(/source: journal/i)).toBeInTheDocument();
  });

  it('degrades to the unavailable state when the poll fails instead of throwing (Safari "Load failed")', async () => {
    global.fetch = jest.fn(() => Promise.reject(new TypeError('Load failed'))) as jest.Mock;

    await act(async () => {
      render(<LogsTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByText(/unable to reach the gateway log stream/i)).toBeInTheDocument();
    expect(screen.getByText(/source: unavailable/i)).toBeInTheDocument();
  });

  it('keeps existing logs when a later poll returns a non-JSON body (Safari DOMException)', async () => {
    let calls = 0;
    global.fetch = jest.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { logs: 'gateway booted', source: 'journal' } }),
        });
      }
      return Promise.resolve({
        ok: false,
        json: () => Promise.reject(new DOMException('The string did not match the expected pattern.', 'SyntaxError')),
      });
    }) as jest.Mock;

    await act(async () => {
      render(<LogsTab instanceId="test-inst-123" />);
    });

    expect(await screen.findByText('gateway booted')).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(10000);
    });

    expect(screen.getByText('gateway booted')).toBeInTheDocument();
    expect(screen.getByText(/source: unavailable/i)).toBeInTheDocument();
  });
});
