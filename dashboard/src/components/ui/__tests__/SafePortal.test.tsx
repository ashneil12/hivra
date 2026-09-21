/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';

import { SafePortal } from '../SafePortal';

describe('SafePortal', () => {
  it('renders content into a dedicated portal root', () => {
    render(
      <SafePortal>
        <div>Portal content</div>
      </SafePortal>
    );

    expect(screen.getByText('Portal content')).toBeTruthy();
    expect(document.querySelectorAll('[data-hermes-portal-root]')).toHaveLength(1);
  });

  it('unmounts without crashing when the portal root was removed externally', () => {
    const { unmount } = render(
      <SafePortal>
        <div>Portal content</div>
      </SafePortal>
    );

    document.querySelector('[data-hermes-portal-root]')?.remove();

    expect(() => unmount()).not.toThrow();
  });
});
