/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { ChangePlanModal, describeResourceLoss, describeSlotOverage } from "../ChangePlanModal";

function renderModal(overrides: Partial<Parameters<typeof ChangePlanModal>[0]> = {}) {
  const onClose = jest.fn();
  const onConfirm = jest.fn();
  const utils = render(
    <ChangePlanModal
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      planName="Power"
      priceInCents={1999}
      loading={false}
      {...overrides}
    />
  );
  return { ...utils, onClose, onConfirm };
}

describe("ChangePlanModal", () => {
  it("renders nothing while closed", () => {
    renderModal({ isOpen: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the in-place upgrade copy and actions", () => {
    const { onClose, onConfirm } = renderModal();
    const dialog = screen.getByRole("dialog", { name: "Confirm Upgrade" });

    expect(within(dialog).getByText("You are about to upgrade your subscription plan.")).toBeInTheDocument();
    expect(within(dialog).getByText("New Plan Selected")).toBeInTheDocument();
    expect(within(dialog).getByText("$19.99")).toBeInTheDocument();
    // change-plan uses create_prorations: the difference lands on the next
    // invoice, so the dialog must not promise a charge today.
    expect(
      within(dialog).getByText(
        "Your new plan's limits apply right away. The price difference for the rest of this billing period is added to your next invoice."
      )
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/charged .* today/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText("/mo")).toBeInTheDocument();
    expect(within(dialog).queryByText(/what you give up/i)).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm Upgrade" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the checkout copy", () => {
    renderModal({ mode: "checkout" });
    const dialog = screen.getByRole("dialog", { name: "Open Secure Checkout" });
    expect(within(dialog).getByText("This plan has to be changed through Stripe Checkout.")).toBeInTheDocument();
    expect(within(dialog).getByText(/current access stays active while checkout is pending/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Open Checkout" })).toBeInTheDocument();
    expect(within(dialog).getByText("/mo")).toBeInTheDocument();
  });

  it("states a yearly checkout's price per year, not per month", () => {
    renderModal({ mode: "checkout", planName: "Pro", priceInCents: 7900, priceUnit: "/yr" });
    const dialog = screen.getByRole("dialog", { name: "Open Secure Checkout" });
    expect(within(dialog).getByText("$79.00")).toBeInTheDocument();
    expect(within(dialog).getByText("/yr")).toBeInTheDocument();
    expect(within(dialog).queryByText("/mo")).not.toBeInTheDocument();
  });

  it("never shows a yearly unit on an in-place change, which always bills monthly", () => {
    renderModal({ priceUnit: "/yr" });
    const dialog = screen.getByRole("dialog", { name: "Confirm Upgrade" });
    expect(within(dialog).getByText("/mo")).toBeInTheDocument();
    expect(within(dialog).queryByText("/yr")).not.toBeInTheDocument();
  });

  it("spells out what a downgrade removes and how the proration credit works", () => {
    const { onConfirm, onClose } = renderModal({
      direction: "downgrade",
      planName: "Pro",
      priceInCents: 999,
      currentPlanName: "Power",
      resourceDiff: { agents: 2, cpu: 2, ramGb: 4 },
    });
    const dialog = screen.getByRole("dialog", { name: "Switch to Pro" });

    expect(within(dialog).getByText(/moving from Power to Pro/)).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: /what you give up/i })).toBeInTheDocument();
    const losses = within(dialog).getAllByRole("listitem").map((item) => item.textContent);
    expect(losses).toEqual(["2 fewer agent and computer slots", "2 fewer vCPU", "4 GB less memory"]);
    expect(within(dialog).getByText(/credits the unused time on Power to your account/)).toBeInTheDocument();
    expect(within(dialog).getByText(/comes off your next invoices; it isn't refunded to your card/)).toBeInTheDocument();
    expect(within(dialog).getByText("$9.99")).toBeInTheDocument();
    // The route caps agents but never stops, removes or re-splits them.
    expect(within(dialog).queryByText(/resized to fit/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing is stopped or re-split for you/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Each agent is capped at Pro's per-agent size/)).toBeInTheDocument();
    // Upgrade wording must not leak into a downgrade.
    expect(within(dialog).queryByText(/charged a prorated amount/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Confirm Upgrade" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Switch to Pro" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep Power" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reads the resource difference by size, whatever its sign", () => {
    expect(describeResourceLoss({ agents: -2, cpu: -2, ramGb: -4 })).toEqual([
      "2 fewer agent and computer slots",
      "2 fewer vCPU",
      "4 GB less memory",
    ]);
    expect(describeResourceLoss({ agents: 1, cpu: 1.5, ramGb: 0 })).toEqual([
      "1 fewer agent and computer slot",
      "1.5 fewer vCPU",
    ]);
    expect(describeResourceLoss({ agents: Number.POSITIVE_INFINITY, cpu: Number.NaN, ramGb: 3 })).toEqual([
      "3 GB less memory",
    ]);
    expect(describeResourceLoss(undefined)).toEqual([]);
  });

  it("names how many agents are over the smaller plan's slots when that is known", () => {
    renderModal({
      direction: "downgrade",
      planName: "Pro",
      priceInCents: 999,
      currentPlanName: "Power",
      agentsInUse: 5,
      targetAgentSlots: 3,
    });
    expect(screen.getByTestId("change-plan-slot-overage")).toHaveTextContent(
      "You have 5 agents and computers; Pro has 3 slots. Remove 2 before you launch another."
    );
  });

  it("says nothing about slots when the account fits or the counts are unknown", () => {
    expect(describeSlotOverage("Pro", 3, 3)).toBeNull();
    expect(describeSlotOverage("Pro", 2, 3)).toBeNull();
    expect(describeSlotOverage("Pro", undefined, 3)).toBeNull();
    expect(describeSlotOverage("Pro", 5, Number.NaN)).toBeNull();
    expect(describeSlotOverage("Free", 2, 1)).toBe(
      "You have 2 agents and computers; Free has 1 slot. Remove 1 before you launch another."
    );
    renderModal({ direction: "downgrade", planName: "Pro", priceInCents: 999, agentsInUse: 2, targetAgentSlots: 3 });
    expect(screen.queryByTestId("change-plan-slot-overage")).not.toBeInTheDocument();
  });

  it("still warns about smaller limits when the resource difference is unknown", () => {
    renderModal({ direction: "downgrade", planName: "Pro", priceInCents: 999 });
    const dialog = screen.getByRole("dialog", { name: "Switch to Pro" });
    expect(within(dialog).getByText(/Pro's smaller limits on agents, vCPU and memory apply right away/)).toBeInTheDocument();
    expect(within(dialog).getByText(/credits the unused time on your current plan/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Keep current plan" })).toBeInTheDocument();
  });

  it("uses the checkout copy when a downgrade has to go through checkout", () => {
    renderModal({ direction: "downgrade", mode: "checkout", currentPlanName: "Power" });
    expect(screen.getByRole("dialog", { name: "Open Secure Checkout" })).toBeInTheDocument();
  });

  it("has a 44px 'Close' button, and locks every exit while the change is in flight", () => {
    const { onClose, rerender, onConfirm } = renderModal();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();

    rerender(
      <ChangePlanModal
        isOpen
        onClose={onClose}
        onConfirm={onConfirm}
        planName="Power"
        priceInCents={1999}
        loading
      />
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /processing/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("presentation"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the backdrop and Escape when idle, and renders in a body portal", () => {
    const { onClose, container } = renderModal();
    expect(container).not.toContainElement(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("presentation"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
