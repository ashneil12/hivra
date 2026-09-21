/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { copyTextToClipboard } from "../clipboard";

describe("copyTextToClipboard", () => {
  const originalClipboard = navigator.clipboard;
  const execCommand = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: jest.fn(),
      },
    });

    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
  });

  afterAll(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  it("uses the async clipboard API when available", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyTextToClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the clipboard API rejects", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("blocked"));
    execCommand.mockReturnValue(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyTextToClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("does not throw if fallback cleanup runs after another script already removed the textarea", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("blocked"));
    execCommand.mockImplementation(() => {
      document.querySelector("textarea")?.remove();
      return true;
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyTextToClipboard("hello")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns false when neither clipboard copy path succeeds", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("blocked"));
    execCommand.mockReturnValue(false);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyTextToClipboard("hello")).resolves.toBe(false);
  });
});
