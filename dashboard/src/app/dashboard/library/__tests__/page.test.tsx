/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import LibraryPage from "../page";
import { copyTextToClipboard } from "@/lib/client/clipboard";

const pushMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

jest.mock("@/components/layout/DashboardPageShell", () => ({
  DashboardPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("@/lib/client/clipboard", () => ({
  copyTextToClipboard: jest.fn(),
}));

describe("LibraryPage", () => {
  const mockedCopyTextToClipboard = copyTextToClipboard as jest.MockedFunction<
    typeof copyTextToClipboard
  >;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockedCopyTextToClipboard.mockResolvedValue(true);

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: "tmpl-1",
            name: "Closer",
            description: "Sales agent",
            category: "Marketing",
            prompt: "Close the deal",
            isFeatured: false,
          },
        ],
      }),
    })) as jest.Mock;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("keeps the preview copy button unchanged when copying the prompt fails", async () => {
    mockedCopyTextToClipboard.mockResolvedValue(false);

    render(<LibraryPage />);

    const viewButton = await screen.findByRole("button", { name: /view prompt/i });
    fireEvent.click(viewButton);

    const copyButton = await screen.findByRole("button", { name: /copy prompt/i });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(mockedCopyTextToClipboard).toHaveBeenCalledWith("Close the deal");
    });

    expect(screen.getByRole("button", { name: /copy prompt/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copied!/i })).not.toBeInTheDocument();
  });

  it("opens the preview as a modal dialog that locks page scroll and closes on Escape", async () => {
    render(
      <main>
        <LibraryPage />
      </main>
    );

    fireEvent.click(await screen.findByRole("button", { name: /view prompt/i }));

    const dialog = await screen.findByRole("dialog", { name: "Closer" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = screen.getByRole("button", { name: /close prompt preview/i });
    expect(close).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.querySelector("main")?.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(document.querySelector("main")?.style.overflow).toBe("");
  });

  it("keeps Tab inside the preview and returns focus to the eye button on close", async () => {
    render(
      <main>
        <LibraryPage />
      </main>
    );

    const viewButton = await screen.findByRole("button", { name: /view prompt/i });
    viewButton.focus();
    fireEvent.click(viewButton);

    const close = await screen.findByRole("button", { name: /close prompt preview/i });
    const deploy = screen.getByRole("button", { name: /deploy this template/i });
    expect(close).toHaveFocus();

    deploy.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(deploy).toHaveFocus();

    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(viewButton).toHaveFocus();
  });

  it("gives the template search a search keyboard", async () => {
    render(<LibraryPage />);
    await screen.findByRole("button", { name: /view prompt/i });

    const search = screen.getByRole("searchbox");
    expect(search).toHaveAttribute("enterkeyhint", "search");
    expect(search).toHaveAttribute("autocapitalize", "none");
  });

  it("renders the prompt library interface in Chinese when the locale is Chinese", async () => {
    render(
      <LocaleProvider initialLocale="zh-CN">
        <LibraryPage />
      </LocaleProvider>
    );

    expect(await screen.findByRole("heading", { level: 2 })).toHaveTextContent("提示词库。");
    expect(screen.getByRole("button", { name: "返回控制中心" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("按名称或描述搜索模板...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "营销" })).toBeInTheDocument();
    expect(screen.getByText("所有模板")).toBeInTheDocument();
    expect(screen.queryByText(/Prompt Library/i)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "查看提示词" }));

    expect(await screen.findByRole("button", { name: "复制提示词" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "部署此模板" })).toBeInTheDocument();
  });

  it("renders the prompt library interface in Spanish when that locale is selected", async () => {
    render(
      <LocaleProvider initialLocale="es">
        <LibraryPage />
      </LocaleProvider>
    );

    expect(await screen.findByRole("heading", { level: 2 })).toHaveTextContent("Biblioteca de prompts.");
    expect(screen.getByRole("button", { name: "Volver al centro de comando" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Buscar plantillas por nombre o descripción...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Todo" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Marketing" })).toBeInTheDocument();
    expect(screen.getByText("Todas las plantillas")).toBeInTheDocument();
    expect(screen.queryByText(/Prompt Library/i)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Ver prompt" }));

    expect(await screen.findByRole("button", { name: "Copiar prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desplegar esta plantilla" })).toBeInTheDocument();
  });

  it("clears the preview copy reset timer when the page unmounts early", async () => {
    const setTimeoutSpy = jest.spyOn(window, "setTimeout");
    const clearTimeoutSpy = jest.spyOn(window, "clearTimeout");

    const { unmount } = render(<LibraryPage />);

    const viewButton = await screen.findByRole("button", { name: /view prompt/i });
    fireEvent.click(viewButton);

    const copyButton = await screen.findByRole("button", { name: /copy prompt/i });

    await act(async () => {
      fireEvent.click(copyButton);
    });

    const copyTimeoutCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2000);
    expect(copyTimeoutCallIndex).toBeGreaterThanOrEqual(0);
    const copyTimeoutId = setTimeoutSpy.mock.results[copyTimeoutCallIndex]?.value;

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(copyTimeoutId);
  });
});
