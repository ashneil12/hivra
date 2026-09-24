/** @jest-environment jsdom */
// INF-17: setup opened from the connection wizard carries the wizard's
// progress bar on. The two must name the same steps, or the handoff would
// show a different journey than the one the owner started.

import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

import { HOST_SETUP_STEPS, HostSetupProgress } from "../HostSetupProgress";
import { InfrastructureConnectionWizard } from "../InfrastructureConnectionWizard";

const stepNames = () => within(screen.getByRole("list", { name: "Host setup progress" }))
  .getAllByRole("listitem")
  .map((step) => step.getAttribute("aria-label")?.replace(/, (current|complete)$/, ""));

it("names the same steps as the connection wizard's progress bar", () => {
  const { unmount } = render(
    <InfrastructureConnectionWizard onClose={jest.fn()} onConnectionSaved={jest.fn()} onPreflightComplete={jest.fn()} />,
  );
  const wizardSteps = stepNames();
  unmount();

  render(<HostSetupProgress current="Prepare" />);
  expect(stepNames()).toEqual(wizardSteps);
  expect(wizardSteps).toEqual([...HOST_SETUP_STEPS]);
});
