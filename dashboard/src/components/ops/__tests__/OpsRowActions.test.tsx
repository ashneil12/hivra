/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OpsRowActions } from '../OpsRowActions';

const refreshMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(() => ({
    refresh: refreshMock,
  })),
}));

describe('OpsRowActions', () => {
  const confirmMock = jest.fn();
  const fetchMock = jest.fn();

  beforeEach(() => {
    refreshMock.mockReset();
    confirmMock.mockReset();
    fetchMock.mockReset();

    Object.defineProperty(window, 'confirm', {
      configurable: true,
      value: confirmMock,
    });

    Object.defineProperty(global, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
  });

  it('archives a single row via PATCH without confirmation', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    render(<OpsRowActions eventId="evt-1" title="Boom" />);

    fireEvent.click(screen.getByRole('button', { name: /^archive$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/ops/events', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ ids: ['evt-1'] }),
      }));
    });

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
    });

    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('deletes a single row via DELETE after confirmation', async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValue({ ok: true });

    render(<OpsRowActions eventId="evt-1" title="Boom" />);

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(confirmMock).toHaveBeenCalled();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/ops/events', expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ ids: ['evt-1'] }),
      }));
    });

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
    });
  });

  it('does not call DELETE when the operator cancels the per-row delete confirm', () => {
    confirmMock.mockReturnValue(false);

    render(<OpsRowActions eventId="evt-1" title="Boom" />);

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('surfaces the server error when archive fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'rls denied' }),
    });

    render(<OpsRowActions eventId="evt-1" title="Boom" />);

    fireEvent.click(screen.getByRole('button', { name: /^archive$/i }));

    await waitFor(() => {
      expect(screen.getByText(/rls denied/)).toBeInTheDocument();
    });

    expect(refreshMock).not.toHaveBeenCalled();
  });
});
