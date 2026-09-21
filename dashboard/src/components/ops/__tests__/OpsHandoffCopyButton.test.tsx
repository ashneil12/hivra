/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { OpsHandoffCopyButton } from "../OpsHandoffCopyButton";

describe("OpsHandoffCopyButton", () => {
  let writeTextMock: jest.Mock<Promise<void>, [string]>;

  beforeEach(() => {
    jest.useFakeTimers();
    writeTextMock = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("does not leave a copied timer behind when the clipboard promise resolves after unmount", async () => {
    let resolveWriteText: (() => void) | null = null;
    const setTimeoutSpy = jest.spyOn(window, "setTimeout");
    writeTextMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWriteText = resolve;
        })
    );

    const { unmount } = render(<OpsHandoffCopyButton text="handoff text" />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /copy for agent/i }));
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("handoff text");

    unmount();

    await act(async () => {
      resolveWriteText?.();
      await Promise.resolve();
    });

    expect(
      setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 1500)
    ).toHaveLength(0);
  });
});
