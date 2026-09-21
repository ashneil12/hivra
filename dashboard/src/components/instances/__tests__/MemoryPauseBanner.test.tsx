/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryPauseBanner } from "@/components/instances/MemoryPauseBanner";

const props = { status: "stopped", pausedReason: "ram_cap_hit", ramLimitMb: 2048, actionLoading: false, onRestart: jest.fn(), onReviewResources: jest.fn() };

beforeEach(() => jest.clearAllMocks());

it("shows the real cap and invokes only the action the user chooses", () => {
  render(<MemoryPauseBanner {...props} />);
  expect(screen.getByText("Paused for high memory use")).toBeInTheDocument();
  expect(screen.getByTestId("instance-ram-cap-banner")).toHaveTextContent("2 GB memory allocation");
  expect(props.onRestart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review resources" }));
  expect(props.onReviewResources).toHaveBeenCalledTimes(1);
  expect(props.onRestart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Restart anyway" }));
  expect(props.onRestart).toHaveBeenCalledTimes(1);
});

it.each([["running", "ram_cap_hit"], ["stopped", "inactivity"], ["stopped", null]])("hides for unrelated state %s/%s", (status, pausedReason) => {
  render(<MemoryPauseBanner {...props} status={status!} pausedReason={pausedReason} />);
  expect(screen.queryByTestId("instance-ram-cap-banner")).not.toBeInTheDocument();
});

it("blocks duplicate starts while an action is pending", () => {
  render(<MemoryPauseBanner {...props} actionLoading />);
  fireEvent.click(screen.getByRole("button", { name: "Restarting…" }));
  expect(props.onRestart).not.toHaveBeenCalled();
});

it("does not invent a 1 GB cap when allocation is absent", () => {
  render(<MemoryPauseBanner {...props} ramLimitMb={null} />);
  expect(screen.getByTestId("instance-ram-cap-banner")).not.toHaveTextContent("1 GB");
});
