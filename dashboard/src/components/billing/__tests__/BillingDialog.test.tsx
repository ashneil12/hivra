/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";

import { BillingDialog } from "../BillingDialog";

function Harness({ onClose = jest.fn(), closeDisabled = false }: { onClose?: () => void; closeDisabled?: boolean }) {
  return (
    <BillingDialog
      eyebrow="Billing"
      title="Pay a year"
      description="Pick a tier."
      onClose={onClose}
      closeDisabled={closeDisabled}
      footer={<button type="button">Confirm</button>}
    >
      <button type="button">First action</button>
    </BillingDialog>
  );
}

describe("BillingDialog", () => {
  it("is a labelled, described modal dialog in a body portal", () => {
    const { container } = render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Pay a year" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Pick a tier.");
    expect(container).not.toContainElement(dialog);
    expect(screen.getByRole("heading", { name: "Pay a year" })).toBeInTheDocument();
  });

  it("closes from the X, the backdrop and Escape, but not from clicks inside", () => {
    const onClose = jest.fn();
    render(<Harness onClose={onClose} />);

    fireEvent.click(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("button", { name: "First action" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("presentation"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("ignores a drag that starts inside the panel and ends on the backdrop", () => {
    const onClose = jest.fn();
    render(<Harness onClose={onClose} />);
    const backdrop = screen.getByRole("presentation");

    fireEvent.pointerDown(screen.getByRole("button", { name: "First action" }));
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks every exit while closeDisabled", () => {
    const onClose = jest.fn();
    render(<Harness onClose={onClose} closeDisabled />);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent.click(screen.getByRole("presentation"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("can refuse backdrop dismissal while keeping the X", () => {
    const onClose = jest.fn();
    render(
      <BillingDialog title="Card" onClose={onClose} dismissOnBackdrop={false}>
        <p>Card form</p>
      </BillingDialog>
    );
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus in, keeps Tab inside, and returns focus to the opener on close", () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          {open && (
            <BillingDialog title="Trap" onClose={() => setOpen(false)} footer={<button type="button">Last</button>}>
              <button type="button">Middle</button>
            </BillingDialog>
          )}
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Trap" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    const close = screen.getByRole("button", { name: "Close" });
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to an opener that was disabled in the same commit that opened the dialog", () => {
    // "Pay a year" is disabled while its quote loads, in the same render that
    // mounts the dialog; the browser moves focus to <body> before any effect.
    function LoadingOpener() {
      const [open, setOpen] = useState(false);
      const [loading, setLoading] = useState(false);
      const sinkRef = useRef<HTMLSpanElement | null>(null);
      // jsdom has no focus fixup (and blur() is a no-op on a disabled
      // control), so model the browser: once the commit disables the focused
      // opener, focus has left it before any passive effect runs.
      useLayoutEffect(() => {
        if (loading) sinkRef.current?.focus();
      }, [loading]);
      return (
        <>
          <span ref={sinkRef} tabIndex={-1} />
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setOpen(true);
              setLoading(true);
            }}
          >
            Pay a year
          </button>
          {open && (
            <BillingDialog
              title="Pay"
              onClose={() => {
                setOpen(false);
                setLoading(false);
              }}
            >
              <p>Quote</p>
            </BillingDialog>
          )}
        </>
      );
    }
    render(<LoadingOpener />);
    const opener = screen.getByRole("button", { name: "Pay a year" });
    opener.focus();
    fireEvent.click(opener);
    expect(opener).toBeDisabled();
    expect(document.activeElement).not.toBe(opener);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toBeEnabled();
    expect(document.activeElement).toBe(opener);
  });

  it("does not try to focus an opener that is still disabled when the dialog closes", () => {
    function StuckOpener() {
      const [open, setOpen] = useState(false);
      const [locked, setLocked] = useState(false);
      return (
        <>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setOpen(true);
              setLocked(true);
            }}
          >
            Opener
          </button>
          {open && (
            <BillingDialog title="Stuck" onClose={() => setOpen(false)}>
              <p>Body</p>
            </BillingDialog>
          )}
        </>
      );
    }
    render(<StuckOpener />);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    const focusSpy = jest.spyOn(opener, "focus");
    fireEvent.click(opener);
    // Close from the X while the opener stays disabled: the cleanup must skip
    // it rather than focus a disabled control.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("lets Escape close only the top-most dialog", () => {
    const outer = jest.fn();
    const inner = jest.fn();
    render(
      <>
        <BillingDialog title="Outer" onClose={outer}>
          <p>Outer body</p>
        </BillingDialog>
        <BillingDialog title="Inner" onClose={inner}>
          <p>Inner body</p>
        </BillingDialog>
      </>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
