/** @jest-environment jsdom */
import posthog from 'posthog-js';
import {
  trackHandoffUrlMint,
  trackIframeError,
  trackIframeLoaded,
  trackIframeStopped,
} from '../iframe-events';

jest.mock('posthog-js', () => ({
  __esModule: true,
  default: { capture: jest.fn() },
}));

const captureMock = posthog.capture as jest.Mock;

describe('iframe-events telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('trackIframeLoaded captures webui_iframe_loaded with the instance id and outcome', () => {
    trackIframeLoaded('inst_loaded', 'document_loaded');
    expect(captureMock).toHaveBeenCalledWith('webui_iframe_loaded', {
      instance_id: 'inst_loaded',
      outcome: 'document_loaded',
    });
  });

  it('trackIframeLoaded carries details alongside the chat_alive outcome', () => {
    trackIframeLoaded('inst_alive', 'chat_alive', { loadAttempt: 3, source: 'postmessage' });
    expect(captureMock).toHaveBeenCalledWith('webui_iframe_loaded', {
      instance_id: 'inst_alive',
      outcome: 'chat_alive',
      loadAttempt: 3,
      source: 'postmessage',
    });
  });

  it('never lets a detail shadow the stable outcome enum', () => {
    // Same hazard the `reason` enum hit twice on trackIframeError: dashboards
    // bucket on `outcome`, so a free-form detail must not overwrite it.
    trackIframeLoaded('inst_shadow', 'chat_alive', { outcome: 'document_loaded' });
    expect(captureMock).toHaveBeenCalledWith(
      'webui_iframe_loaded',
      expect.objectContaining({ outcome: 'chat_alive' }),
    );
  });

  it('trackIframeError captures webui_iframe_error with reason and details', () => {
    trackIframeError('inst_err', 'load', { loadAttempt: 2 });
    expect(captureMock).toHaveBeenCalledWith('webui_iframe_error', {
      instance_id: 'inst_err',
      reason: 'load',
      loadAttempt: 2,
    });
  });

  it('remaps a stray `reason` detail to pending_reason so both values survive', () => {
    // Regression, round two: details used to spread after the reason field,
    // letting a free-form `reason` detail overwrite the stable enum. The
    // spread-order fix made the enum win — but silently DROPPED the detail,
    // losing e.g. the server's pending reason ('gateway_unreachable') on the
    // repair-threshold event. Now the enum keeps the `reason` slot and the
    // detail rides alongside as `pending_reason`.
    trackIframeError('inst_err', 'fetch_url_failed', { reason: 'gateway_unreachable' });
    expect(captureMock).toHaveBeenCalledWith('webui_iframe_error', {
      instance_id: 'inst_err',
      reason: 'fetch_url_failed',
      pending_reason: 'gateway_unreachable',
    });
  });

  it('never lets a remapped reason overwrite an explicit pending_reason', () => {
    trackIframeError('inst_err', 'fetch_url_failed', {
      reason: 'stray',
      pending_reason: 'gateway_unhealthy',
    });
    expect(captureMock).toHaveBeenCalledWith('webui_iframe_error', {
      instance_id: 'inst_err',
      reason: 'fetch_url_failed',
      pending_reason: 'gateway_unhealthy',
    });
  });

  it('truncates the free-form message detail to 200 chars on every emit path', () => {
    const longMessage = 'x'.repeat(500);
    trackIframeError('inst_err', 'fetch_url_failed', { message: longMessage });
    trackIframeStopped('inst_stop', { message: longMessage });
    const errorCall = captureMock.mock.calls.find(([event]) => event === 'webui_iframe_error');
    const stoppedCall = captureMock.mock.calls.find(([event]) => event === 'webui_iframe_stopped');
    expect((errorCall![1].message as string).length).toBe(200);
    expect((stoppedCall![1].message as string).length).toBe(200);
  });

  it('trackIframeStopped captures webui_iframe_stopped with the instance id and details', () => {
    trackIframeStopped('inst_parked', {
      message: 'HTTP 400: Instance is not currently running',
      instanceStatus: 'stopped',
    });
    expect(captureMock).toHaveBeenCalledWith('webui_iframe_stopped', {
      instance_id: 'inst_parked',
      message: 'HTTP 400: Instance is not currently running',
      instanceStatus: 'stopped',
    });
  });

  it('preserves the free-form message detail alongside the enum', () => {
    trackIframeError('inst_err', 'fetch_url_failed', {
      message: 'HTTP 500: boom',
      source: 'open_new_tab',
    });
    expect(captureMock).toHaveBeenCalledWith('webui_iframe_error', {
      instance_id: 'inst_err',
      reason: 'fetch_url_failed',
      message: 'HTTP 500: boom',
      source: 'open_new_tab',
    });
  });

  it('supports the distinct instance_not_running reason for stopped instances', () => {
    // The component passes the raw message under `message` (not `reason`) so
    // the distinct enum survives the details spread.
    trackIframeError('inst_stopped', 'instance_not_running', {
      message: 'HTTP 400: Instance is not currently running',
      instanceStatus: 'stopped',
    });
    expect(captureMock).toHaveBeenCalledWith('webui_iframe_error', {
      instance_id: 'inst_stopped',
      reason: 'instance_not_running',
      message: 'HTTP 400: Instance is not currently running',
      instanceStatus: 'stopped',
    });
  });

  it('supports the open_new_tab_blocked reason', () => {
    trackIframeError('inst_blocked', 'open_new_tab_blocked', { source: 'open_new_tab' });
    expect(captureMock).toHaveBeenCalledWith('webui_iframe_error', {
      instance_id: 'inst_blocked',
      reason: 'open_new_tab_blocked',
      source: 'open_new_tab',
    });
  });

  it('trackHandoffUrlMint captures webui_handoff_mint with the outcome', () => {
    trackHandoffUrlMint('inst_mint', 'ok', { latencyMs: 12 });
    expect(captureMock).toHaveBeenCalledWith('webui_handoff_mint', {
      instance_id: 'inst_mint',
      outcome: 'ok',
      latencyMs: 12,
    });
  });

  it('swallows posthog capture failures (telemetry is best-effort)', () => {
    captureMock.mockImplementation(() => {
      throw new Error('posthog not initialized');
    });
    expect(() => trackIframeLoaded('inst_throw', 'document_loaded')).not.toThrow();
    expect(() => trackIframeError('inst_throw', 'load')).not.toThrow();
    expect(() => trackIframeStopped('inst_throw')).not.toThrow();
    expect(() => trackHandoffUrlMint('inst_throw', 'error')).not.toThrow();
  });
});
