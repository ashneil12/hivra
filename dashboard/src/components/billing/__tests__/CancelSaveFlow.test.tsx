/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import posthog from "posthog-js";

import { CancelSaveFlow } from "../CancelSaveFlow";

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: jest.fn(),
  },
}));

describe("CancelSaveFlow", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  function renderFlow(overrides: Partial<Parameters<typeof CancelSaveFlow>[0]> = {}) {
    const onClose = jest.fn();
    const onCancelAnyway = jest.fn();
    render(
      <CancelSaveFlow
        plan="operator"
        onClose={onClose}
        onCancelAnyway={onCancelAnyway}
        {...overrides}
      />
    );
    return { onClose, onCancelAnyway };
  }

  it("asks the one question with all five reasons and no offer until one is picked", () => {
    renderFlow();
    expect(screen.getByRole("dialog", { name: /before you cancel/i })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /what.s making you cancel\?/i })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.queryByTestId("save-offer")).not.toBeInTheDocument();
  });

  it.each([
    ["It's too expensive", /switch to yearly — \$79\/yr/i, /\?cadence=yearly&from=cancel_save$/],
    ["I'm not using it", /email us about pausing/i, /^mailto:info@hermesos\.cloud/],
    ["It's missing a feature I need", /email the founder/i, /^mailto:info@hermesos\.cloud/],
    ["Something broke", /email the founder/i, /^mailto:info@hermesos\.cloud/],
    ["Something else", /email the founder/i, /^mailto:info@hermesos\.cloud/],
  ])("shows ONE matched save offer for %s", (reasonLabel, ctaName, hrefPattern) => {
    renderFlow();
    fireEvent.click(screen.getByLabelText(reasonLabel));

    const offers = screen.getAllByTestId("save-offer");
    expect(offers).toHaveLength(1);
    const cta = screen.getByRole("link", { name: ctaName });
    expect(cta.getAttribute("href")).toMatch(hrefPattern);
    // Cancel anyway never disappears.
    expect(screen.getByRole("button", { name: /cancel anyway/i })).toBeInTheDocument();
  });

  it("states the ~34% yearly saving for too-expensive", () => {
    renderFlow();
    fireEvent.click(screen.getByLabelText(/too expensive/i));
    expect(screen.getByTestId("save-offer")).toHaveTextContent(/34% off/i);
    expect(screen.getByTestId("save-offer")).toHaveTextContent(/\$79\/yr/);
  });

  it("shows a free-text field only for 'Something else'", () => {
    renderFlow();
    expect(screen.queryByLabelText(/tell us more/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/something else/i));
    expect(screen.getByLabelText(/tell us more/i)).toBeInTheDocument();
  });

  it("cancel-anyway proceeds with the original flow and submits the survey once answered", () => {
    const { onCancelAnyway } = renderFlow();
    fireEvent.click(screen.getByLabelText(/too expensive/i));
    fireEvent.click(screen.getByRole("button", { name: /cancel anyway/i }));

    expect(onCancelAnyway).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("churn_survey_submitted", {
      reason: "too_expensive",
      plan: "operator",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/billing/churn-survey",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "too_expensive" }),
      })
    );
  });

  it("includes the free-text detail in the survey payload", () => {
    renderFlow();
    fireEvent.click(screen.getByLabelText(/something else/i));
    fireEvent.change(screen.getByLabelText(/tell us more/i), {
      target: { value: "  moving off cloud  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /cancel anyway/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/billing/churn-survey",
      expect.objectContaining({
        body: JSON.stringify({ reason: "other", detail: "moving off cloud" }),
      })
    );
  });

  it("never traps: cancel-anyway works with NO reason selected (no survey sent)", () => {
    const { onCancelAnyway } = renderFlow();
    fireEvent.click(screen.getByRole("button", { name: /cancel anyway/i }));

    expect(onCancelAnyway).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("accepting an offer submits the survey too, and only once", () => {
    renderFlow();
    fireEvent.click(screen.getByLabelText(/too expensive/i));
    const cta = screen.getByRole("link", { name: /switch to yearly/i });
    // jsdom doesn't navigate; just exercise the click handler.
    fireEvent.click(cta);
    fireEvent.click(screen.getByRole("button", { name: /cancel anyway/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("churn_save_offer_clicked", {
      reason: "too_expensive",
      plan: "operator",
    });
  });

  it("offers quiet dismissal via X, 'keep my plan' and the backdrop", () => {
    const { onClose, onCancelAnyway } = renderFlow();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep my plan/i }));
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onCancelAnyway).not.toHaveBeenCalled();
  });
});
