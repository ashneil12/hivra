/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import BackupsTab from '@/app/dashboard/instances/[id]/console/tabs/BackupsTab';

const BACKUP = { id: 'rp-2026-09-22', created: '2026-09-22T03:00:00Z', description: 'Daily restore point' };

function mockBackupsFetch() {
  global.fetch = jest.fn((url: string, init?: RequestInit) => {
    if (url === '/api/instances/inst-1/backups' && init?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { message: 'Restore request recorded.' } }) });
    }
    if (url === '/api/instances/inst-1/backups') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { backups: [BACKUP] } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { backups_enabled: true } }) });
  }) as jest.Mock;
}

describe('BackupsTab restore confirmation', () => {
  beforeEach(() => {
    mockBackupsFetch();
    window.alert = jest.fn();
  });

  it('accepts "restore" typed in lowercase and sends the canonical word', async () => {
    await act(async () => {
      render(<BackupsTab instanceId="inst-1" />);
    });

    fireEvent.click(await screen.findByRole('button', { name: /request restore/i }));
    const input = screen.getByRole('textbox', { name: /type restore to confirm/i });
    expect(input).toHaveAttribute('autocapitalize', 'characters');

    const confirm = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: ' restore ' } });
    expect(confirm).toBeEnabled();

    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/instances/inst-1/backups', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ backupId: BACKUP.id, confirm: 'RESTORE' }),
    }));
  });

  it('keeps Confirm disabled for anything other than RESTORE', async () => {
    await act(async () => {
      render(<BackupsTab instanceId="inst-1" />);
    });

    fireEvent.click(await screen.findByRole('button', { name: /request restore/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /type restore to confirm/i }), { target: { value: 'restor' } });
    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeDisabled();
  });

  it('puts Cancel before Confirm', async () => {
    await act(async () => {
      render(<BackupsTab instanceId="inst-1" />);
    });

    fireEvent.click(await screen.findByRole('button', { name: /request restore/i }));
    const cancel = screen.getByRole('button', { name: /^cancel$/i });
    const confirm = screen.getByRole('button', { name: /^confirm$/i });
    expect(cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
