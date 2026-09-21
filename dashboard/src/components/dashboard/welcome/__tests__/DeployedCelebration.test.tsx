/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { DeployedCelebration } from "@/components/dashboard/welcome/DeployedCelebration";

// No instanceId → the readiness poll is skipped, so this renders the booting
// beat synchronously with no network.
describe("DeployedCelebration persona emoji", () => {
  it("shows the persona emoji beside the name", () => {
    render(<DeployedCelebration agentName="Pike" emoji="🛠️" onContinue={() => {}} />);
    expect(screen.getByText("🛠️ Pike")).toBeInTheDocument();
  });

  it("falls back to just the name when no emoji is set", () => {
    render(<DeployedCelebration agentName="Pike" onContinue={() => {}} />);
    expect(screen.getByText("Pike")).toBeInTheDocument();
  });
});
