/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { DEFAULT_SETTINGS, useSettings } from '../use-settings';

function SettingsProbe() {
  const { settings, isLoaded } = useSettings();

  return (
    <div>
      <span data-testid="loaded">{String(isLoaded)}</span>
      <span data-testid="enable-streaming">{String(settings.enableStreamingAnimations)}</span>
    </div>
  );
}

function SettingsActionsProbe() {
  const { clearCacheAndReload, updateSettings } = useSettings();

  return (
    <div>
      <button type="button" onClick={clearCacheAndReload}>
        Clear cache
      </button>
      <button type="button" onClick={() => updateSettings({ sessionExpiryHours: 48 })}>
        Update settings
      </button>
    </div>
  );
}

describe('useSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps defaults when localStorage settings are malformed JSON', () => {
    localStorage.setItem('hermes_os_settings', '{"enablePlugins":');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const removeItemSpy = jest.spyOn(Storage.prototype, 'removeItem');

    render(<SettingsProbe />);

    expect(() => {
      act(() => {
        jest.runOnlyPendingTimers();
      });
    }).not.toThrow();

    expect(screen.getByTestId('loaded')).toHaveTextContent('true');
    expect(screen.getByTestId('enable-streaming')).toHaveTextContent(String(DEFAULT_SETTINGS.enableStreamingAnimations));
    expect(errorSpy).toHaveBeenCalledWith(
      '[use-settings] Failed to load Hivra settings from localStorage',
      expect.objectContaining({ name: 'SyntaxError' }),
      expect.objectContaining({
        source: 'use-settings',
        failureType: 'settings_local_storage_parse_failed',
      })
    );
    expect(removeItemSpy).toHaveBeenCalledWith('hermes_os_settings');
    expect(localStorage.getItem('hermes_os_settings')).toBeNull();
  });

  it('clears pending load timers on unmount', () => {
    localStorage.setItem('hermes_os_settings', JSON.stringify({ enablePlugins: false }));

    const { unmount } = render(<SettingsProbe />);

    expect(jest.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('only clears Hermes-managed localStorage keys before reloading', () => {
    localStorage.setItem('hermes_os_settings', '{"enablePlugins":true}');
    localStorage.setItem('dashboard_instances_user_123', '[]');
    localStorage.setItem('telemetry_inst_123_user_123', '{}');
    localStorage.setItem('third_party_token', 'keep-me');
    const originalLocation = window.location;
    const reloadSpy = jest.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        reload: reloadSpy,
      },
    });

    render(<SettingsActionsProbe />);
    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole('button', { name: /clear cache/i }));

    expect(localStorage.getItem('hermes_os_settings')).toBeNull();
    expect(localStorage.getItem('dashboard_instances_user_123')).toBeNull();
    expect(localStorage.getItem('telemetry_inst_123_user_123')).toBeNull();
    expect(localStorage.getItem('third_party_token')).toBe('keep-me');
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('clears the pending cloud sync timer on unmount', () => {
    const originalFetch = global.fetch;
    const fetchSpy = jest.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(global, 'fetch', {
      configurable: true,
      value: fetchSpy,
    });

    const { unmount } = render(<SettingsActionsProbe />);

    act(() => {
      jest.runOnlyPendingTimers();
    });

    fireEvent.click(screen.getByRole('button', { name: /update settings/i }));

    expect(jest.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(jest.getTimerCount()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    Object.defineProperty(global, 'fetch', {
      configurable: true,
      value: originalFetch,
    });
  });
});
