/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React, { Suspense } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

import SharedTemplatePage from "../page";

const pushMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

jest.mock("@/components/layout/DashboardPageShell", () => ({
  DashboardPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("SharedTemplatePage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          template: {
            id: "11111111-1111-4111-8111-111111111111",
            slug: "research-bot",
            type: "claude-code",
            name: "Research Bot",
            goal: "research",
            personality: null,
            emoji: null,
          },
        },
      }),
    })) as unknown as typeof fetch;
  });

  it("passes the share token so the welcome flow can show a template the viewer does not own", async () => {
    const params = Promise.resolve({ token: "abc123" });
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <SharedTemplatePage params={params} />
        </Suspense>,
      );
    });

    fireEvent.click(await screen.findByRole("button", { name: /use this template/i }));

    expect(pushMock).toHaveBeenCalledWith(
      "/dashboard/launch?start=1&template=11111111-1111-4111-8111-111111111111&templateToken=abc123",
    );
  });
});
