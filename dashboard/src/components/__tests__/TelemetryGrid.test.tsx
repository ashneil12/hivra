/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { TelemetryGrid } from "../TelemetryGrid";

jest.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    isLoaded: true,
    user: {
      id: "user_123",
    },
  }),
}));

jest.mock("@/lib/client-storage", () => ({
  readStoredJson: jest.fn(() => null),
  writeStoredJsonIfChanged: jest.fn(),
}));

describe("TelemetryGrid", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(() =>
      Promise.resolve({
        headers: {
          get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
        },
        json: async () => ({
          success: true,
          data: {
            status: "running",
            uptime: "18 hours",
            cpu: "3.14%",
            memory: "293.2MiB / 7.75GiB",
            network: "5.92MB / 19.8MB",
          },
        }),
      } as Response),
    ) as jest.Mock;
  });

  it("renders telemetry labels and known status values in Chinese", async () => {
    render(
      <LocaleProvider initialLocale="zh-CN">
        <TelemetryGrid instanceId="inst-123" provider="openrouter" model="google/gemma-4-26b" />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("容器状态")).toBeInTheDocument();
    });

    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("运行时间：18 小时")).toBeInTheDocument();
    expect(screen.getByText("CPU 使用率")).toBeInTheDocument();
    expect(screen.getByText("主机计算节点")).toBeInTheDocument();
    expect(screen.getByText("内存分配")).toBeInTheDocument();
    expect(screen.getByText("限制：7.75GiB")).toBeInTheDocument();
    expect(screen.getByText("网络 I/O")).toBeInTheDocument();
    expect(screen.getByText("总发送：19.8MB")).toBeInTheDocument();
    expect(screen.getByText("当前模型")).toBeInTheDocument();
    expect(screen.getByText("提供商")).toBeInTheDocument();
    expect(screen.getByText("LLM 推理引擎")).toBeInTheDocument();
    expect(screen.queryByText("Container State")).not.toBeInTheDocument();
  });
});
