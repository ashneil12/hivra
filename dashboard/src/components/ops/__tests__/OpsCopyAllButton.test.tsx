/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OpsCopyAllButton } from '../OpsCopyAllButton';
import { copyTextToClipboard } from '@/lib/client/clipboard';

jest.mock('@/lib/client/clipboard', () => ({
  copyTextToClipboard: jest.fn(),
}));

describe('OpsCopyAllButton', () => {
  const mockedCopyTextToClipboard = copyTextToClipboard as jest.MockedFunction<typeof copyTextToClipboard>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedCopyTextToClipboard.mockResolvedValue(true);
  });

  it('copies the full incident export and shows success feedback', async () => {
    render(<OpsCopyAllButton incidentCount={3} text={'Incident 1\nIncident 2'} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy All' }));

    await waitFor(() => {
      expect(mockedCopyTextToClipboard).toHaveBeenCalledWith('Incident 1\nIncident 2');
    });

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('shows an inline error when the clipboard write fails', async () => {
    mockedCopyTextToClipboard.mockResolvedValue(false);

    render(<OpsCopyAllButton incidentCount={2} text={'Incident 1'} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy All' }));

    expect(await screen.findByText('Copy failed. Try again.')).toBeInTheDocument();
  });
});
