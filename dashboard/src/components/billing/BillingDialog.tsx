'use client';

// BillingDialog — the one overlay shell every billing dialog renders through.
//
// Why a shared shell: the billing overlays used to render inline inside
// <main>, so the dashboard header and the phone bottom bar painted over them
// (a tap on the covered area navigated away mid-payment), their heights used
// vh (taller than the visible area on iOS), and dismiss controls were 18-36px.
// This shell fixes all of that in one place:
//   - renders through <SafePortal> at the end of <body>;
//   - sizes to the visible viewport minus the safe areas, with a pinned
//     header (the 44px Close button is always reachable), a scrolling body
//     and an optional pinned footer for the primary actions;
//   - Escape closes the top-most dialog, focus moves into the dialog on open,
//     Tab stays inside it, and focus returns to the opener on close.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';

import { SafePortal } from '@/components/ui/SafePortal';
import styles from './billing-overlay.module.css';

export { styles as billingDialogStyles };

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Open dialogs, newest last. Escape only closes the top-most one.
const openDialogStack: symbol[] = [];

export interface BillingDialogProps {
  /** Visible title (Space Grotesk). Names the dialog unless `ariaLabel` is set. */
  title: ReactNode;
  /** Mono eyebrow above the title. */
  eyebrow?: ReactNode;
  /** One or two lines under the title. */
  description?: ReactNode;
  /** Optional square icon tile beside the heading. */
  icon?: ReactNode;
  /** Accessible name when it should differ from the visible title. */
  ariaLabel?: string;
  children: ReactNode;
  /** Pinned action row under the scrolling body. */
  footer?: ReactNode;
  /** Spread footer items to both ends instead of right-aligning them. */
  footerSpread?: boolean;
  onClose: () => void;
  /** A click on the backdrop closes the dialog (default true). */
  dismissOnBackdrop?: boolean;
  /** Disables Close, Escape and the backdrop, e.g. while a charge is in flight. */
  closeDisabled?: boolean;
  /** Accessible name of the X button. */
  closeLabel?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Extra class on the panel. */
  className?: string;
  /** Test hook on the panel. */
  'data-testid'?: string;
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.closest('[inert]') && element.getAttribute('aria-hidden') !== 'true'
  );
}

export function BillingDialog({
  title,
  eyebrow,
  description,
  icon,
  ariaLabel,
  children,
  footer,
  footerSpread = false,
  onClose,
  dismissOnBackdrop = true,
  closeDisabled = false,
  closeLabel = 'Close',
  size = 'md',
  className,
  'data-testid': testId,
}: BillingDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pointerDownOnBackdrop = useRef<boolean | null>(null);
  // Latest handlers for the document listener without re-subscribing.
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  // The opener is read during the first render, before React commits: an
  // opener that is disabled in the same commit that mounts the dialog (e.g.
  // "Pay a year" while the quote loads) has already lost focus to <body> by
  // the time an effect runs.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );

  useEffect(() => {
    onCloseRef.current = onClose;
    closeDisabledRef.current = closeDisabled;
  }, [onClose, closeDisabled]);

  useEffect(() => {
    const token = Symbol('billing-dialog');
    openDialogStack.push(token);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (openDialogStack[openDialogStack.length - 1] !== token) return;
      if (closeDisabledRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const index = openDialogStack.indexOf(token);
      if (index >= 0) openDialogStack.splice(index, 1);
      if (
        opener &&
        opener !== document.body &&
        opener.isConnected &&
        !opener.matches(':disabled') &&
        typeof opener.focus === 'function'
      ) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [opener]);

  // The portal mounts its node in an effect, so the panel exists only after
  // the first commit; a callback ref moves focus in as soon as it does.
  const setPanel = (node: HTMLDivElement | null) => {
    const firstMount = node !== null && panelRef.current === null;
    panelRef.current = node;
    if (firstMount && !node.contains(document.activeElement)) {
      node.focus({ preventScroll: true });
    }
  };

  function handleTrapKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusable = focusableIn(panelRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      panelRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleBackdropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    pointerDownOnBackdrop.current = event.target === event.currentTarget;
  }

  function handleBackdropClick(event: ReactMouseEvent<HTMLDivElement>) {
    const startedOnBackdrop = pointerDownOnBackdrop.current;
    pointerDownOnBackdrop.current = null;
    if (event.target !== event.currentTarget) return;
    // A drag that began inside the panel (e.g. selecting the address) and
    // ended on the backdrop is not a dismiss.
    if (startedOnBackdrop === false) return;
    if (!dismissOnBackdrop || closeDisabled) return;
    onClose();
  }

  return (
    <SafePortal>
      <div
        role="presentation"
        className={styles.overlay}
        onPointerDown={handleBackdropPointerDown}
        onClick={handleBackdropClick}
      >
        <div
          ref={setPanel}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          data-size={size}
          data-testid={testId}
          className={className ? `${styles.panel} ${className}` : styles.panel}
          onKeyDown={handleTrapKeyDown}
        >
          <div className={styles.header}>
            <div className={styles.headerMain}>
              {icon ? (
                <span className={styles.headerIcon} aria-hidden="true">
                  {icon}
                </span>
              ) : null}
              <div className={styles.headerText}>
                {eyebrow ? <span className={`mono ${styles.eyebrow}`}>{eyebrow}</span> : null}
                <h2 id={titleId} className={`serif ${styles.title}`}>
                  {title}
                </h2>
                {description ? (
                  <p id={descriptionId} className={styles.description}>
                    {description}
                  </p>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              className={styles.close}
              onClick={onClose}
              disabled={closeDisabled}
              aria-label={closeLabel}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <div className={styles.body}>{children}</div>

          {footer ? (
            <div className={footerSpread ? `${styles.footer} ${styles.footerSpread}` : styles.footer}>
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </SafePortal>
  );
}
