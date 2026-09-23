/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { log } from "@/lib/logger";

import ConvertPage from "../page";

jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn() } }));
jest.mock("@/lib/claim/hivra-launch-config", () => ({
  ...jest.requireActual("@/lib/claim/hivra-launch-config"),
  HIVRA_LAUNCH_CONFIG: {
    hivraTokenAddress: "0x1111111111111111111111111111111111111111",
    termsUrl: "https://hivra.cloud/terms",
    conversionUrl: "https://bankr-lookalike.example/convert",
  },
}));

describe("/dashboard/convert with a rejected launch value", () => {
  it("keeps conversion closed and logs why", () => {
    render(<ConvertPage />);

    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
    expect(jest.mocked(log.warn)).toHaveBeenCalledWith("HIVRA launch config rejected", {
      source: "dashboard/convert",
      problems: "conversionUrl must be https on an allowed host",
    });
  });
});
