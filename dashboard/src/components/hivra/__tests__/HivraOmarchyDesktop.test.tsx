/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import { HivraOmarchyDesktop } from "../HivraOmarchyDesktop";

const mockRemoteDesktop = jest.fn();

jest.mock("@/components/hivra/HivraRemoteDesktop", () => ({
  HivraRemoteDesktop: (props: Record<string, unknown>) => {
    mockRemoteDesktop(props);
    return <div>browser stream</div>;
  },
}));
jest.mock("@/components/hivra/HivraConsoleDesktop", () => ({
  HivraConsoleDesktop: () => <div>native stream</div>,
}));

it("uses only the embedded browser desktop without Moonlight or console fallback", () => {
  render(<HivraOmarchyDesktop computerId="00000000-0000-4000-8000-000000002099" name="Omarchy" autoPrepare handoffWarmOrigin="https://omarchy.example.test" />);
  expect(screen.getByText("browser stream")).toBeTruthy();
  expect(screen.queryByText("native stream")).toBeNull();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByText(/moonlight/i)).toBeNull();
  expect(mockRemoteDesktop).toHaveBeenLastCalledWith({
    computerId: "00000000-0000-4000-8000-000000002099", name: "Omarchy", active: true,
    autoPrepare: true, handoffWarmOrigin: "https://omarchy.example.test",
  });
});

it("passes retained-tab visibility to the same browser consumer", () => {
  const view = render(<HivraOmarchyDesktop computerId="00000000-0000-4000-8000-000000002099" name="Omarchy" active={false} />);
  expect(mockRemoteDesktop).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
  view.rerender(<HivraOmarchyDesktop computerId="00000000-0000-4000-8000-000000002099" name="Omarchy" />);
  expect(mockRemoteDesktop).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
  expect(screen.queryByText("native stream")).toBeNull();
});
