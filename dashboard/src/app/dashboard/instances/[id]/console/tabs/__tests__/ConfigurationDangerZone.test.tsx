/**
 * @jest-environment jsdom
 */
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  ConfigurationDangerZone,
  isDeleteConfirmationMatch,
  type DeleteReason,
} from '@/app/dashboard/instances/[id]/console/tabs/ConfigurationDangerZone';
import { copyTextToClipboard } from '@/lib/client/clipboard';

jest.mock('@/lib/client/clipboard', () => ({ copyTextToClipboard: jest.fn() }));

const INSTANCE_ID = 'b8c7f1e0-6f4c-4b43-9d2e-5c1f0a7a9d11';

function Harness({ onDelete }: { onDelete: () => void }) {
  const [deleteConfirm, setDeleteConfirm] = useState(true);
  const [deleteInputText, setDeleteInputText] = useState('');
  const [deleteReason, setDeleteReason] = useState<DeleteReason | null>(null);
  const [deleteReasonNote, setDeleteReasonNote] = useState('');
  return (
    <ConfigurationDangerZone
      instanceId={INSTANCE_ID}
      deleteConfirm={deleteConfirm}
      setDeleteConfirm={setDeleteConfirm}
      deleteInputText={deleteInputText}
      setDeleteInputText={setDeleteInputText}
      actionLoading={false}
      handleDeleteInstance={onDelete}
      deleteReason={deleteReason}
      setDeleteReason={setDeleteReason}
      deleteReasonNote={deleteReasonNote}
      setDeleteReasonNote={setDeleteReasonNote}
    />
  );
}

describe('ConfigurationDangerZone', () => {
  beforeEach(() => {
    (copyTextToClipboard as jest.Mock).mockResolvedValue(true);
  });

  it('matches the typed id trimmed and case-insensitively', () => {
    expect(isDeleteConfirmationMatch(` ${INSTANCE_ID.toUpperCase()} `, INSTANCE_ID)).toBe(true);
    expect(isDeleteConfirmationMatch('b8c7f1e0', INSTANCE_ID)).toBe(false);
  });

  it('enables Confirm when a phone keyboard capitalises the first letter', () => {
    const onDelete = jest.fn();
    render(<Harness onDelete={onDelete} />);

    const input = screen.getByRole('textbox', { name: /type the instance id to confirm/i });
    expect(input).toHaveAttribute('autocapitalize', 'none');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');

    const confirm = screen.getByRole('button', { name: /confirm delete/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: `B${INSTANCE_ID.slice(1)}` } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('copies the instance id so it can be pasted instead of typed', async () => {
    render(<Harness onDelete={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy id/i }));
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith(INSTANCE_ID);
    expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('renders the dialog outside the page tree so it layers above the app chrome', () => {
    const { container } = render(<Harness onDelete={jest.fn()} />);
    const dialog = screen.getByRole('dialog', { name: /delete instance/i });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
});
