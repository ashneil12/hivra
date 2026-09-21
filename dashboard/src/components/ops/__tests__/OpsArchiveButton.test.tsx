/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OpsArchiveButton } from '../OpsArchiveButton';

const refreshMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(() => ({
    refresh: refreshMock,
  })),
}));

describe('OpsArchiveButton', () => {
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

  it('archives the full matching feed and refreshes the route after confirmation', async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValue({
      ok: true,
    });

    render(<OpsArchiveButton eventIds={['evt-1', 'evt-2']} />);

    fireEvent.click(screen.getByRole('button', { name: /Archive All \(2\)/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/ops/events', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ ids: ['evt-1', 'evt-2'] }),
      }));
    });

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
    });
  });

  it('does not call the archive endpoint when the operator cancels', () => {
    confirmMock.mockReturnValue(false);

    render(<OpsArchiveButton eventIds={['evt-1']} />);

    fireEvent.click(screen.getByRole('button', { name: /Archive All \(1\)/ }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('surfaces the server error message when archive fails', async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'Failed to archive ops events: rls denied' }),
    });

    render(<OpsArchiveButton eventIds={['evt-1']} />);

    fireEvent.click(screen.getByRole('button', { name: /Archive All \(1\)/ }));

    await waitFor(() => {
      expect(screen.getByText(/rls denied/)).toBeInTheDocument();
    });

    expect(refreshMock).not.toHaveBeenCalled();
  });
});
