/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { FileExplorer } from "../FileExplorer";
import { resolveExplorerHome } from "@/lib/explorer-home";

const INSTANCE_EXPLORER_HOME = resolveExplorerHome("inst_123");

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("remark-gfm", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("framer-motion", () => {
  const forwardProps = <T extends object>(props: T): T => {
    const cleanRest = { ...props } as T & Record<string, unknown>;
    delete cleanRest.initial;
    delete cleanRest.animate;
    delete cleanRest.exit;
    delete cleanRest.transition;
    delete cleanRest.variants;
    delete cleanRest.whileTap;
    return cleanRest;
  };

  const MockMotionDiv = React.forwardRef(
    (
      props: {
        children?: React.ReactNode;
        className?: string;
        style?: React.CSSProperties;
        layoutId?: string;
        [key: string]: unknown;
      },
      ref: React.Ref<HTMLDivElement>
    ) => {
      const { layoutId, ...rest } = props;
      void layoutId;
      return <div ref={ref} {...forwardProps(rest)} />;
    }
  );
  MockMotionDiv.displayName = "MotionDiv";

  return {
    motion: {
      div: MockMotionDiv,
    },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  };
});

describe("FileExplorer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (body.action === "list" && body.path === INSTANCE_EXPLORER_HOME) {
        return {
          json: async () => ({
            ok: true,
            files: [
              { name: "docs", type: "directory", size: 0, modifyTime: 1710000000 },
              { name: "README.md", type: "file", size: 128, modifyTime: 1710000000 },
              { name: "Manual.pdf", type: "file", size: 4096, modifyTime: 1710000000 },
              { name: "Preview.png", type: "file", size: 2048, modifyTime: 1710000000 },
            ],
          }),
        } as Response;
      }

      if (body.action === "read" && body.path === `${INSTANCE_EXPLORER_HOME}/README.md`) {
        return {
          json: async () => ({
            ok: true,
            content: "# Explorer Notes\n\nHello from Hermes.",
          }),
        } as Response;
      }

      if (
        body.action === "write" &&
        body.path === `${INSTANCE_EXPLORER_HOME}/README.md` &&
        typeof body.content === "string"
      ) {
        return {
          json: async () => ({ ok: true }),
        } as Response;
      }

      throw new Error(`Unhandled fetch in FileExplorer test: ${JSON.stringify(body)}`);
    }) as jest.Mock;
  });

  function getRequestBodies(action?: string) {
    return (global.fetch as jest.Mock).mock.calls
      .map(([, init]) => {
        const requestInit = init as RequestInit | undefined;
        return requestInit?.body ? JSON.parse(String(requestInit.body)) : null;
      })
      .filter((body) => (action ? body?.action === action : Boolean(body)));
  }

  function getWriteBodies() {
    return getRequestBodies("write");
  }

  function getListBodies() {
    return getRequestBodies("list");
  }

  it("shows a dossier on single click without opening the editor immediately", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("README.md"));

    expect(screen.getByLabelText("Explorer dossier")).toBeInTheDocument();
    expect(screen.getByText(`${INSTANCE_EXPLORER_HOME}/README.md`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open in editor/i })).toBeInTheDocument();
    expect(await screen.findByText(/Explorer Notes/)).toBeInTheDocument();
  });

  it("offers a download link for the selected file", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("README.md"));

    expect(await screen.findByText(/Explorer Notes/)).toBeInTheDocument();

    const downloadLink = screen.getByRole("link", { name: /download/i });
    expect(downloadLink).toHaveAttribute(
      "href",
      `/api/instances/inst_123/sftp?path=${encodeURIComponent(`${INSTANCE_EXPLORER_HOME}/README.md`)}&download=1`
    );
    expect(downloadLink).toHaveAttribute("download", "README.md");
    expect(downloadLink).toHaveClass("no-underline");
    expect(downloadLink).not.toHaveClass("border");
  });

  it("navigates into a folder on double click", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await waitFor(() => {
      expect(screen.getByText("docs")).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText("docs"));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/instances/inst_123/sftp",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "list", path: `${INSTANCE_EXPLORER_HOME}/docs` }),
        })
      );
    });
  });

  it("renders an inline PDF preview for selected PDF files", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await waitFor(() => {
      expect(screen.getByText("Manual.pdf")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Manual.pdf"));

    const frame = screen.getByTitle(/pdf preview/i);
    expect(frame).toHaveAttribute(
      "src",
      `/api/instances/inst_123/sftp?path=${encodeURIComponent(`${INSTANCE_EXPLORER_HOME}/Manual.pdf`)}`
    );
  });

  it("renders an inline image preview for selected raster image files", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await waitFor(() => {
      expect(screen.getByText("Preview.png")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Preview.png"));

    const image = screen.getByAltText("Preview.png preview");
    expect(image).toHaveAttribute(
      "src",
      `/api/instances/inst_123/sftp?path=${encodeURIComponent(`${INSTANCE_EXPLORER_HOME}/Preview.png`)}`
    );
  });

  it("starts in the host deploy directory for the current instance by default", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/instances/inst_123/sftp",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "list", path: INSTANCE_EXPLORER_HOME }),
        })
      );
    });
  });

  it("lets users move up to /opt without changing the instance folder home", async () => {
    global.fetch = jest.fn(async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (body.action === "list" && body.path === INSTANCE_EXPLORER_HOME) {
        return {
          json: async () => ({
            ok: true,
            files: [{ name: "docker-compose.yml", type: "file", size: 512, modifyTime: 1710000000 }],
          }),
        } as Response;
      }

      if (body.action === "list" && body.path === "/opt") {
        return {
          json: async () => ({
            ok: true,
            files: [{ name: "hermes", type: "directory", size: 0, modifyTime: 1710000000 }],
          }),
        } as Response;
      }

      throw new Error(`Unhandled fetch in FileExplorer test: ${JSON.stringify(body)}`);
    }) as jest.Mock;

    render(<FileExplorer instanceId="inst_123" />);

    const currentPath = await screen.findByLabelText("Current path");
    fireEvent.click(within(currentPath).getByRole("button", { name: "opt" }));

    await waitFor(() => {
      expect(getListBodies()).toContainEqual({ action: "list", path: "/opt" });
    });
    expect(await screen.findByText("hermes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /go to explorer home/i }));

    await waitFor(() => {
      expect(getListBodies()).toContainEqual({ action: "list", path: INSTANCE_EXPLORER_HOME });
    });
  });

  it("clamps an out-of-root default path before the first folder request", async () => {
    const explorerRoot = "/safe/root";

    global.fetch = jest.fn(async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (body.action === "list" && body.path === explorerRoot) {
        return {
          json: async () => ({
            ok: true,
            files: [{ name: "inside.txt", type: "file", size: 12, modifyTime: 1710000000 }],
          }),
        } as Response;
      }

      throw new Error(`Unhandled fetch in FileExplorer test: ${JSON.stringify(body)}`);
    }) as jest.Mock;

    render(<FileExplorer instanceId="inst_123" defaultPath="/outside/root" rootPath={explorerRoot} />);

    await waitFor(() => {
      expect(screen.getByText("inside.txt")).toBeInTheDocument();
    });

    expect(getListBodies()).toEqual([{ action: "list", path: explorerRoot }]);
  });

  it("normalizes trailing slashes for the initial folder request and breadcrumb labels", async () => {
    const explorerRoot = "/safe/root/";
    const initialPath = "/safe/root/docs/";

    global.fetch = jest.fn(async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (body.action === "list" && body.path === "/safe/root/docs") {
        return {
          json: async () => ({
            ok: true,
            files: [{ name: "guide.md", type: "file", size: 18, modifyTime: 1710000000 }],
          }),
        } as Response;
      }

      throw new Error(`Unhandled fetch in FileExplorer test: ${JSON.stringify(body)}`);
    }) as jest.Mock;

    render(<FileExplorer instanceId="inst_123" defaultPath={initialPath} rootPath={explorerRoot} />);

    await waitFor(() => {
      expect(screen.getByText("guide.md")).toBeInTheDocument();
    });

    expect(getListBodies()).toEqual([{ action: "list", path: "/safe/root/docs" }]);

    const currentPath = screen.getByLabelText("Current path");
    expect(within(currentPath).getByRole("button", { name: "root" })).toBeInTheDocument();
    expect(within(currentPath).getByRole("button", { name: "docs" })).toBeInTheDocument();
  });

  it("renders a dedicated dossier pane beside the browser content", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await waitFor(() => {
      expect(screen.getByText("README.md")).toBeInTheDocument();
    });

    const dossierPanel = screen.getByLabelText("Explorer dossier");
    expect(dossierPanel).toBeInTheDocument();
    expect(within(dossierPanel).getByText(/nothing selected yet/i)).toBeInTheDocument();
  });

  it("offers a retry action when the current directory fails to load", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({ ok: false, error: "SSH connection timed out" }),
      } as Response)
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          files: [
            { name: "README.md", type: "file", size: 128, modifyTime: 1710000000 },
          ],
        }),
      } as Response);

    render(<FileExplorer instanceId="inst_123" />);

    expect(await screen.findByText("SSH connection timed out")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry loading folder/i }));

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/instances/inst_123/sftp",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "list", path: INSTANCE_EXPLORER_HOME }),
      })
    );
  });

  it("keeps double-click text editing inline in the dossier instead of a full-screen overlay", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    const file = await screen.findByText("README.md");
    fireEvent.doubleClick(file);

    const dossierPanel = screen.getByLabelText(/explorer dossier/i);

    expect(within(dossierPanel).queryByText(/nothing selected yet/i)).not.toBeInTheDocument();
    expect(within(dossierPanel).queryByText(/pick a file or folder to inspect/i)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(within(dossierPanel).getByRole("textbox")).toBeInTheDocument();
    });

    expect(within(dossierPanel).getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("requires an explicit save control inside the dossier before persisting edits", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    const file = await screen.findByText("README.md");
    fireEvent.doubleClick(file);

    const dossierPanel = screen.getByLabelText(/explorer dossier/i);

    const editor = await within(dossierPanel).findByRole("textbox");
    fireEvent.change(editor, { target: { value: "# Explorer Notes\n\nEdited inline." } });

    expect(getWriteBodies()).toHaveLength(0);

    fireEvent.click(within(dossierPanel).getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(getWriteBodies()).toContainEqual({
        action: "write",
        path: `${INSTANCE_EXPLORER_HOME}/README.md`,
        content: "# Explorer Notes\n\nEdited inline.",
      });
    });
  });

  it("renders file tiles with roomier inner spacing around the icon and labels", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await screen.findByText("README.md");
    const card = screen.getByTestId("file-card-README.md");
    const iconFrame = screen.getByTestId("file-card-icon-frame-README.md");

    expect(card).toHaveStyle({
      padding: "22px",
      minHeight: "168px",
      gap: "18px",
    });
    expect(iconFrame).toHaveStyle({
      width: "56px",
      height: "56px",
      padding: "10px",
    });
  });

  it("gives the controls and current-folder header more breathing room", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await screen.findByText("README.md");

    expect(screen.getByTestId("explorer-header-controls")).toHaveStyle({
      paddingTop: "8px",
      paddingBottom: "6px",
    });
    expect(screen.getByTestId("explorer-view-toggle")).toHaveStyle({
      padding: "2px",
    });
    expect(screen.getByTestId("explorer-current-folder-bar")).toHaveStyle({
      paddingTop: "14px",
      paddingBottom: "14px",
      paddingLeft: "18px",
      paddingRight: "18px",
    });
    expect(screen.getByTestId("explorer-current-folder-copy")).toHaveStyle({
      paddingTop: "4px",
      paddingBottom: "4px",
      paddingLeft: "6px",
    });
    expect(screen.getByRole("button", { name: /grid view/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /list view/i })).toBeVisible();
    expect(screen.queryByText(/^view$/i)).not.toBeInTheDocument();
  });

  it("keeps the dossier and inline editor roomy enough to read and edit comfortably", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await screen.findByText("README.md");

    expect(screen.getByTestId("explorer-dossier-content")).toHaveStyle({
      paddingTop: "0px",
      paddingBottom: "24px",
      paddingLeft: "0px",
      paddingRight: "0px",
    });
    expect(screen.getByTestId("explorer-dossier-empty")).toHaveStyle({
      paddingTop: "12px",
      paddingBottom: "12px",
      paddingLeft: "0px",
      paddingRight: "0px",
      borderStyle: "none",
    });
    expect(screen.queryByText(/pick a file or folder to inspect its metadata and preview here/i)).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText("README.md"));

    const editorShell = await screen.findByTestId("file-editor-shell");
    expect(editorShell).toHaveStyle({
      minHeight: "620px",
    });

    const editor = await screen.findByRole("textbox");
    expect(editor).toHaveStyle({
      padding: "24px",
      lineHeight: "1.8",
    });
    expect(screen.queryByText(/preview, metadata, and actions for the current selection/i)).not.toBeInTheDocument();
  });

  it("shows actions first and keeps the preview-kind badge subtly boxed", async () => {
    render(<FileExplorer instanceId="inst_123" />);

    await screen.findByText("README.md");
    fireEvent.click(screen.getByText("README.md"));

    expect(await screen.findByText(/Explorer Notes/)).toBeInTheDocument();

    const actionsSection = screen.getByTestId("explorer-actions-section");
    const summarySection = screen.getByTestId("explorer-selection-summary");
    const previewSection = screen.getByTestId("explorer-preview-section");

    expect(actionsSection.compareDocumentPosition(summarySection)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(actionsSection.compareDocumentPosition(previewSection)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByTestId("explorer-selection-summary")).toHaveClass("space-y-4");
    expect(screen.getByTestId("explorer-metadata-grid")).toHaveClass("gap-4");

    const previewKind = screen.getByTestId("explorer-preview-kind");
    expect(previewKind).toHaveTextContent("Text");
    expect(previewKind).toHaveClass("border");
    expect(previewKind).toHaveClass("bg-[var(--bg-elevated)]");
  });
});
