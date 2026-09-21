/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { HivraLogin } from "../HivraLogin";

it("accurately explains native credential storage without claiming zero operator access", () => {
  render(<HivraLogin boxUrl="https://box.test" onDone={jest.fn()} agentKind="codex" />);
  expect(screen.getByText(/session is stored on this computer/)).toHaveTextContent("Administrators of its host may have infrastructure access");
  expect(screen.queryByText(/never sees your credentials/)).not.toBeInTheDocument();
});
