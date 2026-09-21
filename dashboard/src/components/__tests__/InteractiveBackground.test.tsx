/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, waitFor } from '@testing-library/react';
import InteractiveBackground from '../InteractiveBackground';
import { clientLog } from '@/lib/client/logger';

jest.mock('@/lib/client/logger', () => ({
  clientLog: {
    warn: jest.fn(),
  },
}));

describe('InteractiveBackground', () => {
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = jest.fn(() => 1);
    window.cancelAnimationFrame = jest.fn();
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    jest.restoreAllMocks();
  });

  function mockCanvasContext() {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      beginPath: jest.fn(),
      arc: jest.fn(),
      closePath: jest.fn(),
      fill: jest.fn(),
      clearRect: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      stroke: jest.fn(),
    }) as unknown as CanvasRenderingContext2D);
  }

  it('does not crash when the browser cannot provide a 2d canvas context', () => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('canvas unavailable');
    });

    expect(() => render(<InteractiveBackground />)).not.toThrow();
  });

  it('logs and keeps rendering when matchMedia throws during setup', async () => {
    mockCanvasContext();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => {
        throw new Error('matchMedia unavailable');
      }),
    });

    render(<InteractiveBackground />);

    await waitFor(() => {
      expect(clientLog.warn).toHaveBeenCalledWith(
        'Interactive background media query failed',
        expect.objectContaining({
          source: 'interactive-background',
          failureType: 'interactive_background_media_query_failed',
          query: '(prefers-reduced-motion: reduce)',
        }),
        expect.any(Error)
      );
    });
  });

  it('logs and keeps rendering when navigator.connection is blocked', async () => {
    mockCanvasContext();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({ matches: false })),
    });
    Object.defineProperty(window.navigator, 'connection', {
      configurable: true,
      get() {
        throw new Error('connection is blocked');
      },
    });

    render(<InteractiveBackground />);

    await waitFor(() => {
      expect(clientLog.warn).toHaveBeenCalledWith(
        'Interactive background save-data preference read failed',
        expect.objectContaining({
          source: 'interactive-background',
          failureType: 'interactive_background_save_data_read_failed',
        }),
        expect.any(Error)
      );
    });
  });
});
