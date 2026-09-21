/** @jest-environment jsdom */

import { captureClientOpsEvent } from '../ops-events';

describe('client ops event reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
    } as Response);
  });

  it('posts client incidents to the ops events API', async () => {
    await captureClientOpsEvent({
      source: 'client-runtime',
      title: 'Unhandled client exception',
      message: 'Exploded',
      route: '/dashboard',
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/ops/events', expect.objectContaining({
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
      },
    }));
  });

  it('keeps standalone incidents local instead of calling hosted ops', async () => {
    const previousMode = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = 'local';
    try {
      await captureClientOpsEvent({
        source: 'self-host-runtime',
        title: 'Local diagnostic',
        message: 'Kept in the browser breadcrumb buffer',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
      else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = previousMode;
    }
  });
});
