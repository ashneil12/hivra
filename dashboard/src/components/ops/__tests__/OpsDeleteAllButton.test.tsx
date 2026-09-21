/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OpsDeleteAllButton } from '../OpsDeleteAllButton';

const refreshMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(() => ({
    refresh: refreshMock,
  })),
}));

describe('OpsDeleteAllButton', () => {
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

  it('hard-deletes the full matching feed via DELETE after confirmation', async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValue({ ok: true });

    render(<OpsDeleteAllButton eventIds={['evt-1', 'evt-2']} />);

    fireEvent.click(screen.getByRole('button', { name: /Delete All \(2\)/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/ops/events', expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ ids: ['evt-1', 'evt-2'] }),
      }));
    });

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
    });
  });

  it('does not call the delete endpoint when the operator cancels', () => {
    confirmMock.mockReturnValue(false);

    render(<OpsDeleteAllButton eventIds={['evt-1']} />);

    fireEvent.click(screen.getByRole('button', { name: /Delete All \(1\)/ }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('surfaces the server error message when delete fails', async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'Failed to delete ops events: timeout' }),
    });

    render(<OpsDeleteAllButton eventIds={['evt-1']} />);

    fireEvent.click(screen.getByRole('button', { name: /Delete All \(1\)/ }));

    await waitFor(() => {
      expect(screen.getByText(/timeout/)).toBeInTheDocument();
    });

    expect(refreshMock).not.toHaveBeenCalled();
  });
});
