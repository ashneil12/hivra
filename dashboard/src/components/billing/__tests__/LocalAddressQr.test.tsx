/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';

import QRCode from 'qrcode';
import { LocalAddressQr } from '../LocalAddressQr';

jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn(),
  },
}));

describe('LocalAddressQr', () => {
  const toDataURLMock = QRCode.toDataURL as unknown as jest.Mock<Promise<string>, [string, { margin: number; width: number }]>;

  beforeEach(() => {
    jest.clearAllMocks();
    toDataURLMock.mockResolvedValue('data:image/png;base64,qr');
  });

  it('renders a local QR data URL for the address', async () => {
    render(<LocalAddressQr address="0x000000000000000000000000000000000000dEaD" size={128} />);

    await waitFor(() => {
      expect(toDataURLMock).toHaveBeenCalledWith(
        '0x000000000000000000000000000000000000dEaD',
        { margin: 1, width: 128 },
      );
    });

    const image = await screen.findByRole('img', { name: 'Deposit address QR code' });
    expect(image).toHaveAttribute('src', 'data:image/png;base64,qr');
    expect(image).toHaveAttribute('width', '128');
    expect(image).toHaveAttribute('height', '128');
  });

  it('falls back to a compact placeholder when generation fails', async () => {
    toDataURLMock.mockRejectedValue(new Error('qr failed'));

    render(<LocalAddressQr address="0x000000000000000000000000000000000000dEaD" />);

    expect(await screen.findByText('QR')).toBeInTheDocument();
  });
});
