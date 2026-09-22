/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import NewUpdatePage from "../page";

describe("NewUpdatePage", () => {
  it("announces venice multimodal agents without the old free-tier copy", () => {
    render(<NewUpdatePage />);

    expect(
      screen.getByRole("heading", { name: /venice multimodal agents live/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/one venice key\. persistent multimodal hermes agents/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/free tier/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/open now/i)).not.toBeInTheDocument();
    expect(screen.getByText("Venice · Multimodal")).toBeInTheDocument();
  });
});
